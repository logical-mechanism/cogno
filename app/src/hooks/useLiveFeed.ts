"use client";

// useLiveFeed — the id-paged, NextPostId-driven home feed (replaces the load-ALL `useOptimisticFeed`
// for the For-you tab). It owns four things:
//   1. The PAGED base + "load more" — `source.page({tab:'forYou', after})` reads ONE page of posts at
//      a time (keyed `Posts.getValue` walks on the PAPI path), never the full set.
//   2. Liveness via the NextPostId head — `source.liveHeadId()` emits the newest post id; on an
//      advance we re-read enough to BRIDGE the whole gap (newHead − lastHead) so no in-between post is
//      missed, and we SKIP the refetch entirely when the head is unchanged (no per-block waste). The
//      indexer source has no `liveHeadId`, so it falls back to its own poll-driven `watch()`.
//   3. The "N new posts" pill buffer — a new post from SOMEONE ELSE waits behind the pill (the scroll
//      never jumps); the viewer's OWN new post injects directly (incl. when they connect mid-session).
//   4. The optimistic overlay + presence-reconcile — a pending card (negative id) is prepended via
//      `mergeFeed` and retired once its real twin LANDS in the loaded list (NOT on tx-confirm), so the
//      optimistic→chain handoff never blinks.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptimistic } from "./useOptimistic";
import { mergeFeed, pendingKey } from "@/lib/optimistic";
import { byIdDesc, bridgeFetchSize, mergeById, partitionFresh } from "@/lib/feed/live";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoPost, FeedQuery, Ss58 } from "@/lib/types";

/** Posts per page (base load + each "load more"). */
const PAGE = 30;
/** Upper bound on posts re-read to bridge a single head jump (caps work after a long idle). */
const MAX_LIVE_FETCH = 500;

export interface UseLiveFeed {
  /** The displayed feed (loaded pages + injected own/flushed posts + optimistic overlay), newest-first. */
  posts: CognoPost[];
  /** false until the first page lands (so the UI tells "loading" from "empty"). */
  ready: boolean;
  error: string | null;
  /** A further (older) page exists — drives the load-more tail. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /** New posts (from others) waiting behind the "N new posts" pill. */
  newCount: number;
  /** Accept the buffered new posts into view (the pill / `.` shortcut; the caller scrolls to top). */
  flush: () => void;
}

