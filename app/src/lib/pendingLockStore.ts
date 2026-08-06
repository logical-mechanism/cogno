"use client";

// pendingLockStore — device-local record of an in-flight vault lock whose posting weight the app-chain
// has NOT yet credited. This exists because there is a genuine, deliberate lag between an L1 lock
// confirming on Cardano and the chain observing it: the observer only reads Cardano history older than
// its stability window (StabilitySlots — ~10 min on preprod, ~36 h at the mainnet setting), so a
// just-locked account cannot post until the observed frontier passes the lock's Cardano slot. Without a
// persisted record the "just locked, now crediting" state lived only in ephemeral useVault React state
// (it died on navigate/reload), so the moment a user left /welcome the timeline cold-greeted them with
// "Lock ADA to post" — telling someone who just locked to lock again.
//
// Keyed by ss58 (the posting account) so a relock overwrites the prior record and the exit-then-relock
// case reuses the same machinery. Cross-tab synced (via the shared store factory) so a lock recorded in
// one tab isn't invisible to another already-open tab. Device-local by design (nothing on-chain, nothing
// across devices): the AUTHORITATIVE credit signal is on-chain (TalkStake.AllowedStake > 0); this record
// only lets the UI show a pending/ETA state until that lands.

import { useSyncExternalStore } from "react";
import { createPersistentStore } from "./persistentStore";

const KEY = "cg-pending-locks";
const EMPTY: PendingLockMap = {};

export interface PendingLock {
  /** the Cardano lock tx hash (used to link the tx from the pending notice). */
  txHash: string;
  /** when the lock was submitted (ms) — drives the "overdue" nudge if it never credits. */
  submittedAtMs: number;
  /**
   * The lock tx's Cardano slot: the frontier value at which this lock's weight becomes authoritative.
   * Null only when it could not be resolved at submit (chain unreachable), which leaves the no-ETA
   * "confirming" path in place.
   *
   * DERIVED FROM THE CHAIN, NOT FROM A PROVIDER. It is written once at submit by `usePendingLockSync`
   * as `frontier + stabilitySlots` (see `estimateLockSlot`). It used to be resolved by polling
   * Blockfrost every 15 s per client until the tx confirmed — on a build-time NEXT_PUBLIC_ project id
   * shared by every visitor, so a signup spike exhausted one quota for everybody at once. Records
   * written by that older build carry a Blockfrost-observed slot here and stay valid: both are the same
   * quantity and both feed the same `frontier >= lockSlot` comparison.
   */
  lockSlot: number | null;
  /**
   * This record was REBUILT from chain state on a device that never saw the lock submitted, rather
   * than written at submit time. It exists so the app stops telling someone whose ADA is already
   * locked that they have none.
   *
   * It changes what may be claimed. A recovered record has no submit-time frontier, so there is no
   * honest ETA: we know a lock exists, not when it landed. Estimating from the CURRENT frontier would
   * overstate the wait by up to a full stability window (36 h at the mainnet setting). More
   * importantly it must never go "overdue", because that status asserts "this lock still has not
   * credited" and we have no idea how long it has been waiting. Narrating an open-ended wait is the
   * only truthful option.
   */
  recovered?: boolean;
}

type PendingLockMap = Record<string, PendingLock>;

/**
 * How long a record may sit without its Cardano slot resolving before the app stops treating it as a
 * live lock. Mirrors `usePendingCapacity`'s confirm timeout, and is the only wall-clock input to
 * {@link shouldClearPendingLock}. Reached far more rarely now that the slot is resolved from the chain
 * at submit rather than by waiting on a third-party provider to see the tx.
 */
export const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

export interface ClearPendingLockInput {
  /** The persisted record for this account, or null when there is none. */
  record: Pick<PendingLock, "lockSlot" | "submittedAtMs" | "recovered"> | null;
  /** `TalkStake.AllowedStake` for this account. `null` = not resolved yet. */
  allowedStake: bigint | null;
  /** `CardanoObserver.LastReference.slot` — how far the observer has read. `null` = not resolved. */
  frontier: bigint | null;
  nowMs: number;
}

/**
 * Has this lock been credited, so the pending record can go?
 *
 * THE BUG THIS FIXES. The rule used to be "AllowedStake > 0", full stop — which treats a weight written
 * for a PRIOR lock as authoritative about a NEWER one. Exit the vault and relock inside the observer's
 * stability window and `AllowedStake` is still positive from the lock you just exited, so the fresh
 * record was destroyed the instant it was written. The observer then catches up, the weight drops to
 * zero, and with no record left the app tells someone who has just locked 100 ADA that they have no
 * posting power and should lock some. A factual negative about the user's own money.
 *
 * The weight only says anything about THIS lock once the observer has read past the lock's own slot,
 * which is what `frontier >= lockSlot` means. Before that the two are simply about different deposits.
 *
 * The confirm-timeout arm is still needed: with no slot resolved there is nothing to compare, so a
 * record that has aged out of the confirm window while the account demonstrably has weight is stale
 * (the tx never landed, or the chain was unreachable at submit) and must not pin the UI forever.
 */
