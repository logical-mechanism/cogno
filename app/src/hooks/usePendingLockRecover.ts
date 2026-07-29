"use client";

// usePendingLockRecover — rebuild a pending-lock record from chain state, for a device that never saw
// the lock submitted.
//
// WHY. `cg-pending-locks` is written at submit and lives in localStorage, so it only ever existed on
// the device that placed the lock. The wait it covers runs 10 minutes on preprod and up to 36 HOURS at
// the mainnet stability window, which makes "opened it on my phone" and "cleared site data" ordinary
// rather than exotic. Without a record, the app takes the honest-looking route and tells someone whose
// 100 ADA is already locked that they have no posting power and should lock some. That is a false
// statement about the user's own money, and it is the exact failure pendingLockStore exists to prevent
// on the device that DOES have the record.
//
// The money is not at risk either way (`lockIntoVault` refuses a second lock while one is readable, so
// they cannot double-pay by following the bad advice), but the claim is still wrong.
//
// WHERE IT RUNS. Only where vault state is already loaded: the welcome flow and the Settings vault
// section. Reading the vault costs a Blockfrost call, and mounting this on the timeline would put one
// behind every composer render for every user. That is the trade being made deliberately: a returning
// user on a second device sees the wrong message on the feed until they act on it, and acting on it
// ("Lock ADA") takes them to /welcome, where this fires and corrects the state. It self-heals on the
// first click rather than on arrival.

import { useEffect } from "react";
import type { UseVault } from "./useVault";
import { pendingLockActions } from "@/lib/pendingLockStore";

export function usePendingLockRecover(
  vault: UseVault,
  ss58: string | null,
  /**
   * `TalkStake.AllowedStake`. `null` = unresolved; only a confirmed ZERO means "not credited yet".
   *
   * CALLERS MUST NOT PASS A SYNTHETIC ZERO. Both AllowedStake watches in the app fall back on a read
   * error, and the session-wide one falls back to `0n` so the write gate stays closed. That zero is a
   * placeholder, not an answer, and feeding it here invents a pending lock for an account credited
   * days ago (`session.postingPowerKnown` is how the caller tells them apart). `null` on error is the
   * correct thing to pass: no record is written, and nothing is claimed.
   */
  postingPower: bigint | null,
): void {
  useEffect(() => {
    if (!ss58) return;
    // Every condition here is a CONFIRMED reading, never an unresolved one. A record invented from a
    // still-loading vault or weight would announce a wait that may not exist.
    if (postingPower === null || postingPower > 0n) return;
    if (!vault.lockedKnown) return;
    if (!vault.locked || vault.locked <= 0n) return;
    if (!vault.lockedTxHash) return;
    // `recover` is a no-op when any record already exists, so a real submit-time record (which carries
    // a slot and a true ETA) can never be overwritten by this weaker one.
    pendingLockActions.recover(ss58, vault.lockedTxHash);
  }, [ss58, postingPower, vault.lockedKnown, vault.locked, vault.lockedTxHash]);
}
