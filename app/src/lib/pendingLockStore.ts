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
// case reuses the same machinery. Device-local by design (nothing on-chain, nothing across devices):
// the AUTHORITATIVE credit signal is on-chain (TalkStake.AllowedStake > 0); this record only lets the
// UI show a pending/ETA state until that lands. Mirrors bookmarkStore/muteStore (module cache +
// listeners + useSyncExternalStore).

import { useSyncExternalStore } from "react";

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

let cache: PendingLockMap = load();
const listeners = new Set<() => void>();

function load(): PendingLockMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
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
  } catch {
    return {};
  }
}

function commit(next: PendingLockMap): void {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota exceeded / storage disabled → keep the in-memory map only */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): PendingLockMap {
  return cache;
}
function getServerSnapshot(): PendingLockMap {
  return EMPTY;
}

export const pendingLockActions = {
  /** Record a fresh lock for `ss58`. Dedup by txHash: re-recording the SAME tx (a re-render) keeps the
   *  original clock + resolved slot; a NEW tx (relock) replaces the record and restarts the clock. */
  record(ss58: string, txHash: string): void {
    const existing = cache[ss58];
    if (existing && existing.txHash === txHash) return;
    commit({ ...cache, [ss58]: { txHash, submittedAtMs: Date.now(), lockSlot: null } });
  },
  /** Fill in the lock tx's Cardano slot once Blockfrost confirms it in a block. */
  setLockSlot(ss58: string, txHash: string, lockSlot: number): void {
    const existing = cache[ss58];
    if (!existing || existing.txHash !== txHash || existing.lockSlot === lockSlot) return;
    commit({ ...cache, [ss58]: { ...existing, lockSlot } });
  },
  /** Drop the pending record (weight credited, exited, or dismissed). */
  clear(ss58: string): void {
    if (!cache[ss58]) return;
    const next = { ...cache };
    delete next[ss58];
    commit(next);
  },
};

/** The pending lock for `ss58` (null when none). Subscribes, so the caller re-renders on any change. */
export function usePendingLock(ss58: string | null): PendingLock | null {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return ss58 ? (snap[ss58] ?? null) : null;
}
