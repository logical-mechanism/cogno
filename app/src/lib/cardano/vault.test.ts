// The vault lock/exit guards. Everything here is about ONE class of bug: treating "we could not read
// the vault" as "there is no vault", and then offering to lock 100 more real ADA on the strength of it.
//
// A second lock is pure loss of use. The observer credits largest-wins and never sums, so the extra
// 100 ADA earns nothing, and every screen in the app reads a single vault UTxO so it is invisible.
// The guard therefore lives in lockIntoVault itself, not in the UI: /welcome gated its Lock button on
// posting power plus a device-local record with no vault read behind it, while Settings gated
// correctly — which is exactly why a caller-side guard is not enough.
//
// The second class this now covers is MULTI-SCRIPT. `blueprint.ts` used to export one hash and one
// applied CBOR as scalars, so the bundle could compute exactly one vault address; a redeploy would
// have stranded every existing UTxO with no in-app way to reach it. The script list makes a retired
// vault readable and spendable, and these tests pin the two things that must not blur: a legacy
// balance is never posting power, and a legacy exit must attach the LEGACY script rather than the
// current one (a spend witness from the wrong script is an invalid transaction).
//
// MeshJS is browser-only, so the surfaces vault.ts dynamically imports are mocked. The provider is
// mocked at the module seam so a read failure can be simulated exactly, PER ADDRESS — the two scripts
// live at different addresses, and a mock that answered identically for both would make a
// multi-address read look like it worked when it had only ever queried one.

import { describe, it, expect, beforeEach, vi } from "vitest";

type FakeUtxo = {
  input: { txHash: string; outputIndex: number };
  output: { amount: Array<{ unit: string; quantity: string }> };
};

/**
 * The two scripts the mocked list exposes. Distinct CBOR so the attached spend witness is assertable.
 *
 * `vi.hoisted` because `vi.mock` factories are hoisted above every top-level binding: a plain `const`
 * here is still in its temporal dead zone when the ./vaults factory runs, and the whole suite fails to
 * import with "Cannot access before initialization".
 */
const { CURRENT_SCRIPT, LEGACY_SCRIPT } = vi.hoisted(() => ({
  CURRENT_SCRIPT: { hash: "dd".repeat(28), appliedCbor: "5901", minLock: 100_000_000n, label: "Current vault" },
  LEGACY_SCRIPT: { hash: "9a".repeat(28), appliedCbor: "5902", minLock: 100_000_000n, label: "Older vault" },
}));

const fake = {
  networkId: 0 as number,
  paymentType: 0 as number,
  /** what the provider returns for the CURRENT vault address; a throw simulates a rate-limited read. */
  vaultUtxos: [] as FakeUtxo[],
  /** what it returns for the LEGACY vault address (a different address entirely). */
  legacyUtxos: [] as FakeUtxo[],
  vaultReadThrows: false,
  /** only the legacy address fails — the case where one script's outage must not poison the other. */
  legacyReadThrows: false,
  /**
   * What the EMPTY-branch probe answers. MeshJS's `fetchAddressUTxOs` swallows every provider error and
   * returns `[]`, so an empty list is ambiguous and vault.ts re-asks with a status-bearing fetch. 404 is
   * the honest "no vault" (Blockfrost 404s an address it has never seen — the pre-lock state of every
   * new user); 429 and friends mean "could not read".
   */
  probeStatus: 404 as number,
  /** which script's CBOR the builder was handed for the spend witness / the burn policy. */
  spentScript: null as string | null,
  burnedPolicy: null as string | null,
  walletUtxos: [{ output: { amount: [{ unit: "lovelace", quantity: "500000000" }] } }],
  signed: 0,
  submitted: 0,
  /** the vault input an exit actually spent (from the builder's txIn), so the pick can be asserted. */
  spentIndex: null as number | null,
};

