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
  /** the Cardano lock tx hash (used to resolve its confirmation slot + to link the tx). */
  txHash: string;
  /** when the lock was submitted (ms) — drives the "overdue" nudge if it never credits. */
  submittedAtMs: number;
  /** the lock tx's Cardano slot, once Blockfrost confirms it in a block; null while still confirming. */
  lockSlot: number | null;
}

type PendingLockMap = Record<string, PendingLock>;

/**
 * How long a record may sit without its Cardano slot resolving before the app stops treating it as a
 * live lock. Mirrors `usePendingCapacity`'s confirm timeout, and is the only wall-clock input to
 * {@link shouldClearPendingLock}.
 */
export const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

export interface ClearPendingLockInput {
  /** The persisted record for this account, or null when there is none. */
  record: Pick<PendingLock, "lockSlot" | "submittedAtMs"> | null;
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
 * (the tx never landed, or Blockfrost could not answer) and must not pin the UI forever.
 */
export function shouldClearPendingLock(input: ClearPendingLockInput): boolean {
  const { record, allowedStake, frontier, nowMs } = input;
  if (!record) return false;
  // Unresolved, or no credit at all → nothing has been demonstrated.
  if (allowedStake === null || allowedStake <= 0n) return false;
  if (record.lockSlot != null) {
    // `frontier === null` is "we cannot tell yet", never "it has not passed". Not clearing is the safe
    // direction: the status already reads as credited off AllowedStake, and the next frontier emission
    // resolves it for real.
    return frontier !== null && frontier >= BigInt(record.lockSlot);
  }
  return nowMs - record.submittedAtMs > CONFIRM_TIMEOUT_MS;
}

function parse(raw: string | null): PendingLockMap {
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: PendingLockMap = {};
  for (const [ss58, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.txHash !== "string" || typeof r.submittedAtMs !== "number") continue;
    const lockSlot = typeof r.lockSlot === "number" ? r.lockSlot : null;
    out[ss58] = { txHash: r.txHash, submittedAtMs: r.submittedAtMs, lockSlot };
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
  /** Fill in the lock tx's Cardano slot once Blockfrost confirms it in a block. */
  setLockSlot(ss58: string, txHash: string, lockSlot: number): void {
    const cache = store.read();
    const existing = cache[ss58];
    if (!existing || existing.txHash !== txHash || existing.lockSlot === lockSlot) return;
    store.commit({ ...cache, [ss58]: { ...existing, lockSlot } });
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
