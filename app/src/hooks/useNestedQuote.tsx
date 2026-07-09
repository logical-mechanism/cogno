"use client";

// useNestedQuote — a session-lived, shared cache mapping a post id to the id of the post IT quotes
// (or null). It powers the subtle "Quoted post →" pill on a QuotedPostEmbed: the node feed API's
// one-level `quoted` summary drops the inner post's own `quote` field, so a quote-of-a-quote is
// indistinguishable from a plain quote until we do this one extra keyed read (`readPostQuoteId`).
//
// WHY A SHARED PROVIDER (mirrors useReputation): a quoted post recurs across surfaces (home / thread /
// profile / search) and the same id can be embedded by several posts; keying the cache by post id —
// shared app-wide — means each quoted post costs exactly ONE read no matter how many cards embed it,
// and a lookup done on Home is already warm when you open a thread. QuotedPostEmbed consumes it as a
// leaf, so PostCard stays presentational and imports no reader.
//
// READS: POINT reads of `Microblog.Posts[id].quote` per DISTINCT embedded post, BATCHED (a microtask
// coalesces every id registered in the same tick into ONE `Promise.all`) and cached for the session. A
// post's `quote` is immutable, so the cache never goes stale. A failed read is dropped (no pill), never
// thrown. Quote posts are rare, so this adds at most a handful of reads per page.

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
import { readPostQuoteId } from "@/lib/chain/reads";

interface NestedQuoteCtx {
  /** Resolved inner-quote ids, keyed by the embedded post id (as a string). Absent ⇒ unknown/loading. */
  inner: Map<string, bigint | null>;
  /** Register an embedded post id for a batched, cached lookup (idempotent; safe to call every render). */
  request: (id: bigint) => void;
}

const NestedQuoteContext = createContext<NestedQuoteCtx | null>(null);

export function NestedQuoteProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const [inner, setInner] = useState<Map<string, bigint | null>>(new Map());

  // Reach the LATEST api from the deferred (microtask) flush closure without re-subscribing on identity.
  const apiRef = useRef(api);
  apiRef.current = api;
  const requested = useRef<Set<string>>(new Set()); // committed to a fetch (in-flight or resolved)
  const queue = useRef<Set<string>>(new Set()); // registered, waiting for the next batch
  const flushScheduled = useRef(false);
  const mounted = useRef(true);
  // Re-arm `mounted` on the SETUP pass, not just cleanup: React 19 StrictMode (on in `next dev`)
  // double-invokes mount → cleanup → remount. A cleanup-only body would leave `mounted` stuck `false`,
  // so every resolved batch's `setInner` (guarded on `mounted.current`) would be swallowed and no pill
  // would ever appear while developing.
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
    for (const k of batch) requested.current.add(k);
    void Promise.all(
      batch.map(async (key) => {
        try {
          const innerId = await readPostQuoteId(api0, BigInt(key));
          return [key, innerId] as const;
        } catch {
          // Read failed — uncommit so this id is retried the next time an embed for it MOUNTS
          // (a scroll-back or reload refetches). An already-mounted embed won't auto-retry, which is
          // fine: its no-pill state is visually identical to the common "quotes nothing" case.
          requested.current.delete(key);
          return null;
        }
      }),
    ).then((entries) => {
      if (!mounted.current) return;
      const got = entries.filter((e): e is readonly [string, bigint | null] => e !== null);
      if (got.length === 0) return;
      setInner((prev) => {
        const next = new Map(prev);
        for (const [key, id] of got) next.set(key, id);
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
    (id: bigint) => {
      const key = String(id);
      if (requested.current.has(key) || queue.current.has(key)) return;
      queue.current.add(key);
      scheduleFlush();
    },
    [scheduleFlush],
  );

  // When the socket connects (api null → ready), fetch anything registered while it was still offline.
  useEffect(() => {
    if (api && queue.current.size > 0) scheduleFlush();
  }, [api, scheduleFlush]);

  const value = useMemo<NestedQuoteCtx>(() => ({ inner, request }), [inner, request]);
  return <NestedQuoteContext.Provider value={value}>{children}</NestedQuoteContext.Provider>;
}

/**
 * The id of the post that `id` itself quotes (a quote-of-a-quote), or `null` when it quotes nothing /
 * is unknown / still loading. Registering the id is a side effect, so an embed that mounts triggers a
 * batched read; the result lands on a later render once the batch resolves. `request` is a STABLE
 * reference (unchanged when `inner` updates), so this effect re-runs only when the id changes.
 */
export function useNestedQuote(id: bigint | undefined): bigint | null {
  const ctx = useContext(NestedQuoteContext);
  const request = ctx?.request;
  useEffect(() => {
    if (id !== undefined && request) request(id);
  }, [id, request]);
  return id !== undefined && ctx ? (ctx.inner.get(String(id)) ?? null) : null;
}
