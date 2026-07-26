// The pinned `talk_vault` artifact, as the CURRENT script plus an integrity check.
//
// The scalars below are aliases for `VAULT_SCRIPTS[0]` (lib/cardano/vaults.ts), not a second source of
// truth. They stay because every existing call site reads them and because "the current script" is the
// right default for almost everything; the array is what makes a retired script reachable at all. See
// vaults.ts for why that list exists and how to add to it.
//
// Nothing here recomputes applyParamsToScript at runtime — that is the footgun the generator already
// navigated, and the artifact is proven against the live relaunch.

import { currentVaultScript, type VaultScript } from "./vaults";

/** The min_lock-applied policy id == vault script hash, for the CURRENT script. */
export const VAULT_HASH: string = currentVaultScript().hash;
/** The applied (parameterized) Plutus V3 script CBOR for the CURRENT script. */
export const APPLIED_CBOR: string = currentVaultScript().appliedCbor;
/** The lovelace floor the current script enforces (and the default lock amount). */
export const MIN_LOCK: bigint = currentVaultScript().minLock;

/**
 * Hashes proven to match their own CBOR, so the check runs once per script rather than once per app.
 *
 * This was a single `let asserted` boolean, which was correct while exactly one script existed and is
 * exactly wrong now: the first script verified would have marked every LATER one as checked, so a
 * mistyped legacy entry would have gone straight into a transaction unverified.
 */
const verified = new Set<string>();

/**
 * Defense in depth: confirm a script's shipped CBOR really hashes to its pinned hash before it is used
 * to build a transaction. Catches a corrupted or out-of-sync artifact, and — the new case — a legacy
 * entry whose hash and CBOR were pasted from different releases. Uses `resolveScriptHash` (light)
 * rather than re-applying the parameter.
 *
 * Defaults to the current script, so existing callers are unchanged.
 */
export async function assertBlueprintIntegrity(script: VaultScript = currentVaultScript()): Promise<void> {
  if (verified.has(script.hash)) return;
  const { resolveScriptHash } = await import("@meshsdk/core");
  const h = resolveScriptHash(script.appliedCbor, "V3");
  if (h !== script.hash) {
    // The throw reaches the user (it blocks both lock and exit), so it stays plain; the hashes and
    // the operator's fix go to the console, where whoever shipped the mismatched artifact will look.
    console.error(
      `[cogno] talk_vault artifact integrity check failed for ${script.label}: applied CBOR hashes to ${h}, expected ${script.hash}. Re-run contracts/scripts/regen-vault.mjs, or check the legacy entry in lib/cardano/vaults.ts.`,
    );
    throw new Error("Vault contract check failed. Locking and exiting are disabled.");
  }
  verified.add(script.hash);
}
