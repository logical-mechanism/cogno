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
import {
  usePendingLock,
  pendingLockActions,
  shouldClearPendingLock,
  pendingLockCreditIndeterminate,
  CONFIRM_TIMEOUT_MS,
} from "@/lib/pendingLockStore";
import { readObserverConfig, slotToUnixSec, type ObserverConfig } from "@/lib/chain/observer";

// Grace past the theoretical unlock before we call a lock "overdue": the credit lands a little AFTER the
// frontier passes the lock slot (one app-chain block + this node's db-sync index lag), so a small margin
// avoids a false "stuck" while it is genuinely finishing.
const OVERDUE_GRACE_MS = 3 * 60 * 1000;
// CONFIRM_TIMEOUT_MS lives in pendingLockStore beside `shouldClearPendingLock`, which is its other
// consumer: if the lock tx's Cardano slot never resolves (Blockfrost can't return it on this tier, or
// the tx never confirmed), don't sit in "confirming" forever — fall to the "overdue" nudge + dismiss.

export type PendingCapacityStatus =
  | { kind: "none" }
  | {
      kind: "confirming";
      /**
       * This record was REBUILT from an on-chain vault UTxO (pendingLockStore's `recovered`), on a
       * device that watched nothing submit. It is carried out to the view because the two are not the
       * same claim and must not read the same. A submit-time record can honestly say "Lock submitted /
       * confirming on Cardano…" with a spinner: we saw it go, seconds ago. A recovered one cannot. It
       * knows only that locked ADA exists and has not been credited — not that anything was just sent,
       * and not how long the wait has left, since its clock starts when this device NOTICED.
       *
       * It also never leaves this state: nothing fills a recovered record's `lockSlot` (only
       * `usePendingLockSync` writes one, at submit, on the other device), and it is exempt from the
       * confirm-timeout for the reason above. So whatever this renders is what that user sees until
       * the credit lands — for up to a full stability window, and forever if the lock never credits.
       * A permanent spinner over a sentence that is false on its face is the wrong thing to leave there.
       */
      recovered: boolean;
    }
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
  const pending = !!record;
  // Ticks once a second while a lock is pending (the countdown, the confirm/overdue timeouts, AND the
  // clear decision below — sharing one clock is what stops the record and the rendered status drifting).
  const now = useNowTick(record ? 1000 : null);

  const [cfg, setCfg] = useState<ObserverConfig | null>(null);
  const [frontier, setFrontier] = useState<bigint | null>(null);
  const [enforcing, setEnforcing] = useState(true);

  // Observer policy — fixed per runtime; only needed to TIME a pending lock, so read it lazily WHILE one
  // is pending. This also avoids a CardanoObserverApi round-trip on every composer/settings mount for the
  // common case of a user who can already post and has no pending lock.
  useEffect(() => {
    if (!api || !pending) {
      setCfg(null);
      return;
    }
    let cancelled = false;
    readObserverConfig(api)
      .then((c) => !cancelled && setCfg(c))
      .catch(() => !cancelled && setCfg(null));
    return () => {
      cancelled = true;
    };
  }, [api, pending]);

  // Watch the observation frontier only while a lock is actually pending.
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

  // WATCH EnforceWeight (not a one-shot read) while a lock is pending: an emergency freeze that begins
  // DURING the wait must flip `enforcing` so the UI stops ticking a false countdown and does NOT then show
  // a false "overdue" nudge (the overdue gate is `&& enforcing` for exactly this reason). Idle → default
  // to enforcing; there's no pending lock to mistime.
  useEffect(() => {
    if (!api || !pending) {
      setEnforcing(true);
      return;
    }
    const sub = api.query.CardanoObserver.EnforceWeight.watchValue({ at: "best" }).subscribe(
      ({ value }) => setEnforcing(value),
      () => setEnforcing(true), // read error → assume enforcing (keep the overdue gate conservative)
    );
    return () => sub.unsubscribe();
  }, [api, pending]);

  // Credited → drop the pending record. The rule is `shouldClearPendingLock` (lib/pendingLockStore):
  // a positive AllowedStake is only ABOUT this lock once the observer has read past the lock's slot.
  // Clearing on a bare `> 0` destroyed a just-written record whenever the weight was still the PRIOR
  // lock's — the exit-then-relock window — and left the app telling someone who had just locked
  // 100 ADA that they had none. It is fixed here rather than at the call sites because there are five,
  // and the fifth (NoPostingPowerNotice, via useCapacity) is the one that renders the false claim.
  useEffect(() => {
    if (!ss58 || !record) return;
    if (shouldClearPendingLock({ record, allowedStake, frontier, nowMs: now })) {
      pendingLockActions.clear(ss58);
    }
  }, [ss58, record, allowedStake, frontier, now]);

  // NO PROVIDER POLL HERE. This used to poll Blockfrost every 15 s, per client, for the whole
  // confirmation window, to learn the lock tx's Cardano slot. The project id is a build-time
  // NEXT_PUBLIC_ value baked into the static bundle, so every visitor shares one quota — which makes a
  // signup spike a self-inflicted denial of service: the burst limit trips, `fetchTxSlot` starts
  // returning null for everyone at once, and every pending lock in the world falls through to the
  // no-ETA path together. The slot is now derived once, at submit, from the observation frontier the
  // chain already publishes (`estimateLockSlot`, written by `usePendingLockSync`). Do not reintroduce a
  // provider call on this path: nothing here needs an answer only Blockfrost can give.

  if (!record) return { kind: "none" };
  // Credited AND the credit demonstrably belongs to THIS lock — same rule as the clear effect above, so
  // the status and the record can never disagree. A stale-positive weight from a prior lock keeps the
  // pending narration running instead of collapsing it to "all set" and then to "lock ADA".
  if (shouldClearPendingLock({ record, allowedStake, frontier, nowMs: now })) return { kind: "none" };
  // "Overdue" is the one status that asserts a NEGATIVE ("this lock still hasn't credited"), and the
  // frontier is what establishes it. With a positive weight and no frontier the app cannot tell whose
  // credit that is, so it must not make the claim — it keeps narrating the wait instead, and the next
  // frontier emission resolves it for real. See `pendingLockCreditIndeterminate`.
  const cantTell = pendingLockCreditIndeterminate({ record, allowedStake, frontier, nowMs: now });
  if (record.lockSlot == null || !cfg) {
    // Stuck confirming too long → an honest exit (can't compute an ETA without the lock slot).
    //
    // A RECOVERED record is exempt. It was rebuilt from an on-chain vault UTxO on a device that never
    // saw the lock submitted, so its `submittedAtMs` is when we NOTICED the lock, not when it was
    // placed. Ageing that out would announce "taking longer than expected" five minutes after the
    // user opened the app, about a lock that may have landed seconds ago. "Overdue" is the one status
    // that asserts a negative, and here there is nothing to assert it from.
    const ageable = !record.recovered;
    if (ageable && now - record.submittedAtMs > CONFIRM_TIMEOUT_MS && !cantTell) {
      return { kind: "overdue", txHash: record.txHash };
    }
    return { kind: "confirming", recovered: record.recovered === true };
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

  // Well past the expected unlock and still uncredited (not merely frozen, and actually established) →
  // an honest exit.
  if (etaMs < -OVERDUE_GRACE_MS && enforcing && !cantTell) {
    return { kind: "overdue", txHash: record.txHash };
  }

  return { kind: "crediting", unlockAtMs, etaMs, progress, frozen: !enforcing };
}