vi.mock("@meshsdk/core", () => ({
  BrowserWallet: {
    enable: vi.fn(async () => ({
      getNetworkId: async () => fake.networkId,
      getChangeAddress: async () => "addr_test_owner",
      getUtxos: async () => fake.walletUtxos,
      getCollateral: async () => [
        {
          input: { txHash: "cc".repeat(32), outputIndex: 0 },
          output: { amount: [{ unit: "lovelace", quantity: "5000000" }], address: "addr_test_owner" },
        },
      ],
      signTx: async (hex: string) => {
        fake.signed += 1;
        return hex;
      },
      submitTx: async () => {
        fake.submitted += 1;
        return "ab".repeat(32);
      },
    })),
  },
  // The address is a FUNCTION OF THE SCRIPT, as it is in reality (the script hash is its payment
  // credential). A fixed string here would have let a "read every script" path pass while only ever
  // querying one address.
  serializePlutusScript: (script: { code: string }) => ({ address: `addr_test_vault_${script.code}` }),
  MeshTxBuilder: class {
    txHex = "84a0";
    mintPlutusScriptV3() { return this; }
    mint(_qty: string, policy: string) {
      fake.burnedPolicy = policy;
      return this;
    }
    mintingScript() { return this; }
    mintRedeemerValue() { return this; }
    txOut() { return this; }
    txOutInlineDatumValue() { return this; }
    txInCollateral() { return this; }
    requiredSignerHash() { return this; }
    changeAddress() { return this; }
    selectUtxosFrom() { return this; }
    spendingPlutusScriptV3() { return this; }
    txIn(_txHash: string, outputIndex: number) {
      fake.spentIndex = outputIndex;
      return this;
    }
    txInScript(cbor: string) {
      fake.spentScript = cbor;
      return this;
    }
    txInInlineDatumPresent() { return this; }
    txInRedeemerValue() { return this; }
    async complete() { return this; }
  },
}));

vi.mock("@meshsdk/core-cst", () => ({
  Address: {
    fromBech32: () => ({
      getProps: () => ({
        paymentPart: { type: fake.paymentType, hash: "aa".repeat(28) },
        delegationPart: { hash: "bb".repeat(28) },
      }),
    }),
  },
}));

// The empty-branch probe reads the project id straight from config (every readVault caller builds its
// provider with a bare getProvider(), so it is by construction the same id). In a node test there is no
// configured id, and without one the probe short-circuits to "unknown" — which would make every
// genuinely-empty case in this file read as unreadable. Override just that one export.
vi.mock("@/lib/config/endpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/endpoints")>()),
  getBlockfrostProjectId: () => "preprodtestprojectid",
}));

vi.mock("./provider", () => ({
  getProvider: async () => ({
    fetchAddressUTxOs: async (address: string) => {
      if (address === `addr_test_vault_${LEGACY_SCRIPT.appliedCbor}`) {
        if (fake.legacyReadThrows) throw new Error("Blockfrost 429");
        return fake.legacyUtxos;
      }
      if (fake.vaultReadThrows) throw new Error("Blockfrost 429");
      return fake.vaultUtxos;
    },
  }),
}));

vi.mock("./blueprint", () => ({
  MIN_LOCK: 100_000_000n,
  assertBlueprintIntegrity: async () => {},
}));

// One retired script, so the multi-script paths are exercised. The SHIPPED list is empty (talk_vault
// has been deployed once), which is exactly why it has to be mocked to be tested at all: a mechanism
// whose only test is "the empty case does nothing" is a mechanism nobody has run.
vi.mock("./vaults", () => ({
  VAULT_SCRIPTS: [CURRENT_SCRIPT, LEGACY_SCRIPT],
  currentVaultScript: () => CURRENT_SCRIPT,
  legacyVaultScripts: () => [LEGACY_SCRIPT],
  vaultScriptByHash: (h: string) =>
    [CURRENT_SCRIPT, LEGACY_SCRIPT].find((s) => s.hash === h.toLowerCase().replace(/^0x/, "")),
}));

