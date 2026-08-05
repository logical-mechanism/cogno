// In-browser talk_vault lock / exit — the L1 "interact with the smart contract" half of the wallet
// button. A browser port of app/scripts/cardano-reference/m2d-{lock,unlock}.mjs: identical tx shape, but the
// signer is the user's connected CIP-30 wallet and the provider is Blockfrost (which supplies live
// cost models, so no manual setCostModels). MeshJS is browser-only, so every runtime dependency is
// imported INSIDE the async functions — this module is import-safe during the static export.
//
// The dual-key discipline holds: the Cardano wallet signs the lock/exit txs (and CIP-8 bind); it
// NEVER signs a post. Posting uses the separate sr25519 key. This module never sees a private key.
import type { BrowserWallet, UTxO } from "@meshsdk/core";
import { MIN_LOCK, assertBlueprintIntegrity } from "./blueprint";
import {
  currentVaultScript,
  legacyVaultScripts,
  vaultScriptByHash,
  type VaultScript,
} from "./vaults";
import { assertVaultPolicyMatchesChain } from "./vaultPolicy";
import {
  beaconNameHex,
  vaultDatumCborHex,
  mintRedeemerCborHex,
  burnRedeemerCborHex,
  SPEND_REDEEMER_CBOR,
} from "./beacon";
import { preflightLock } from "./preflight";
import { getProvider } from "./provider";
import { getBlockfrostProjectId } from "@/lib/config/endpoints";
import { blockfrostBase } from "@/lib/cardano/network";
import { assertWalletNetwork, type CardanoNetworkId } from "./network";

export interface OwnerKeys {
  address: string;
  paymentKeyHash: string;
  stakeKeyHash: string;
}

export interface VaultInfo {
  /** the script address (vault hash payment cred + the owner's stake cred). */
  vaultAddress: string;
  /** the 32-byte beacon name == the app-chain identity hash (blake2b_256(owner)). */
  beacon: string;
  /** policyId + beacon — the full asset unit. */
  unit: string;
  owner: OwnerKeys;
  /** WHICH script this address belongs to. Only `currentVaultScript()` ever earns posting power. */
  script: VaultScript;
}

/**
 * Enable the wallet and derive the owner's keys. Script-INDEPENDENT, so a read that spans several
 * scripts pays for the wallet enable and the address parse once rather than once per script.
 */
async function resolveOwner(
  walletId: string,
): Promise<{ wallet: BrowserWallet; owner: OwnerKeys; network: CardanoNetworkId }> {
  const [{ BrowserWallet }, cst] = await Promise.all([import("@meshsdk/core"), import("@meshsdk/core-cst")]);
  const wallet = await BrowserWallet.enable(walletId);
  // Name the cause: this used to say "connect a Cardano wallet", which misread as a connection problem
  // rather than a network mismatch (connect + both binds now catch this earlier — see wallet-derive.ts).
  // The expected network comes from the chain, not a literal — see lib/cardano/network.ts.
  const network = assertWalletNetwork(await wallet.getNetworkId());
  const address = await wallet.getChangeAddress();
  const props = cst.Address.fromBech32(address).getProps();
  if (props.paymentPart?.type !== 0) {
    throw new Error("Connect a normal wallet address, not a script address.");
  }
  const paymentKeyHash = props.paymentPart.hash;
  const stakeKeyHash = props.delegationPart?.hash;
  if (!stakeKeyHash) {
    throw new Error("This wallet address has no stake key. Use a base address.");
  }
  return { wallet, owner: { address, paymentKeyHash, stakeKeyHash }, network };
}

/**
 * One owner's vault address / beacon / unit under ONE script.
 *
 * The beacon NAME is derived from the owner Address alone, so it is identical across scripts. The
 * ADDRESS and the asset UNIT are not: both carry the script's own hash. That is precisely why a
 * retired script's UTxOs are invisible to a bundle that knows only the current hash — they sit at a
 * different address under a different policy id, and nothing about the current script finds them.
 */
async function vaultInfoFor(
  script: VaultScript,
  owner: OwnerKeys,
  network: CardanoNetworkId,
): Promise<VaultInfo> {
  const { serializePlutusScript } = await import("@meshsdk/core");
  // The network id here decides whether the vault address is `addr_test1…` or `addr1…`. Getting it
  // wrong does not throw: it builds a well-formed address on the wrong network, and the lock tx pays
  // real ADA to a script address that does not exist on the network the chain is observing.
  const { address: vaultAddress } = serializePlutusScript(
    { code: script.appliedCbor, version: "V3" },
    owner.stakeKeyHash,
    network,
    false,
  );
  const beacon = beaconNameHex(owner.paymentKeyHash, owner.stakeKeyHash);
  return { vaultAddress, beacon, unit: script.hash + beacon, owner, script };
}

