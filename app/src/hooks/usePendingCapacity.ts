"use client";

// usePendingCapacity — turns "I locked ADA but can't post yet" from a silent dead-end into an explained,
// timed pending state. It combines the persisted pending-lock record (pendingLockStore) with the
// on-chain observer state (observer_config + the LastReference frontier + EnforceWeight) and the
// account's live AllowedStake into ONE status the UI renders:
//
//   confirming → waiting for the lock tx to land in a Cardano block (no slot yet)
//   crediting  → confirmed; counting down to the observed frontier reaching the lock slot (live ETA + bar)
//   (credited) → AllowedStake > 0: the record is cleared, status is "none", the surface shows "all set"
//   overdue    → well past the expected window and still uncredited → a "here's your tx" nudge + dismiss
//
// The caller passes the `allowedStake` it already watches so this opens no duplicate subscription. The
// authoritative "you can post" signal stays AllowedStake > 0; this only narrates the wait until then.

import { useEffect, useState } from "react";
import type { CognoApi } from "@/lib/types";
import { usePendingLock, pendingLockActions } from "@/lib/pendingLockStore";
import { readObserverConfig, readEnforceWeight, slotToUnixSec, type ObserverConfig } from "@/lib/chain/observer";
import { fetchTxSlot } from "@/lib/cardano/provider";

// Grace past the theoretical unlock before we call a lock "overdue": the credit lands a little AFTER the
// frontier passes the lock slot (one app-chain block + this node's db-sync index lag), so a small margin
// avoids a false "stuck" while it is genuinely finishing.
const OVERDUE_GRACE_MS = 3 * 60 * 1000;
const CONFIRM_POLL_MS = 15_000;
// If the lock tx's Cardano slot never resolves (Blockfrost can't return it on this tier, or the tx
// never confirmed), don't sit in "confirming" forever — fall to the "overdue" nudge with a dismiss.
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

export type PendingCapacityStatus =
  | { kind: "none" }
  | { kind: "confirming" }
  | {
      kind: "crediting";
      /** wall-clock time posting is expected to unlock (ms). */
      unlockAtMs: number;
      /** ms until unlockAtMs (can go slightly negative right at the end). */
      etaMs: number;
      /** 0..1, from the observed frontier climbing toward the lock slot. */
      progress: number;
      /** observer emergency-frozen (EnforceWeight=false) — it will NOT credit while true. */
      frozen: boolean;
    }
  | { kind: "overdue"; txHash: string };

function useNowTick(activeMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (activeMs == null) return;
    const id = setInterval(() => setNow(Date.now()), activeMs);
    return () => clearInterval(id);
  }, [activeMs]);
  return now;
}

export function usePendingCapacity(
  api: CognoApi | null,
  ss58: string | null,
  allowedStake: bigint | null,
): PendingCapacityStatus {
  const record = usePendingLock(ss58);

  const [cfg, setCfg] = useState<ObserverConfig | null>(null);
  const [frontier, setFrontier] = useState<bigint | null>(null);
  const [enforcing, setEnforcing] = useState(true);

  // Observer policy + enforce flag — fixed/rare per runtime, read once per api.
  useEffect(() => {
    if (!api) {
      setCfg(null);
      return;
    }
    let cancelled = false;
    readObserverConfig(api)
      .then((c) => !cancelled && setCfg(c))
      .catch(() => !cancelled && setCfg(null));
    readEnforceWeight(api)
      .then((e) => !cancelled && setEnforcing(e))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Watch the observation frontier only while a lock is actually pending.
  const pending = !!record;
  useEffect(() => {
    if (!api || !pending) {
      setFrontier(null);
      return;
    }
    // PAPI v2: watchValue emits { block, value } (destructure .value); LastReference is OptionQuery.
    const sub = api.query.CardanoObserver.LastReference.watchValue({ at: "best" }).subscribe(
      ({ value: ref }) => setFrontier(ref ? ref.slot : null),
      () => setFrontier(null),
    );
    return () => sub.unsubscribe();
  }, [api, pending]);

  // Credited → drop the pending record (AllowedStake > 0 is the authoritative "you can post" signal).
  useEffect(() => {
    if (ss58 && record && allowedStake != null && allowedStake > 0n) {
      pendingLockActions.clear(ss58);
    }
  }, [ss58, record, allowedStake]);

  // Resolve the lock tx's Cardano slot once it confirms in a block (poll Blockfrost until it lands).
  const recordTx = record?.txHash;
  const haveSlot = record?.lockSlot != null;
  useEffect(() => {
    if (!ss58 || !recordTx || haveSlot) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      void fetchTxSlot(recordTx).then((slot) => {
        if (cancelled) return;
        if (slot != null) pendingLockActions.setLockSlot(ss58, recordTx, slot);
        else timer = setTimeout(poll, CONFIRM_POLL_MS);
      });
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ss58, recordTx, haveSlot]);

  // Tick once a second while a lock is pending (drives the countdown + the confirm/overdue timeouts).
  const now = useNowTick(record ? 1000 : null);

  if (!record) return { kind: "none" };
  if (allowedStake != null && allowedStake > 0n) return { kind: "none" }; // credited; the effect clears the record
  if (record.lockSlot == null || !cfg) {
    // Stuck confirming too long → an honest exit (can't compute an ETA without the lock slot).
    if (now - record.submittedAtMs > CONFIRM_TIMEOUT_MS) return { kind: "overdue", txHash: record.txHash };
    return { kind: "confirming" };
  }

  const stability = Number(cfg.stabilitySlots);
  const unlockAtMs = slotToUnixSec(BigInt(record.lockSlot + stability), cfg) * 1000;
  const etaMs = unlockAtMs - now;

  // Progress from the observed frontier climbing from ~(lockSlot − stability) up to lockSlot; fall back
  // to a wall-clock estimate only if the frontier read is momentarily unavailable.
  const progress =
    frontier != null && stability > 0
      ? Math.min(1, Math.max(0, (Number(frontier) - record.lockSlot + stability) / stability))
      : Math.min(1, Math.max(0, 1 - etaMs / (stability * 1000)));

  // Well past the expected unlock and still uncredited (and not merely frozen) → an honest exit.
  if (etaMs < -OVERDUE_GRACE_MS && enforcing) {
    return { kind: "overdue", txHash: record.txHash };
  }

  return { kind: "crediting", unlockAtMs, etaMs, progress, frozen: !enforcing };
}