export function shouldClearPendingLock(input: ClearPendingLockInput): boolean {
  const { record, allowedStake, frontier, nowMs } = input;
  if (!record) return false;
  // Unresolved, or no credit at all → nothing has been demonstrated.
  if (allowedStake === null || allowedStake <= 0n) return false;
  // A recovered record has no slot and no meaningful submit time, so the confirm-timeout arm below
  // would expire it on a 5-minute clock that measures nothing. Clear it on the credit alone: that is
  // weaker than the frontier check, but the case it guards (a stale positive from a PRIOR lock inside
  // the same window) needs a submit time to reason about, which this record does not have.
  if (record.recovered) return true;
  if (record.lockSlot != null) {
    // `frontier === null` is "we cannot tell yet", never "it has not passed". Not clearing is the safe
    // direction: the status already reads as credited off AllowedStake, and the next frontier emission
    // resolves it for real.
    return frontier !== null && frontier >= BigInt(record.lockSlot);
  }
  return nowMs - record.submittedAtMs > CONFIRM_TIMEOUT_MS;
}

/**
 * Is the credit question currently UNANSWERABLE, rather than answered "no"?
 *
 * `shouldClearPendingLock` returning false covers two situations that are not the same claim. One is
 * "this lock has not credited yet" — the ordinary wait. The other is "a positive weight exists but the
 * observer frontier has not resolved", so we cannot attribute that weight to this lock or to a prior
 * one. Refusing to clear is the safe direction for the RECORD either way.
 *
 * It is not safe for the "overdue" nudge, which asserts the opposite of what it knows: it tells a user
 * their lock looks stuck and offers to dismiss it. `usePendingCapacity` sets `frontier = null` on ANY
 * `LastReference` read error, and an errored rxjs subscription is terminated — nothing re-subscribes
 * until `api` or the account changes. So one transient frontier error on an account whose lock HAS
 * credited pinned it, silently and for the rest of the session, on a false "it never landed". Gate the
 * nudge on this being false and the wait simply keeps narrating until the frontier comes back.
 */
export function pendingLockCreditIndeterminate(input: ClearPendingLockInput): boolean {
  const { record, allowedStake, frontier } = input;
  if (!record || record.lockSlot == null) return false;
  return allowedStake !== null && allowedStake > 0n && frontier === null;
}

function parse(raw: string | null): PendingLockMap {
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: PendingLockMap = {};
  for (const [ss58, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.txHash !== "string" || typeof r.submittedAtMs !== "number") continue;
    // isSafeInteger, not just `typeof`. This reaches `BigInt()` on the RENDER path, and BigInt throws
    // RangeError on 1.5 and on Infinity (what JSON.parse gives for 1e999) — so tampered or corrupted
    // storage took every surface mounting usePendingCapacity into error.tsx on first render, including
    // the only surfaces that could clear the record. It never self-healed; "Try again" re-threw.
    const lockSlot =
      typeof r.lockSlot === "number" && Number.isSafeInteger(r.lockSlot) && r.lockSlot >= 0
        ? r.lockSlot
        : null;
    out[ss58] = {
      txHash: r.txHash,
      submittedAtMs: r.submittedAtMs,
      lockSlot,
      ...(r.recovered === true ? { recovered: true } : {}),
    };
  }
  return out;
}

const store = createPersistentStore<PendingLockMap>({
  key: KEY,
  empty: EMPTY,
  parse,
  serialize: (v) => JSON.stringify(v),
  crossTab: true, // a lock recorded/cleared in another tab must reflect here (else a stale "Lock ADA" nag)
});

export const pendingLockActions = {
  /** Record a fresh lock for `ss58`. Dedup by txHash: re-recording the SAME tx (a re-render) keeps the
   *  original clock + resolved slot; a NEW tx (relock) replaces the record and restarts the clock. */
  record(ss58: string, txHash: string): void {
    const cache = store.read();
    const existing = cache[ss58];
    if (existing && existing.txHash === txHash) return;
    store.commit({ ...cache, [ss58]: { txHash, submittedAtMs: Date.now(), lockSlot: null } });
  },
  /** Fill in the lock's credit slot, derived from the observation frontier at submit. One shot. */
  setLockSlot(ss58: string, txHash: string, lockSlot: number): void {
    const cache = store.read();
    const existing = cache[ss58];
    if (!existing || existing.txHash !== txHash || existing.lockSlot === lockSlot) return;
    store.commit({ ...cache, [ss58]: { ...existing, lockSlot } });
  },
  /**
   * Rebuild a record from an on-chain vault UTxO, for a device that never saw the lock submitted.
   * A no-op when any record already exists: one written at submit carries a real slot and a real ETA,
   * and must never be downgraded to this.
   */
  recover(ss58: string, txHash: string): void {
    const cache = store.read();
    if (cache[ss58]) return;
    store.commit({
      ...cache,
      [ss58]: { txHash, submittedAtMs: Date.now(), lockSlot: null, recovered: true },
    });
  },
  /** Drop the pending record (weight credited, exited, or dismissed). */
  clear(ss58: string): void {
    const cache = store.read();
    if (!cache[ss58]) return;
    const next = { ...cache };
    delete next[ss58];
    store.commit(next);
  },
};

/** The pending lock for `ss58` (null when none). Subscribes, so the caller re-renders on any change. */
export function usePendingLock(ss58: string | null): PendingLock | null {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return ss58 ? (snap[ss58] ?? null) : null;
}