/** Enable the wallet and resolve this owner's vault under one script (default: the current one). */
async function resolveVault(
  walletId: string,
  script: VaultScript = currentVaultScript(),
): Promise<{ wallet: BrowserWallet; info: VaultInfo }> {
  const { wallet, owner, network } = await resolveOwner(walletId);
  return { wallet, info: await vaultInfoFor(script, owner, network) };
}

/**
 * What a vault read found. The third case is the point: "we could not read" is NOT "there is no
 * vault". Collapsing them is how a Blockfrost 402/429 used to render "No vault yet" with a live Lock
 * button in front of someone who already had 100 ADA locked.
 */
export type VaultRead =
  /** `utxo` is the winning one — the one the chain credits AND the one an exit must spend. */
  | { kind: "locked"; lovelace: bigint; utxo: UTxO; utxos: number }
  | { kind: "none" }
  | { kind: "unknown" };

/** The slice of the provider a vault read needs — keeps this file off the heavier MeshJS types. */
type VaultFetcher = { fetchAddressUTxOs: (address: string, asset?: string) => Promise<UTxO[]> };

/** The lovelace a vault UTxO holds. */
function lovelaceOf(u: UTxO): bigint {
  return BigInt(u.output.amount.find((a) => a.unit === "lovelace")?.quantity ?? "0");
}

/**
 * Read the vault UTxOs holding this owner's beacon. Never throws: a provider failure is reported as
 * `unknown` so every caller has to decide what to do about it rather than inheriting a wrong answer.
 *
 * Reports the LARGEST UTxO, matching what the chain actually credits — the observer's reduction is
 * largest-wins per identity and never sums (cogno-dbsync/src/reduction.rs). `utxos` carries the count
 * so a caller can tell that a second, uncredited vault exists.
 *
 * This is the ONE place that rule is implemented. `exitVault` used to carry its own copy of it, which
 * meant the UI could report one UTxO while the exit tx spent another the moment the two drifted.
 */
async function readVault(provider: VaultFetcher, info: VaultInfo): Promise<VaultRead> {
  try {
    const utxos = await provider.fetchAddressUTxOs(info.vaultAddress, info.unit);
    if (!utxos.length) return probeEmpty(info);
    const utxo = utxos.reduce((best, u) => (lovelaceOf(u) > lovelaceOf(best) ? u : best));
    return { kind: "locked", lovelace: lovelaceOf(utxo), utxo, utxos: utxos.length };
  } catch {
    return { kind: "unknown" };
  }
}

/** How long the empty-branch probe waits before it gives up and answers `unknown`. */
const PROBE_TIMEOUT_MS = 8000;

/**
 * Decide what an EMPTY `fetchAddressUTxOs` actually meant.
 *
 * THE CATCH ABOVE IS VERY NEARLY DEAD CODE, and that is why this exists. `fetchAddressUTxOs` is the one
 * method on MeshJS's BlockfrostProvider that swallows its errors — it ends `catch (error) { return []; }`,
 * where `get`, `fetchProtocolParameters` and `evaluateTx` all rethrow. So a 402/429/5xx did not throw:
 * it returned `[]`, which became `{kind:"none"}`, and every guard built on `unknown` was bypassed. The
 * project id ships in the bundle by design, so exhausting the shared quota is not exotic. The result was
 * "No vault yet" with a live Lock button in front of someone with 100 ADA already locked — the exact
 * failure the `unknown` case was introduced to prevent — and an exit that answered "No locked ADA found
 * for this wallet." with the ADA sitting right there.
 *
 * Re-asks with a status-bearing `fetch`, the same idiom govParams/govAction already use.
 *
 * THE 404 ARM IS MANDATORY, not a nicety. Blockfrost 404s an address it has never seen, which is EVERY
 * vault address before its first lock. Map that to `unknown` and the Lock button is dead for 100% of new
 * users — strictly worse than the bug this fixes. Hence the explicit arm, and the test beside it.
 *
 * The id is read rather than passed because every `readVault` caller builds its provider with a bare
 * `getProvider()`, which has already validated the id and refused a `providerNetworkMismatch` — so this
 * is the same id, on the same network, that returned the empty list.
 */
