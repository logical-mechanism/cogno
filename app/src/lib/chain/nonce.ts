"use client";

// Client-side nonce manager for rapid sequential writes.
//
// PAPI defaults a tx's nonce to the account nonce read at the FINALIZED block. So two writes signed
// within the same finalization window (e.g. a post immediately followed by a follow) are both handed
// the SAME nonce → the later one is rejected `Invalid: Stale`. This hands out MONOTONIC nonces per
// account for the writes currently in flight, seeded from the BEST-block chain nonce (so it lines up
// with settling on best-block inclusion), and RESYNCS from chain the moment the account goes idle —
// which self-heals any drift (a dropped/failed tx, a reorg) without persistent local bookkeeping.

import type { CognoApi } from "@/lib/types";

interface AccountNonce {
  /** Next nonce to hand out; null = unknown → re-read from chain on the next take. */
  next: number | null;
  /** Writes assigned a nonce but not yet settled. When it returns to 0 we resync from chain. */
  inflight: number;
  /** Serializes concurrent takeNonce() calls so the read-modify-write is atomic per account. */
  lock: Promise<void>;
}

const accounts = new Map<string, AccountNonce>();

function getState(ss58: string): AccountNonce {
  let s = accounts.get(ss58);
  if (!s) {
    s = { next: null, inflight: 0, lock: Promise.resolve() };
    accounts.set(ss58, s);
  }
  return s;
}

/**
 * Reserve the next nonce for a write from `ss58`. Serialized per account so concurrent calls can't
 * read the same base and collide. The caller MUST pair every take with exactly one {@link settleNonce}.
 */
export async function takeNonce(api: CognoApi, ss58: string): Promise<number> {
  const s = getState(ss58);
  // Chain this take onto the per-account lock (the synchronous swap below is atomic in JS's single
  // thread, so each take awaits the previous one's critical section before reading the base nonce).
  const prev = s.lock;
  let release!: () => void;
  s.lock = new Promise<void>((r) => (release = r));
  await prev;
  try {
    let chainNonce = 0;
    try {
      const acct = (await api.query.System.Account.getValue(ss58, { at: "best" })) as {
        nonce: number;
      };
      chainNonce = Number(acct.nonce);
    } catch {
      // A failed read falls back to the local counter (or 0); the tx still validates against chain.
    }
    // The best-block nonce is a floor; the local counter carries any writes already in the pool but
    // not yet in a best block (which the chain read can't see).
    const n = s.next != null ? Math.max(chainNonce, s.next) : chainNonce;
    s.next = n + 1;
    s.inflight += 1;
    return n;
  } finally {
    release();
  }
}

/**
 * Release a nonce reserved by {@link takeNonce} once its write reaches a terminal phase. When the last
 * in-flight write settles, the local counter is cleared so the next take re-reads chain truth (healing
 * any drift from a failed/dropped tx). Idempotent-safe: never drives inflight below 0.
 */
export function settleNonce(ss58: string): void {
  const s = accounts.get(ss58);
  if (!s) return;
  s.inflight = Math.max(0, s.inflight - 1);
  if (s.inflight === 0) s.next = null;
}
