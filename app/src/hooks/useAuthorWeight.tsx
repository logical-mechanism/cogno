"use client";

// useAuthorWeight — a session-lived, shared cache of each account's Cardano-sourced talk WEIGHT
// (`TalkStake.VotingPower`: the account's total proven Cardano stake, in lovelace; may be 0). It powers
// the stake-tier avatar ring (via `useStakeRing`), a quiet "how much skin in the game" trust signal
// shown wherever an author's avatar renders.
//
// WHY VotingPower (not AllowedStake): `AllowedStake` is the flat 100-ADA posting deposit — uniform
// across every staked account, so it can't tier anyone. `VotingPower` varies (the observer-written
// epoch stake of the bound credential), so it's the signal that actually distinguishes accounts.
//
// WHY A SHARED PROVIDER (mirrors useReputation exactly): an author's weight is a per-ACCOUNT value that
// recurs across dozens of posts and every surface. Keying the cache by account — shared app-wide —
// means the same author costs exactly ONE read no matter how many avatars are on screen, and a weight
// fetched on Home is already warm when you open a thread.
//
// READS: POINT reads of `VotingPower` per DISTINCT author, BATCHED (a microtask coalesces every author
// registered in the same tick into ONE `Promise.all`) and cached for the session. Epoch stake changes
// at most once per Cardano epoch, so session-cache staleness is fine — a reload refreshes it. A failed
// read is dropped (no ring), never thrown.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "@/components/Providers";
import { readVotingPower } from "@/lib/chain/social-reads";
import type { Ss58 } from "@/lib/types";

interface AuthorWeightCtx {
  /** Resolved talk weights (lovelace), keyed by ss58. Absent ⇒ unknown / still loading. */
  weights: Map<string, bigint>;
  /** Register an author for a batched, cached weight read (idempotent; safe to call every render). */
  request: (address: Ss58) => void;
}

const AuthorWeightContext = createContext<AuthorWeightCtx | null>(null);

export function AuthorWeightProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const [weights, setWeights] = useState<Map<string, bigint>>(new Map());

  // Reach the LATEST api from the deferred (microtask) flush closure without re-subscribing on identity.
  const apiRef = useRef(api);
  apiRef.current = api;
  const requested = useRef<Set<string>>(new Set()); // committed to a fetch (in-flight or resolved)
  const queue = useRef<Set<string>>(new Set()); // registered, waiting for the next batch
  const flushScheduled = useRef(false);
  const mounted = useRef(true);
  // Re-arm `mounted` on the SETUP pass, not just cleanup: React 19 StrictMode (on in `next dev`)
  // double-invokes mount → cleanup → remount. A cleanup-only body would leave `mounted` stuck `false`,
  // so every resolved batch's `setWeights` (guarded on `mounted.current`) would be swallowed and no
  // ring would ever appear while developing.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const flush = useCallback(() => {
    flushScheduled.current = false;
    const api0 = apiRef.current;
    // No socket yet — leave the queue INTACT; the [api] effect re-flushes once the client connects.
    if (!api0 || queue.current.size === 0) return;
    const batch = Array.from(queue.current);
    queue.current.clear();
    for (const a of batch) requested.current.add(a);
    void Promise.all(
      batch.map(async (addr) => {
        try {
          const w = await readVotingPower(api0, addr);
          return [addr, w] as const;
        } catch {
          // Read failed — uncommit so the author is retried the next time an avatar for them MOUNTS
          // (a scroll-back or reload refetches). An already-mounted avatar won't auto-retry, which is
          // fine: its no-ring state is visually identical to the common zero-stake case.
          requested.current.delete(addr);
          return null;
        }
      }),
    ).then((entries) => {
      if (!mounted.current) return;
      const got = entries.filter((e): e is readonly [string, bigint] => e !== null);
      if (got.length === 0) return;
      setWeights((prev) => {
        const next = new Map(prev);
        for (const [addr, w] of got) next.set(addr, w);
        return next;
      });
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    queueMicrotask(flush);
  }, [flush]);

  const request = useCallback(
    (address: Ss58) => {
      if (!address || requested.current.has(address) || queue.current.has(address)) return;
      queue.current.add(address);
      scheduleFlush();
    },
    [scheduleFlush],
  );

  // When the socket connects (api null → ready), fetch anything registered while it was still offline.
  useEffect(() => {
    if (api && queue.current.size > 0) scheduleFlush();
  }, [api, scheduleFlush]);

  const value = useMemo<AuthorWeightCtx>(() => ({ weights, request }), [weights, request]);
  return <AuthorWeightContext.Provider value={value}>{children}</AuthorWeightContext.Provider>;
}

/**
 * The cached talk weight (lovelace) for one author (or `null` while unknown / loading / outside the
 * provider). Registering the address is a side effect, so an avatar that mounts triggers a batched
 * read; the weight lands on a later render once the batch resolves. `request` is a STABLE reference
 * (unchanged when `weights` updates), so this effect re-runs only when the address changes.
 */
export function useAuthorWeight(address: string | undefined): bigint | null {
  const ctx = useContext(AuthorWeightContext);
  const request = ctx?.request;
  useEffect(() => {
    if (address && request) request(address);
  }, [address, request]);
  return address && ctx ? (ctx.weights.get(address) ?? null) : null;
}
