// The vault lock/exit guards. Everything here is about ONE class of bug: treating "we could not read
// the vault" as "there is no vault", and then offering to lock 100 more real ADA on the strength of it.
//
// A second lock is pure loss of use. The observer credits largest-wins and never sums, so the extra
// 100 ADA earns nothing, and every screen in the app reads a single vault UTxO so it is invisible.
// The guard therefore lives in lockIntoVault itself, not in the UI: /welcome gated its Lock button on
// posting power plus a device-local record with no vault read behind it, while Settings gated
// correctly — which is exactly why a caller-side guard is not enough.
//
// MeshJS is browser-only, so the surfaces vault.ts dynamically imports are mocked. The provider is
// mocked at the module seam so a read failure can be simulated exactly.

import { describe, it, expect, beforeEach, vi } from "vitest";

const fake = {
  networkId: 0 as number,
  paymentType: 0 as number,
  /** what the provider returns for the vault address; a throw simulates a rate-limited read. */
  vaultUtxos: [] as Array<{
    input: { txHash: string; outputIndex: number };
    output: { amount: Array<{ unit: string; quantity: string }> };
  }>,
  vaultReadThrows: false,
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
  serializePlutusScript: () => ({ address: "addr_test_vault" }),
  MeshTxBuilder: class {
    txHex = "84a0";
    mintPlutusScriptV3() { return this; }
    mint() { return this; }
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
    txInScript() { return this; }
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

vi.mock("./provider", () => ({
  getProvider: async () => ({
    fetchAddressUTxOs: async () => {
      if (fake.vaultReadThrows) throw new Error("Blockfrost 429");
      return fake.vaultUtxos;
    },
  }),
}));

vi.mock("./blueprint", () => ({
  VAULT_HASH: "dd".repeat(28),
  APPLIED_CBOR: "5901",
  MIN_LOCK: 100_000_000n,
  assertBlueprintIntegrity: async () => {},
}));

import { lockIntoVault, exitVault, fetchVaultState } from "./vault";
import { seedCardanoNetwork } from "./network.fixture";

const utxo = (lovelace: string, outputIndex = 0) => ({
  input: { txHash: "ee".repeat(32), outputIndex },
  output: { amount: [{ unit: "lovelace", quantity: lovelace }], address: "addr_test_vault" },
});

beforeEach(async () => {
  fake.networkId = 0;
  fake.paymentType = 0;
  fake.vaultUtxos = [];
  fake.vaultReadThrows = false;
  fake.signed = 0;
  fake.submitted = 0;
  fake.spentIndex = null;
  await seedCardanoNetwork(0);
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
