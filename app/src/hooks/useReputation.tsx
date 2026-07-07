"use client";

// useReputation — a session-lived, shared cache of each account's NET stake-weighted community
// reputation (`Microblog.AccountVoteTally`: up_weight − down_weight; may be negative). It powers the
// small reputation badge next to an author's name on every post header (a quick "good actor vs troll"
// signal, so you don't have to open the profile), and is the seam a future "hide low-reputation"
// timeline filter can read from.
//
// WHY A SHARED PROVIDER (not per-surface props): a post's author reputation is a per-ACCOUNT value that
// recurs across dozens of posts and every surface (home / thread / profile / search). Keying the cache
// by account — shared app-wide — means the same author costs exactly ONE read no matter how many of
// their posts are on screen, and a score fetched on Home is already warm when you open a thread. A leaf
// `<ReputationBadge address>` consumes it, mirroring how the sibling `<ProfileHoverCard>` already reads
// from the session inside the header (so `PostCard` itself stays presentational, importing no reader).
//
// READS: POINT reads of `AccountVoteTally` per DISTINCT author, BATCHED (a microtask coalesces every
// author registered in the same tick — e.g. a whole feed page mounting — into ONE `Promise.all`) and
// cached for the session. New authors scrolling into view are fetched on demand; a cached author is
// never re-read. Values are a COARSE hint, so session-cache staleness (a vote cast elsewhere) is
// acceptable — a full reload refreshes it. A failed read is dropped (badge stays hidden), never thrown.

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
import { readAccountVoteTally } from "@/lib/chain/social-reads";
import type { Ss58 } from "@/lib/types";

interface ReputationCtx {
  /** Resolved net reputation scores, keyed by ss58. Absent ⇒ unknown / still loading. */
  scores: Map<string, bigint>;
  /** Register an author for a batched, cached reputation read (idempotent; safe to call every render). */
  request: (address: Ss58) => void;
}

const ReputationContext = createContext<ReputationCtx | null>(null);

export function ReputationProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const [scores, setScores] = useState<Map<string, bigint>>(new Map());

  // Reach the LATEST api from the deferred (microtask) flush closure without re-subscribing on identity.
  const apiRef = useRef(api);
  apiRef.current = api;
  const requested = useRef<Set<string>>(new Set()); // committed to a fetch (in-flight or resolved)
  const queue = useRef<Set<string>>(new Set()); // registered, waiting for the next batch
  const flushScheduled = useRef(false);
  const mounted = useRef(true);
  // Re-arm `mounted` on the SETUP pass, not just the cleanup: React 19 StrictMode (on in `next dev`)
  // double-invokes this effect mount → cleanup → remount. A cleanup-only body would leave `mounted`
  // stuck `false` after that dev-time cleanup, so every resolved batch's `setScores` (guarded on
  // `mounted.current`) would be silently swallowed and no badge would ever appear while developing.
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
          const t = await readAccountVoteTally(api0, addr);
          return [addr, t.score] as const;
        } catch {
          // Read failed — uncommit so the author is retried the next time a badge for them MOUNTS
          // (a scroll-back or a reload refetches). An already-mounted badge won't auto-retry, which is
          // fine for a coarse hint: its hidden state is visually identical to the common net-zero case.
          requested.current.delete(addr);
          return null;
        }
      }),
    ).then((entries) => {
      if (!mounted.current) return;
      const got = entries.filter((e): e is readonly [string, bigint] => e !== null);
      if (got.length === 0) return;
      setScores((prev) => {
        const next = new Map(prev);
        for (const [addr, score] of got) next.set(addr, score);
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

  const value = useMemo<ReputationCtx>(() => ({ scores, request }), [scores, request]);
  return <ReputationContext.Provider value={value}>{children}</ReputationContext.Provider>;
}

/**
 * The cached net reputation score for one author (or `null` while unknown / loading / outside the
 * provider). Registering the address is a side effect, so a badge that mounts triggers a batched read;
 * the score lands on a later render once the batch resolves. `request` is a STABLE reference (it does
 * not change when `scores` updates), so this effect re-runs only when the address changes — never in a
 * loop as scores fill in.
 */
export function useAuthorReputation(address: string | undefined): bigint | null {
  const ctx = useContext(ReputationContext);
  const request = ctx?.request;
  useEffect(() => {
    if (address && request) request(address);
  }, [address, request]);
  return address && ctx ? (ctx.scores.get(address) ?? null) : null;
}
