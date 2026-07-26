// Which vault script the CHAIN actually credits — asked of the chain, not assumed from the bundle.
//
// The observer's `VaultPolicyId` is a `#[pallet::constant]` and is already in the committed PAPI
// descriptors, so the frontend can just ask. Same authority argument as lib/cardano/network.ts, and the
// same shape: resolved once per chain handle from the boot probe, null until it lands, and every
// consumer fails closed rather than guessing.
//
// THE FAILURE THIS EXISTS TO CATCH. There are now two independent places that name a vault script: the
// chain's `ObsVaultPolicyId`, and `VAULT_SCRIPTS[0]` in this bundle. A redeploy has to move both, in
// two different repositories' worth of process (a runtime upgrade and a frontend deploy), and they
// cannot be made atomic. If they disagree, `lockIntoVault` builds a perfectly valid transaction that
// pays 100 ADA into a script address the observer is not watching — no error, no revert, no refund
// path except an exit the user has to think to perform, and no posting power ever. That is the single
// most expensive silent failure this app can produce, and it is one constant read away from being an
// upfront refusal instead.
//
// It deliberately does NOT gate READING or EXITING. Those are recovery paths: if the bundle and the
// chain disagree, being able to get your ADA back is the thing you need most, and a mismatch is not a
// reason to lock someone out of their own funds.
//
// SSG-safe: module state only, no `window` at evaluation time.

import type { CognoApi } from "@/lib/types";
import { currentVaultScript } from "./vaults";

/** The chain's answer (28-byte hex, no 0x), or null before the boot probe has resolved it. */
let observedPolicyId: string | null = null;

/** Bumped by {@link resetVaultPolicy}, so a superseded resolve cannot commit. Same guard as network.ts. */
let epoch = 0;

/** The vault policy id the connected chain credits, or null when it is not known yet. */
export function getObservedVaultPolicyId(): string | null {
  return observedPolicyId;
}

/** Drop the cached value and invalidate any resolve in flight (called when the chain handle changes). */
export function resetVaultPolicy(): void {
  epoch += 1;
  observedPolicyId = null;
}

/**
 * Read `CardanoObserver.VaultPolicyId` and cache it. Never throws: an unreadable constant resolves to
 * null, and the guard below treats "not known" as "do not block", because a boot-probe failure must
 * not take locking down on a chain that is configured perfectly well.
 */
export async function resolveVaultPolicy(api: CognoApi): Promise<string | null> {
  const gen = epoch;
  try {
    const raw = await api.constants.CardanoObserver.VaultPolicyId();
    const hex = String(raw).toLowerCase().replace(/^0x/, "");
    if (gen !== epoch) return hex; // superseded; return it, but never write the cache
    observedPolicyId = hex;
    return hex;
  } catch (err) {
    if (gen === epoch) observedPolicyId = null;
    console.warn("[cogno] could not read the chain's vault policy id:", err);
    return null;
  }
}

/**
 * Refuse to lock into a script the chain is not watching.
 *
 * Fails OPEN on an unresolved read, and that is the deliberate choice rather than an oversight: a
 * failed constant read is a boot problem, and blocking every lock on the whole deployment because one
 * constant read timed out would be a far more likely outage than the mismatch this guards. The
 * mismatch itself is only reachable through an operator error that has already happened, so refusing
 * exactly then costs nothing.
 *
 * Throws user-facing copy (this reaches the screen), with the two hashes going to the console for
 * whoever has to fix the deploy.
 */
export function assertVaultPolicyMatchesChain(): void {
  const chainSays = observedPolicyId;
  if (chainSays === null) return; // not known → not a verdict
  const bundleSays = currentVaultScript().hash.toLowerCase();
  if (chainSays === bundleSays) return;
  console.error(
    `[cogno] vault policy mismatch: the chain credits ${chainSays} but this app builds ${bundleSays}. ` +
      `A lock here would pay into an address the observer does not read. Deploy the frontend that matches ` +
      `the runtime's ObsVaultPolicyId, or update it.`,
  );
  throw new Error(
    "This app and the network disagree about which vault to use, so locking is off. Getting ADA back still works.",
  );
}
