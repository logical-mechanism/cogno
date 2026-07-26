// Every talk_vault script this bundle knows how to reach — current FIRST, then any it has retired.
//
// WHY THIS IS A LIST AND NOT A CONSTANT
//
// The vault holds user funds under an audited but not infallible Plutus script. If a vulnerability is
// ever found in it while ADA is locked, the response is to deploy a fixed script and move everybody
// across. Until now the bundle could compute exactly ONE vault address — `blueprint.ts` exported the
// hash and the applied CBOR as scalars from a single pinned artifact — so shipping the new script would
// have made every existing vault UTxO unreachable from this app in the same instant. The exit path for
// the old one would have had to be written, reviewed and deployed IN THE SAME RELEASE, under exactly
// the time pressure where that goes wrong. Being able to spend a legacy vault is a property you want to
// already have on the day you need it, not a thing you build on that day.
//
// Nothing under contracts/ is touched to add an entry here, which matters: any edit there recompiles
// the script and MOVES the live hash, orphaning the deployed vault. `vault.json` also has to stay
// byte-identical to `contracts/vault.json` (regen-vault.mjs asserts it under `--verify`), which is why
// the list lives in this file and imports that artifact rather than restructuring it.
//
// WHAT IS AND IS NOT PER-SCRIPT
//
// The CHAIN credits exactly one script. `ObsVaultPolicyId` is a single 28-byte runtime constant, and
// cogno-dbsync's reduction takes one vault hash and filters `tx_out.payment_cred` against it. So:
//
//   locking      CURRENT script only, always. Locking into a retired script would buy nothing.
//   crediting    CURRENT script only. A legacy balance is real ADA and zero posting power.
//   reading      every script, because a user needs to be able to SEE a stranded balance.
//   exiting      every script, each with its own transaction.
//
// A legacy balance must therefore never be folded into the numbers that mean "posting power". That is
// the same class of mistake the vault-honesty pass just removed, in the other direction: there, an
// unreadable vault was reported as an empty one; here, an uncreditable balance must not be reported as
// a credited one.
//
// ADDING A RETIRED SCRIPT (the redeploy runbook)
//
//   1. Deploy the new script and update contracts/, which regenerates vault.json. Entry 0 follows it
//      automatically, so the CURRENT entry is never hand-typed.
//   2. Add the OLD script to LEGACY_VAULTS below, with the hash and applied CBOR taken from the
//      previous vault.json (git history has it). Both are required: the exit attaches the script's
//      full CBOR as the spend witness AND burns the beacon under that script's own policy id, so a
//      hash alone cannot spend it.
//   3. Update the chain's `ObsVaultPolicyId` to the new hash in the same upgrade. Until that lands the
//      new script earns nothing, and `vaultPolicy.ts` refuses to lock rather than letting anyone pay
//      into an address the observer is not watching.
//
// Order is load-bearing: index 0 is the current script, everything after it is retired, and
// `currentVaultScript()` is the only sanctioned way to ask for "the one to lock into".
//
// COST OF AN ENTRY: an applied CBOR is a few KB of hex in the bundle. That is the price of being able
// to spend it, and it is small next to the MeshJS chunk. It is still a reason to remove an entry once
// its addresses are provably empty, rather than accumulating them forever.

import vault from "./vault.json";

/** One deployed talk_vault script: everything needed to build its address AND to spend from it. */
export interface VaultScript {
  /** The min_lock-applied policy id, which IS the script hash (28 bytes, hex). */
  readonly hash: string;
  /** The applied (parameterized) Plutus V3 CBOR. Required to spend and to burn, not just to address. */
  readonly appliedCbor: string;
  /** The lovelace floor this script enforces. Kept per-script: a redeploy may change it. */
  readonly minLock: bigint;
  /** Short human label for the UI, e.g. "the current vault" / "an older vault". */
  readonly label: string;
}

/**
 * The live script, straight from the committed artifact. Never hand-edited: `regen-vault.mjs` owns
 * vault.json, and this is the one entry that tracks it.
 */
const CURRENT: VaultScript = {
  hash: vault.vaultHash,
  appliedCbor: vault.appliedCbor,
  minLock: BigInt(vault.minLock),
  label: "Current vault",
};

/**
 * Retired scripts, newest first. EMPTY today, because talk_vault has been deployed once and is live.
 *
 * This is not dead code waiting for a use. The read and exit paths already iterate it, so the day an
 * entry is added the recovery UI is already written, already tested and already shipped; adding one is
 * a data change. See the runbook in this file's header.
 */
const LEGACY_VAULTS: readonly VaultScript[] = [];

/** Every known script, current first. */
export const VAULT_SCRIPTS: readonly VaultScript[] = [CURRENT, ...LEGACY_VAULTS];

/** The script to lock into. The ONLY one that earns posting power. */
export function currentVaultScript(): VaultScript {
  return VAULT_SCRIPTS[0];
}

/** The retired scripts, which can be read and exited but never locked into. */
export function legacyVaultScripts(): readonly VaultScript[] {
  return VAULT_SCRIPTS.slice(1);
}

/**
 * Look a script up by hash, so an exit can name which vault it is spending without a caller passing
 * the CBOR around. Case-insensitive: a hash may arrive from a provider, a chain constant or a URL.
 */
export function vaultScriptByHash(hash: string): VaultScript | undefined {
  const want = hash.toLowerCase().replace(/^0x/, "");
  return VAULT_SCRIPTS.find((s) => s.hash.toLowerCase() === want);
}