async function probeEmpty(info: VaultInfo): Promise<VaultRead> {
  const projectId = getBlockfrostProjectId().trim();
  // No id means the provider could not have been built at all; the caller is already in its error path.
  if (!projectId || typeof fetch !== "function") return { kind: "unknown" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${blockfrostBase()}/addresses/${info.vaultAddress}/utxos/${info.unit}`, {
      headers: { project_id: projectId },
      signal: ctl.signal,
    });
    // An address with no history. This IS "no vault", and it is the pre-lock state of every new user.
    if (res.status === 404) return { kind: "none" };
    // 402 over-quota, 403 bad id, 418/429 rate limited, 5xx — every one of these is "could not read".
    if (!res.ok) return { kind: "unknown" };
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return { kind: "unknown" };
    // Agreeing with the empty list is the whole point. A NON-empty body here means the two calls
    // disagree, and "there is no vault" is the one answer that must not be guessed — so say unknown.
    return body.length === 0 ? { kind: "none" } : { kind: "unknown" };
  } catch {
    return { kind: "unknown" }; // network error, abort, or a body that would not parse
  } finally {
    clearTimeout(timer);
  }
}

/** A pure-ADA collateral UTxO (≥5 ADA) — the wallet's own pick, else the first that qualifies. */
function pickCollateral(collateral: UTxO[], utxos: UTxO[]): UTxO {
  const c =
    collateral[0] ??
    utxos.find((u) => u.output.amount.length === 1 && BigInt(u.output.amount[0].quantity) >= 5_000_000n);
  if (!c) throw new Error("Your wallet needs an ADA-only collateral UTxO of at least 5 ADA.");
  return c;
}

/** Progress phases for a lock/exit tx, so the UI can show a live step flow (the wallet sign and the
 *  Cardano submit are distinct waits, and the submit after signing otherwise reads as "stuck"). */
export type VaultTxPhase = "signing" | "submitting";

/** Lock `lockLovelace` (default = min_lock) at the vault + mint the owner's beacon. */
export async function lockIntoVault(
  walletId: string,
  lockLovelace: bigint = MIN_LOCK,
  onPhase?: (p: VaultTxPhase) => void,
): Promise<{ txHash: string; info: VaultInfo }> {
  await assertBlueprintIntegrity();
  // Refuse to pay into a script the chain is not watching. The bundle and the runtime each name a
  // vault policy id, a redeploy has to move both, and the two can never be made atomic — so a
  // disagreement is reachable, and its failure mode is a valid tx that pays 100 ADA to an address the
  // observer never reads. No error, no revert, no posting power, ever. Fails OPEN when the chain's
  // answer is not known: see vaultPolicy.ts.
  assertVaultPolicyMatchesChain();
  const { wallet, info } = await resolveVault(walletId);
  const { paymentKeyHash, stakeKeyHash } = info.owner;
  preflightLock({ paymentKeyHash, stakeKeyHash, lockLovelace, beacon: info.beacon });

  const { MeshTxBuilder } = await import("@meshsdk/core");
  const provider = await getProvider();

  // Refuse to mint a second beacon for this owner, and refuse to guess. The guard lives HERE rather
  // than in the UI because the UI is what got it wrong: /welcome gated its Lock button on posting
  // power plus a device-local pending record, with no vault read behind it, so a second device or
  // cleared storage re-armed it. Settings gated correctly, which is exactly why a caller-side guard
  // is not enough.
  //
  // A second lock is pure loss of use: the observer credits largest-wins and never sums, so 200 ADA
  // buys 100 ADA of weight, and every screen here reads a single vault UTxO so the extra one is
  // invisible. `unknown` blocks too — locking on an unverified read is the exact mistake.
  const existing = await readVault(provider, info);
  if (existing.kind === "unknown") {
    throw new Error("Can't check your vault right now. Try again in a moment.");
  }
  if (existing.kind === "locked") {
    throw new Error("You already have ADA locked. Get it back first if you want to lock a different amount.");
  }

  const utxos = await wallet.getUtxos();
  if (!utxos.length) throw new Error("Your wallet is empty. Add ADA first.");
  const collateral = pickCollateral(await wallet.getCollateral(), utxos);

  const datum = vaultDatumCborHex(paymentKeyHash, stakeKeyHash);
  const redeemer = mintRedeemerCborHex(paymentKeyHash, stakeKeyHash);

  const tx = new MeshTxBuilder({ fetcher: provider, submitter: provider, evaluator: provider, verbose: false });
  tx.mintPlutusScriptV3()
    .mint("1", info.script.hash, info.beacon)
    .mintingScript(info.script.appliedCbor)
    .mintRedeemerValue(redeemer, "CBOR")
    .txOut(info.vaultAddress, [
      { unit: "lovelace", quantity: lockLovelace.toString() },
      { unit: info.unit, quantity: "1" },
    ])
    .txOutInlineDatumValue(datum, "CBOR")
    .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
    .requiredSignerHash(paymentKeyHash)
    .changeAddress(info.owner.address)
    .selectUtxosFrom(utxos);
  await tx.complete();
  onPhase?.("signing");
  const signed = await wallet.signTx(tx.txHex);
  onPhase?.("submitting");
  const txHash = await wallet.submitTx(signed);
  return { txHash, info };
}

/**
 * Full exit: spend the vault UTxO + burn the beacon (-1), reclaiming the locked ADA to the owner.
 *
 * `scriptHash` selects WHICH vault to empty, defaulting to the current one. This is the whole point of
 * the script list: if talk_vault is ever redeployed, the funds sitting at the retired address are only
 * reachable through a transaction that attaches THAT script's applied CBOR as the spend witness and
 * burns the beacon under THAT script's own policy id. A hash alone cannot spend it, which is why every
 * entry in `VAULT_SCRIPTS` carries its CBOR.
 *
 * Everything else here is script-independent: the spend redeemer is a constant, the burn redeemer is
 * derived from the beacon (which is a function of the owner Address, not of the script), and the
 * required signer is the owner's payment key in every case.
 *
 * One transaction per script, deliberately. A combined two-script exit would validate on chain (the
 * validator's single-own-input guard counts inputs at its own hash only), but it needs both CBORs
 * attached plus two spend and two mint redeemers, which inflates size and execution units and fails
 * atomically. Separate exits also match the copy already shipped for multiple vault UTxOs.
 */
export async function exitVault(
  walletId: string,
  onPhase?: (p: VaultTxPhase) => void,
  scriptHash?: string,
): Promise<{ txHash: string; info: VaultInfo }> {
  const script = scriptHash ? vaultScriptByHash(scriptHash) : currentVaultScript();
  if (!script) {
    // Only reachable if a caller invents a hash: every UI path passes one this bundle listed.
    throw new Error("This app does not know that vault, so it cannot get the ADA back.");
  }
  // Per-script, not global: a mistyped legacy entry must fail here rather than build a transaction
  // against a script whose CBOR and hash come from different releases.
  await assertBlueprintIntegrity(script);
  const { wallet, info } = await resolveVault(walletId, script);
  const { MeshTxBuilder } = await import("@meshsdk/core");
  const provider = await getProvider();

  // Spend the LARGEST vault UTxO, through the SAME read the UI reports from — so the one shown and the
  // one spent can never be different UTxOs. A provider failure must not read as "nothing locked" here
  // either: that message told a user their ADA was gone when the truth was a rate-limited read.
  const read = await readVault(provider, info);
  if (read.kind === "unknown") {
    throw new Error("Can't check your vault right now. Try again in a moment.");
  }
  if (read.kind === "none") throw new Error("No locked ADA found for this wallet.");
  const target = read.utxo;

  const utxos = await wallet.getUtxos();
  const collateral = pickCollateral(await wallet.getCollateral(), utxos);
  const burnRedeemer = burnRedeemerCborHex(info.beacon);

  const tx = new MeshTxBuilder({ fetcher: provider, submitter: provider, evaluator: provider, verbose: false });
  tx.spendingPlutusScriptV3()
    .txIn(target.input.txHash, target.input.outputIndex, target.output.amount, target.output.address)
    .txInScript(info.script.appliedCbor)
    .txInInlineDatumPresent()
    .txInRedeemerValue(SPEND_REDEEMER_CBOR, "CBOR")
    .mintPlutusScriptV3()
    .mint("-1", info.script.hash, info.beacon)
    .mintingScript(info.script.appliedCbor)
    .mintRedeemerValue(burnRedeemer, "CBOR")
    .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
    .requiredSignerHash(info.owner.paymentKeyHash)
    .changeAddress(info.owner.address)
    .selectUtxosFrom(utxos);
  await tx.complete();
  onPhase?.("signing");
  const signed = await wallet.signTx(tx.txHex);
  onPhase?.("submitting");
  const txHash = await wallet.submitTx(signed);
  return { txHash, info };
}

/**
 * Read whether this wallet currently has a live vault + how much is locked (for UI state).
 *
 * `known` is the load-bearing field. It used to be absent, and every provider failure came back as
 * `locked: null` — indistinguishable from "no vault". A caller that renders a Lock button on
 * `locked == null` therefore invited a duplicate 100-ADA lock every time Blockfrost rate-limited,
 * which anyone can trigger for everyone, since the project id ships in the bundle by design.
 */
export async function fetchVaultState(
  walletId: string,
): Promise<{
  info: VaultInfo;
  locked: bigint | null;
  known: boolean;
  extraVaults: number;
  /**
   * The tx that CREATED the winning vault UTxO, or null when nothing is locked.
   *
   * Surfaced so a device that never saw the lock submitted can still rebuild a pending record from
   * chain state (`usePendingLockRecover`). Without it, opening the app on a second device mid-wait
   * reports "you have no posting power, lock some ADA" to someone whose ADA is already locked.
   */
  lockedTxHash: string | null;
}> {
  const { info } = await resolveVault(walletId);
  const provider = await getProvider();
  const read = await readVault(provider, info);
  return {
    info,
    locked: read.kind === "locked" ? read.lovelace : null,
    known: read.kind !== "unknown",
    // >0 means a second, uncredited vault UTxO exists for this owner (see readVault).
    extraVaults: read.kind === "locked" ? read.utxos - 1 : 0,
    lockedTxHash: read.kind === "locked" ? read.utxo.input.txHash : null,
  };
}

/** A balance found at a RETIRED script: real ADA, zero posting power, its own exit transaction. */
export interface LegacyVaultBalance {
  /** The retired script's hash — what `exitVault`'s third argument takes. */
  hash: string;
  /** Its human label, for the copy. */
  label: string;
  /** The largest UTxO's lovelace, or null when there is none or the read failed. */
  lovelace: bigint | null;
  /** False ⇒ the provider could not be read for THIS script. Never rendered as "nothing there". */
  known: boolean;
}

/**
 * Read this owner's balance at every RETIRED script.
 *
 * Kept out of `fetchVaultState` on purpose, on both of the axes that matter:
 *
 * MEANING. `fetchVaultState().locked` drives "you have posting power" across three surfaces and the
 * confirm poll's settled() predicate. A legacy balance earns nothing — the chain filters on a single
 * `ObsVaultPolicyId` and cogno-dbsync's reduction takes one vault hash — so folding it in would report
 * an uncreditable balance as credited. That is the same class of untruth the vault-honesty pass just
 * removed, pointed the other way.
 *
 * COST. `fetchVaultState` runs on mount on two surfaces and again every 6 seconds through the whole
 * post-submit confirm poll. Each extra script is another `fetchAddressUTxOs`, and the Blockfrost
 * project id ships in the bundle by design, so anyone can exhaust the quota for everyone. This is a
 * separate call the UI makes ONCE, never in the poll loop.
 *
 * Per-script `unknown` is preserved rather than collapsed: one script's rate-limited read must not
 * report another's balance as unreadable, and an unreadable script must never render as an empty one.
 *
 * Returns [] with no provider work at all while there are no retired scripts, which is today.
 */
export async function fetchLegacyVaults(walletId: string): Promise<LegacyVaultBalance[]> {
  const scripts = legacyVaultScripts();
  if (scripts.length === 0) return [];
  const { owner, network } = await resolveOwner(walletId);
  const provider = await getProvider();
  return Promise.all(
    scripts.map(async (script) => {
      // A THROW here (an address that will not serialize, say) is per-script too: it must degrade that
      // one entry to `known: false`, not take the whole list down and hide the others.
      try {
        const info = await vaultInfoFor(script, owner, network);
        const read = await readVault(provider, info);
        return {
          hash: script.hash,
          label: script.label,
          lovelace: read.kind === "locked" ? read.lovelace : null,
          known: read.kind !== "unknown",
        };
      } catch {
        return { hash: script.hash, label: script.label, lovelace: null, known: false };
      }
    }),
  );
}
