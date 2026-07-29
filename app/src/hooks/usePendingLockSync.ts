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
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!ss58 || vault.phase !== "submitted" || !vault.txHash) return;
    if (handled.current === vault.txHash) return; // already handled this tx (re-render)
    handled.current = vault.txHash;
    // Exhaustive BY OMISSION, deliberately: any other action (today `"exit-legacy"`, which empties a
    // retired vault script) must move neither half of this record. Do not turn this into a switch with
    // a default that records or clears.
    if (vault.lastAction === "lock") {
      const txHash = vault.txHash;
      // Record FIRST, unconditionally. The pending UI must appear the instant the tx is submitted, and
      // it must not depend on a chain read succeeding — a record with a null lockSlot still narrates
      // "confirming" and still survives a reload.
      pendingLockActions.record(ss58, txHash);
      // Then fill the slot in one read. No retry loop: the frontier is available whenever the chain is,
      // so a failure here means the connection is down, and the next lock/mount resolves it. A null
      // simply leaves the existing no-ETA path in place.
      if (api) {
        void estimateLockSlot(api).then((slot) => {
          if (slot != null) pendingLockActions.setLockSlot(ss58, txHash, slot);
        });
      }
    } else if (vault.lastAction === "exit") {
      pendingLockActions.clear(ss58);
    }
  }, [vault.phase, vault.txHash, vault.lastAction, ss58, api]);
}