export function useLiveFeed(source: FeedSource | null, me: Ss58 | null): UseLiveFeed {
  const { overlay, dropPending } = useOptimistic();

  const [loaded, setLoaded] = useState<CognoPost[]>([]);
  const [buffered, setBuffered] = useState<CognoPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Membership refs (no re-render churn): which ids are loaded vs still buffered behind the pill.
  const loadedIds = useRef<Set<string>>(new Set());
  const bufferedIds = useRef<Set<string>>(new Set());
  // `me` + the latest `buffered` reachable inside async/event callbacks without re-subscribing.
  const meRef = useRef(me);
  meRef.current = me;
  const bufferedRef = useRef(buffered);
  bufferedRef.current = buffered;
  // Epoch: bumped on every source change so an in-flight load-more from the OLD source is ignored.
  const epochRef = useRef(0);

  const baseQuery = useMemo<FeedQuery>(
    () => ({ tab: "forYou", first: PAGE, order: "recency" }),
    [],
  );

  // PAPI fold: ACCUMULATE — refresh existing rows in place, inject the viewer's own new posts, buffer
  // everyone else's. Used as we page older content indefinitely off the id counter.
  const applyFresh = useCallback((fresh: CognoPost[]) => {
    const part = partitionFresh(fresh, loadedIds.current, bufferedIds.current, meRef.current);
    if (part.newOwn.length || part.refreshLoaded.length) {
      part.newOwn.forEach((p) => loadedIds.current.add(String(p.id)));
      setLoaded((prev) => mergeById([...part.newOwn, ...prev], part.refreshLoaded));
    }
    if (part.newOthers.length || part.refreshBuffered.length) {
      part.newOthers.forEach((p) => bufferedIds.current.add(String(p.id)));
      setBuffered((prev) => mergeById(prev, [...part.newOthers, ...part.refreshBuffered]));
    }
  }, []);

  // Indexer fold: WINDOW-REPLACE — the poll-driven watch() is the authoritative top-N window, so
  // rebuild `loaded` from it (minus anything buffered) instead of accumulating stale rows that have
  // since scrolled out of that window. New others still buffer behind the pill.
  const foldWatch = useCallback((snap: CognoPost[]) => {
    const part = partitionFresh(snap, loadedIds.current, bufferedIds.current, meRef.current);
    if (part.newOthers.length) {
      part.newOthers.forEach((p) => bufferedIds.current.add(String(p.id)));
      setBuffered((prev) => mergeById(prev, part.newOthers));
    }
    const shown = snap.filter((p) => !bufferedIds.current.has(String(p.id)));
    loadedIds.current = new Set(shown.map((p) => String(p.id)));
    setLoaded(shown.slice().sort(byIdDesc));
  }, []);

  // Reset + (re)subscribe whenever the source changes.
  useEffect(() => {
    epochRef.current += 1;
    loadedIds.current = new Set();
    bufferedIds.current = new Set();
    setLoaded([]);
    setBuffered([]);
    setCursor(null);
    setReady(false);
    setError(null);
    if (!source) return;

    let cancelled = false;
    let seeded = false;
    let seeding = false;
    let lastHead: bigint | null = null;

    const fail = (e: unknown, fallback: string) => {
      if (!cancelled) setError(e instanceof Error ? e.message : fallback);
    };

    // Seed the loaded list from the newest page (PAPI). `h` is the head id at seed time → `lastHead`.
    const seed = (h: bigint | null) => {
      if (seeding || cancelled) return;
      seeding = true;
      source
        .page(baseQuery)
        .then((pg) => {
          if (cancelled) return;
          seeded = true;
          seeding = false;
          lastHead = h;
          pg.posts.forEach((p) => loadedIds.current.add(String(p.id)));
          setLoaded(pg.posts);
          setCursor(pg.endCursor);
          setReady(true);
        })
        .catch((e: unknown) => {
          seeding = false;
          fail(e, "could not load the feed");
        });
    };

    // A NextPostId head emission: seed once, then bridge the whole (lastHead, head] gap on an advance.
    const handleHead = (h: bigint | null) => {
      if (cancelled) return;
      if (!seeded) {
        if (seeding) return;
        if (h == null) {
          // Empty chain: seed an empty list so the UI leaves "loading".
          seeded = true;
          lastHead = null;
          setLoaded([]);
          setCursor(null);
          setReady(true);
          return;
        }
        seed(h);
        return;
      }
      if (h == null || (lastHead != null && h <= lastHead)) return; // no new posts → no refetch
      const gap = lastHead != null ? Number(h - lastHead) : PAGE;
      const fetchN = bridgeFetchSize(gap, MAX_LIVE_FETCH);
      if (gap > MAX_LIVE_FETCH) {
        console.warn(
          `[useLiveFeed] head jumped ${gap} ids (> ${MAX_LIVE_FETCH}); only the newest ${MAX_LIVE_FETCH} are folded in — older new posts load via "load more"`,
        );
      }
      source
        .page({ ...baseQuery, first: fetchN })
        .then((pg) => {
          if (cancelled) return;
          applyFresh(pg.posts);
          lastHead = h;
        })
        .catch(() => {
          // Transient liveness refetch failure — the next head tick retries (lastHead unadvanced).
        });
    };

    let sub: { unsubscribe(): void } | undefined;
    if (source.liveHeadId) {
      sub = source.liveHeadId().subscribe({
        next: handleHead,
        error: (e: unknown) => fail(e, "the live feed errored"),
      });
    } else {
      // Indexer: its poll-driven watch() is the whole window (untouched). First emission seeds.
      sub = source.watch().subscribe({
        next: (snap) => {
          if (cancelled) return;
          if (!seeded) {
            seeded = true;
            snap.posts.forEach((p) => loadedIds.current.add(String(p.id)));
            setLoaded(snap.posts);
            setReady(true);
          } else {
            foldWatch(snap.posts);
          }
        },
        error: (e: unknown) => fail(e, "the feed source errored"),
      });
    }

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, [source, baseQuery, applyFresh, foldWatch]);

  const loadMore = useCallback(() => {
    if (!source || loadingMore || cursor == null) return;
    const epoch = epochRef.current;
    setLoadingMore(true);
    setError(null);
    source
      .page({ ...baseQuery, after: cursor })
      .then((pg) => {
        if (epochRef.current !== epoch) return; // the source changed mid-flight — drop the stale page
        pg.posts.forEach((p) => loadedIds.current.add(String(p.id)));
        setLoaded((prev) => mergeById(prev, pg.posts));
        setCursor(pg.endCursor);
      })
      .catch((e: unknown) => {
        if (epochRef.current === epoch) setError(e instanceof Error ? e.message : "could not load more");
      })
      .finally(() => {
        if (epochRef.current === epoch) setLoadingMore(false);
      });
  }, [source, loadingMore, cursor, baseQuery]);

  const flush = useCallback(() => {
    const buf = bufferedRef.current; // latest, incl. any post a tick added since the last render
    if (buf.length === 0) return;
    const promoted = new Set(buf.map((p) => String(p.id)));
    buf.forEach((p) => {
      loadedIds.current.add(String(p.id));
      bufferedIds.current.delete(String(p.id));
    });
    setLoaded((prev) => mergeById(prev, buf));
    // Remove ONLY the promoted ids — a concurrent tick's freshly-buffered post stays behind the pill.
    setBuffered((prev) => prev.filter((p) => !promoted.has(String(p.id))));
  }, []);

  // When the viewer connects mid-session, promote their OWN posts out of the pill buffer into view
  // (they were classified as "others" while `me` was null).
  useEffect(() => {
    if (!me) return;
    const mine = bufferedRef.current.filter((p) => p.author === me);
    if (mine.length === 0) return;
    const ids = new Set(mine.map((p) => String(p.id)));
    mine.forEach((p) => {
      loadedIds.current.add(String(p.id));
      bufferedIds.current.delete(String(p.id));
    });
    setLoaded((prev) => mergeById(prev, mine));
    setBuffered((prev) => prev.filter((p) => !ids.has(String(p.id))));
  }, [me]);

  // Overlay: prepend the pending optimistic cards + apply count patches over the loaded list.
  const posts = useMemo(() => mergeFeed(loaded, overlay), [loaded, overlay]);

  // Presence-reconcile: retire a pending top-level post once its real twin LANDS in `loaded` (keyed by
  // `pendingKey`, the SAME key mergeFeed dedups on) — NOT on tx-confirm — so the optimistic→chain
  // handoff stays continuous (no blank-then-reappear).
  useEffect(() => {
    const top = overlay.pending.filter((p) => p.status === "pending" && p.parentId === undefined);
    if (top.length === 0) return;
    const realKeys = new Set(loaded.map(pendingKey));
    for (const pp of top) {
      if (realKeys.has(pendingKey(pp.post))) dropPending(pp.clientId);
    }
  }, [loaded, overlay.pending, dropPending]);

  return {
    posts,
    ready,
    error,
    hasMore: cursor != null,
    loadingMore,
    loadMore,
    newCount: buffered.length,
    flush,
  };
}
