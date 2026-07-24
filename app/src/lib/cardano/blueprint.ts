// The pinned `talk_vault` artifact — the committed vault.json (regenerated from contracts/plutus.json
// by contracts/scripts/regen-vault.mjs, kept in sync there). The in-browser lock builds from this
// applied CBOR + hash; nothing here recomputes applyParamsToScript at runtime (that's the footgun the
// generator already navigated). The artifact is the source of truth, proven against the live relaunch.
import vault from "./vault.json";

/** The min_lock-applied policy id == vault script hash. */
export const VAULT_HASH: string = vault.vaultHash;
/** The applied (parameterized) Plutus V3 script CBOR — the mint/spend script in every vault tx. */
export const APPLIED_CBOR: string = vault.appliedCbor;
/** The lovelace floor the script enforces (and the default lock amount). */
export const MIN_LOCK: bigint = BigInt(vault.minLock);
/** The unparameterized blueprint hash from plutus.json (49ffbfc6… after the L-01 audit fix). */
export const BLUEPRINT_HASH: string = vault.blueprintHash;

let asserted = false;
/**
 * Defense in depth: confirm the shipped applied CBOR really hashes to the pinned vault hash
 * (catches a corrupted / out-of-sync vault.json) before we ever build a locking tx. Uses
 * resolveScriptHash (light) rather than re-applying the param.
 */
export async function assertBlueprintIntegrity(): Promise<void> {
  if (asserted) return;
  const { resolveScriptHash } = await import("@meshsdk/core");
  const h = resolveScriptHash(APPLIED_CBOR, "V3");
  if (h !== VAULT_HASH) {
    // The throw reaches the user (it blocks both lock and exit), so it stays plain; the hashes and
    // the operator's fix go to the console, where whoever shipped the mismatched artifact will look.
    console.error(
      `[cogno] talk_vault artifact integrity check failed: applied CBOR hashes to ${h}, expected ${VAULT_HASH}. Re-run contracts/scripts/regen-vault.mjs.`,
    );
    throw new Error("Vault contract check failed. Locking and exiting are disabled.");
  }
  asserted = true;
}