import { lockIntoVault, exitVault, fetchVaultState, fetchLegacyVaults } from "./vault";
import { seedCardanoNetwork } from "./network.fixture";

const utxo = (lovelace: string, outputIndex = 0) => ({
  input: { txHash: "ee".repeat(32), outputIndex },
  output: { amount: [{ unit: "lovelace", quantity: lovelace }], address: "addr_test_vault" },
});

beforeEach(async () => {
  fake.networkId = 0;
  fake.paymentType = 0;
  fake.vaultUtxos = [];
  fake.legacyUtxos = [];
  fake.vaultReadThrows = false;
  fake.legacyReadThrows = false;
  fake.probeStatus = 404;
  fake.signed = 0;
  fake.submitted = 0;
  fake.spentIndex = null;
  fake.spentScript = null;
  fake.burnedPolicy = null;
  await seedCardanoNetwork(0);
  // The empty-branch probe. Default 404 = "this address has no history", i.e. genuinely no vault, which
  // is what every pre-existing case in this file means by an empty `vaultUtxos`.
  vi.stubGlobal("fetch", async () =>
    fake.probeStatus === 404
      ? new Response(null, { status: 404 })
      : fake.probeStatus === 200
        ? new Response("[]", { status: 200 })
        : new Response("rate limited", { status: fake.probeStatus }),
  );
});

describe("fetchVaultState — unreadable is not empty", () => {
  it("reports known:false on a provider failure, NOT an empty vault", async () => {
    fake.vaultReadThrows = true;
    const s = await fetchVaultState("eternl");
    expect(s.known).toBe(false);
    // The old shape returned `locked: null` here, which every caller read as "no vault yet" and
    // rendered a live Lock button in front of someone who already had 100 ADA locked.
    expect(s.locked).toBeNull();
  });

  it("distinguishes a genuinely empty vault (known:true, locked:null)", async () => {
    const s = await fetchVaultState("eternl");
    expect(s.known).toBe(true);
    expect(s.locked).toBeNull();
    expect(s.extraVaults).toBe(0);
  });

  it("reports the LARGEST UTxO, matching what the observer credits", async () => {
    // largest-wins, never summed (cogno-dbsync reduction) — reporting the sum would overstate weight.
    fake.vaultUtxos = [utxo("100000000"), utxo("250000000")];
    const s = await fetchVaultState("eternl");
    expect(s.locked).toBe(250_000_000n);
    expect(s.extraVaults).toBe(1); // a second vault UTxO that earns nothing
  });
});

