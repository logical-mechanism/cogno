"use client";

// usePendingLockSync — bridges a vault action to the persistent pending-lock record. When a LOCK
// submits it records {ss58 → txHash} (so the "crediting" state survives navigate/reload and follows the
// user off /welcome); when an EXIT submits it clears the record (no longer crediting — the symmetric
// weight-drop lag is a separate, deferred concern). Call it wherever a vault lock/exit is triggered
// (the welcome power-ups step and the Settings vault section) — it fires once per new tx.
//
// It also resolves the record's `lockSlot`, ONCE, from the chain. That used to be a 15-second Blockfrost
// poll running per client for the whole confirmation window; see `estimateLockSlot` for why that was a
// self-DoS waiting to happen and how the observation frontier answers the same question for free.

import { useEffect, useRef } from "react";
import type { UseVault } from "./useVault";
import type { CognoApi } from "@/lib/types";
import { pendingLockActions } from "@/lib/pendingLockStore";
import { estimateLockSlot } from "@/lib/chain/observer";

export function usePendingLockSync(vault: UseVault, ss58: string | null, api: CognoApi | null): void {
  // TWO refs, not one. `handled` dedupes the RECORD/CLEAR side effect (which must fire once per tx);
  // `slotResolved` dedupes the slot read, which may need more than one attempt. A single ref made the
  // slot read strictly one-shot: submit while the socket happened to be down and the record kept
  // `lockSlot: null` forever, because every later run of this effect returned at the `handled` check
  // before reaching the estimate. Five minutes later `usePendingCapacity` aged that null-slot record
  // out of CONFIRM_TIMEOUT_MS and told the user their lock was "taking longer than expected" — about a
  // perfectly healthy lock five minutes into a ten-minute (preprod) or 36-hour (mainnet) window.
  const handled = useRef<string | null>(null);
  const slotResolved = useRef<string | null>(null);
  useEffect(() => {
    if (!ss58 || vault.phase !== "submitted" || !vault.txHash) return;
    const txHash = vault.txHash;
    const first = handled.current !== txHash;
    handled.current = txHash;
    // Exhaustive BY OMISSION, deliberately: any other action (today `"exit-legacy"`, which empties a
    // retired vault script) must move neither half of this record. Do not turn this into a switch with
    // a default that records or clears.
    if (vault.lastAction === "lock") {
      // Record FIRST, unconditionally, and only on the first pass for this tx. The pending UI must
      // appear the instant the tx is submitted, and it must not depend on a chain read succeeding — a
      // record with a null lockSlot still narrates "confirming" and still survives a reload.
      if (first) pendingLockActions.record(ss58, txHash);
      // Then fill the slot. Still not a poll — the frontier is available whenever the chain is, so the
      // only way this fails is a socket that is down, and the effect already re-runs when `api`
      // changes. That re-run is the retry. `slotResolved` latches only on SUCCESS, so a reconnect gets
      // another attempt and a resolved slot is never re-read.
      if (api && slotResolved.current !== txHash) {
        void estimateLockSlot(api).then((slot) => {
          if (slot == null) return;
          slotResolved.current = txHash;
          pendingLockActions.setLockSlot(ss58, txHash, slot);
        });
      }
    } else if (vault.lastAction === "exit" && first) {
      pendingLockActions.clear(ss58);
    }
  }, [vault.phase, vault.txHash, vault.lastAction, ss58, api]);
}
