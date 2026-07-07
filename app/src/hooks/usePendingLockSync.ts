"use client";

// usePendingLockSync — bridges a vault action to the persistent pending-lock record. When a LOCK
// submits it records {ss58 → txHash} (so the "crediting" state survives navigate/reload and follows the
// user off /welcome); when an EXIT submits it clears the record (no longer crediting — the symmetric
// weight-drop lag is a separate, deferred concern). Call it wherever a vault lock/exit is triggered
// (the welcome power-ups step and the Settings vault section) — it fires once per new tx.

import { useEffect, useRef } from "react";
import type { UseVault } from "./useVault";
import { pendingLockActions } from "@/lib/pendingLockStore";

export function usePendingLockSync(vault: UseVault, ss58: string | null): void {
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!ss58 || vault.phase !== "submitted" || !vault.txHash) return;
    if (handled.current === vault.txHash) return; // already handled this tx (re-render)
    handled.current = vault.txHash;
    if (vault.lastAction === "lock") pendingLockActions.record(ss58, vault.txHash);
    else if (vault.lastAction === "exit") pendingLockActions.clear(ss58);
  }, [vault.phase, vault.txHash, vault.lastAction, ss58]);
}