describe("an EMPTY provider list is ambiguous — the probe decides what it meant", () => {
  // MeshJS's BlockfrostProvider.fetchAddressUTxOs ends `catch (error) { return []; }` — it is the one
  // method in that class that swallows instead of rethrowing. So the `catch` in readVault is very nearly
  // dead code, and before the probe a 402/429/5xx arrived as an empty list and became "no vault": a live
  // Lock button in front of 100 already-locked ADA, and an exit that said the ADA was not there.
  // The project id ships in the bundle by design, so exhausting the shared quota is routine.

  it("a rate-limited read is UNREADABLE, even though the provider returned []", async () => {
    fake.vaultUtxos = [];
    fake.probeStatus = 429;
    const { fetchVaultState } = await import("./vault");
    const st = await fetchVaultState("w");
    expect(st.known).toBe(false);
    expect(st.locked).toBeNull();
  });

  it("and it blocks a second lock rather than offering one", async () => {
    fake.vaultUtxos = [];
    fake.probeStatus = 503;
    const { lockIntoVault } = await import("./vault");
    await expect(lockIntoVault("w")).rejects.toThrow(/can't check your vault right now/i);
  });

  // THE ARM THAT MUST NOT REGRESS. Blockfrost 404s an address it has never seen, which is EVERY vault
  // address before its first lock. Mapping "any non-ok status" to unreadable would brick the Lock button
  // for 100% of new users — strictly worse than the bug the probe fixes.
  it("a 404 is a genuinely empty vault, because that is what a never-used address returns", async () => {
    fake.vaultUtxos = [];
    fake.probeStatus = 404;
    const { fetchVaultState } = await import("./vault");
    const st = await fetchVaultState("w");
    expect(st.known).toBe(true);
    expect(st.locked).toBeNull();
  });

  it("so does a 200 that agrees the address holds nothing", async () => {
    fake.vaultUtxos = [];
    fake.probeStatus = 200;
    const { fetchVaultState } = await import("./vault");
    const st = await fetchVaultState("w");
    expect(st.known).toBe(true);
    expect(st.locked).toBeNull();
  });
});

describe("lockIntoVault — refuses to mint a second beacon", () => {
  it("refuses when a vault already exists, without asking the wallet to sign", async () => {
    fake.vaultUtxos = [utxo("100000000")];
    await expect(lockIntoVault("eternl")).rejects.toThrow(/already have ADA locked/i);
    expect(fake.signed).toBe(0);
    expect(fake.submitted).toBe(0);
  });

  it("FAILS CLOSED when the vault read fails — never locks on an unverified state", async () => {
    fake.vaultReadThrows = true;
    await expect(lockIntoVault("eternl")).rejects.toThrow(/can't check your vault/i);
    expect(fake.signed).toBe(0);
    expect(fake.submitted).toBe(0);
  });

  it("proceeds when the vault is confirmed empty", async () => {
    const res = await lockIntoVault("eternl");
    expect(res.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.signed).toBe(1);
    expect(fake.submitted).toBe(1);
  });

  it("still refuses on a wrong-network wallet, before any vault read", async () => {
    fake.networkId = 1;
    await expect(lockIntoVault("eternl")).rejects.toThrow(/wrong network/i);
    expect(fake.signed).toBe(0);
  });
});

describe("exitVault — an unreadable provider is not an empty vault either", () => {
  it("says it could not check, rather than 'no locked ADA found'", async () => {
    fake.vaultReadThrows = true;
    // The old copy told a user their ADA was gone when the truth was a rate-limited read.
    await expect(exitVault("eternl")).rejects.toThrow(/can't check your vault/i);
    expect(fake.signed).toBe(0);
  });

  it("spends the largest UTxO, the one the observer credits and the UI reports", async () => {
    // The SAME read fetchVaultState reports from picks this input, so the balance on screen and the
    // UTxO the exit spends cannot be different vaults. exitVault used to re-implement largest-wins on
    // its own, which is one hand-maintained copy of a consensus rule too many.
    fake.vaultUtxos = [utxo("100000000", 0), utxo("300000000", 1), utxo("200000000", 2)];
    const res = await exitVault("eternl");
    expect(res.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.signed).toBe(1);
    expect(fake.spentIndex).toBe(1); // the 300 ADA one
    expect((await fetchVaultState("eternl")).locked).toBe(300_000_000n); // and the one reported
  });

  it("still reports a genuinely empty vault as nothing locked", async () => {
    await expect(exitVault("eternl")).rejects.toThrow(/no locked ADA/i);
  });
});

// The redeploy story, end to end. None of this is reachable on the shipped list, and that is the
// point: the day a vulnerability forces a new talk_vault while real ADA is locked, the recovery path
// has to already exist. Writing it under that time pressure is how funds get stranded.
describe("retired vault scripts", () => {
  const legacyUtxo = (lovelace: string, outputIndex = 0) => ({
    input: { txHash: "77".repeat(32), outputIndex },
    output: {
      amount: [{ unit: "lovelace", quantity: lovelace }],
      address: `addr_test_vault_${LEGACY_SCRIPT.appliedCbor}`,
    },
  });

  it("finds a balance stranded at an older script", async () => {
    fake.legacyUtxos = [legacyUtxo("100000000")];
    const [l] = await fetchLegacyVaults("eternl");
    expect(l.hash).toBe(LEGACY_SCRIPT.hash);
    expect(l.known).toBe(true);
    expect(l.lovelace).toBe(100_000_000n);
  });

  it("NEVER folds a legacy balance into `locked`, which means posting power", async () => {
    // The chain credits exactly one policy id, so a legacy balance is real ADA and zero weight.
    // Widening `locked` would tell three surfaces and the confirm poll otherwise.
    fake.legacyUtxos = [legacyUtxo("400000000")];
    const s = await fetchVaultState("eternl");
    expect(s.locked).toBeNull();
    expect(s.extraVaults).toBe(0);
  });

  it("keeps `unknown` PER SCRIPT: a failed legacy read does not poison the current one", async () => {
    // Each script is another Blockfrost call and another chance at a 402/429. Collapsing them would
    // re-disable Exit for someone whose current 100 ADA is sitting right there and readable.
    fake.vaultUtxos = [utxo("100000000")];
    fake.legacyReadThrows = true;
    const s = await fetchVaultState("eternl");
    expect(s.known).toBe(true);
    expect(s.locked).toBe(100_000_000n);
    const [l] = await fetchLegacyVaults("eternl");
    expect(l.known).toBe(false);
    expect(l.lovelace).toBeNull(); // and never rendered as "no legacy vault"
  });

  it("and the reverse: a failed CURRENT read does not hide a readable legacy balance", async () => {
    fake.vaultReadThrows = true;
    fake.legacyUtxos = [legacyUtxo("100000000")];
    const [l] = await fetchLegacyVaults("eternl");
    expect(l.known).toBe(true);
    expect(l.lovelace).toBe(100_000_000n);
  });

  it("exits a legacy vault with the LEGACY script attached, not the current one", async () => {
    // The load-bearing assertion of this whole change. The spend witness must be the script that
    // actually locks the UTxO, and the burn must be under that script's own policy id. Attaching the
    // current script would build an invalid transaction and strand the funds anyway.
    fake.legacyUtxos = [legacyUtxo("100000000")];
    const res = await exitVault("eternl", undefined, LEGACY_SCRIPT.hash);
    expect(res.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.spentScript).toBe(LEGACY_SCRIPT.appliedCbor);
    expect(fake.burnedPolicy).toBe(LEGACY_SCRIPT.hash);
    expect(res.info.script.hash).toBe(LEGACY_SCRIPT.hash);
  });

  it("defaults to the current script when no hash is given, so existing callers are unchanged", async () => {
    fake.vaultUtxos = [utxo("100000000")];
    await exitVault("eternl");
    expect(fake.spentScript).toBe(CURRENT_SCRIPT.appliedCbor);
    expect(fake.burnedPolicy).toBe(CURRENT_SCRIPT.hash);
  });

  it("still picks the largest UTxO within the legacy script", async () => {
    fake.legacyUtxos = [legacyUtxo("100000000", 0), legacyUtxo("300000000", 1)];
    await exitVault("eternl", undefined, LEGACY_SCRIPT.hash);
    expect(fake.spentIndex).toBe(1);
  });

  it("refuses a hash this bundle does not know, without asking the wallet to sign", async () => {
    await expect(exitVault("eternl", undefined, "ff".repeat(28))).rejects.toThrow(/does not know that vault/i);
    expect(fake.signed).toBe(0);
  });

  it("locks into the CURRENT script even while a legacy balance exists", async () => {
    // A stranded balance must not block a new lock: the user needs the new one to have any posting
    // power at all, and the duplicate-beacon guard is about the current script only.
    fake.legacyUtxos = [legacyUtxo("100000000")];
    const res = await lockIntoVault("eternl");
    expect(res.info.script.hash).toBe(CURRENT_SCRIPT.hash);
    expect(fake.burnedPolicy).toBe(CURRENT_SCRIPT.hash); // the MINT policy on the lock
    expect(fake.submitted).toBe(1);
  });
});
