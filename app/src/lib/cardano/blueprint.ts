// The pinned `talk_vault` artifact, as the CURRENT script plus an integrity check.
//
// `MIN_LOCK` is an alias for `VAULT_SCRIPTS[0].minLock` (lib/cardano/vaults.ts), not a second source of
// truth: it is a single number read by callers that have no reason to know a script list exists
// (preflight's floor check, /legal's "100 ADA" figure), so the indirection earns its keep. The
// per-script HASH and CBOR deliberately do not get the same treatment. They used to, and the aliases
// went dead the moment vault.ts started resolving a script per transaction (`info.script.hash` /
// `info.script.appliedCbor`) — which is the whole point of the multi-script work, since a scalar
// "the current one" cannot address a retired script at all. `BLUEPRINT_HASH` was already dropped for
// this reason; these two outlived it on a comment claiming call sites that no longer existed. Take the
// script from `VAULT_SCRIPTS` / `currentVaultScript()` and read its fields.
//
// Nothing here recomputes applyParamsToScript at runtime — that is the footgun the generator already
// navigated, and the artifact is proven against the live relaunch.

import { currentVaultScript, type VaultScript } from "./vaults";

/** The lovelace floor the current script enforces (and the default lock amount). */
export const MIN_LOCK: bigint = currentVaultScript().minLock;

// THE SAME FLOOR AS WHOLE-ADA COPY ("lock 100 ADA") LIVES IN lib/cardano/lockAmount.ts, NOT HERE, and
// is deliberately not re-exported from this module. It was here, as `LOCK_ADA_WHOLE`, and the string
// is named on surfaces that sit in the app-shell chunk (the sign-in sheet, the walled-route notice,
// the composer's guest prompt, the root layout's metadata) — so importing it from this file pulled
// `vaults.ts` and its 6 KB of applied Plutus CBOR into the bundle every cold visitor downloads, to
// render three characters. `lockAmount.test.ts` pins that literal against `MIN_LOCK` below, so the
// derivation still runs; it just runs in CI instead of in everyone's browser.
//
// Re-exporting it from here would quietly undo that: the import path is the whole mechanism.

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
