"use client";

// useLiveFeed — the id-paged, NextPostId-driven home feed (replaces the load-ALL `useOptimisticFeed`
// for the For-you tab). It owns four things:
//   1. The PAGED base + "load more" — `source.page({tab:'forYou', after})` reads ONE page of posts at
//      a time (keyed `Posts.getValue` walks on the PAPI path), never the full set.
//   2. Liveness via the NextPostId head — `source.liveHeadId()` fires when a new post bumps the
//      counter; we re-read the newest page and fold it in (no `watchEntries`). The indexer source has
//      no `liveHeadId`, so it falls back to its own poll-driven `watch()`.
//   3. The "N new posts" pill buffer — a new post from SOMEONE ELSE waits behind the pill (the scroll
//      never jumps); the viewer's OWN new post injects directly.
//   4. The optimistic overlay + presence-reconcile — a pending card (negative id) is prepended via
//      `mergeFeed` and retired once its real twin LANDS in the loaded list (NOT on tx-confirm), so the
//      optimistic→chain handoff never blinks.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptimistic } from "./useOptimistic";
import { mergeFeed } from "@/lib/optimistic";
import { mergeById, partitionFresh } from "@/lib/feed/live";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoPost, FeedQuery, Ss58 } from "@/lib/types";

/** Posts per page (base load + each "load more"). */
const PAGE = 30;

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
  // `me` reachable inside async callbacks without re-subscribing the feed.
  const meRef = useRef(me);
  meRef.current = me;

  const baseQuery = useMemo<FeedQuery>(
    () => ({ tab: "forYou", first: PAGE, order: "recency" }),
    [],
  );

  // Fold a freshly-read newest page in: refresh existing rows in place, inject the viewer's own new
  // posts directly, buffer everyone else's new posts behind the pill.
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

  // Reset + (re)subscribe whenever the source changes.
  useEffect(() => {
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
    // The FIRST signal seeds the loaded list; every later signal folds in (partitioned).
    const ingest = (posts: CognoPost[], endCursor: string | null) => {
      if (cancelled) return;
      if (!seeded) {
        seeded = true;
        posts.forEach((p) => loadedIds.current.add(String(p.id)));
        setLoaded(posts);
        setCursor(endCursor);
        setReady(true);
      } else {
        applyFresh(posts);
      }
    };

    let sub: { unsubscribe(): void } | undefined;
    if (source.liveHeadId) {
      // PAPI: the NextPostId head drives an id-paged refetch (it emits the current head on subscribe,
      // which seeds the first page). A new post bumps the head → re-read the newest page → fold in.
      sub = source.liveHeadId().subscribe({
        next: () => {
          source
            .page(baseQuery)
            .then((pg) => ingest(pg.posts, pg.endCursor))
            .catch((e: unknown) => {
              if (!cancelled && !seeded) {
                setError(e instanceof Error ? e.message : "could not load the feed");
              }
            });
        },
        error: () => {},
      });
    } else {
      // Indexer: its own poll-driven watch() is the whole feed (untouched). First emission seeds.
      sub = source.watch().subscribe({
        next: (snap) => ingest(snap.posts, null),
        error: (err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "the feed source errored");
        },
      });
    }

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, [source, baseQuery, applyFresh]);

  const loadMore = useCallback(() => {
    if (!source || loadingMore || cursor == null) return;
    setLoadingMore(true);
    setError(null);
    source
      .page({ ...baseQuery, after: cursor })
      .then((pg) => {
        pg.posts.forEach((p) => loadedIds.current.add(String(p.id)));
        setLoaded((prev) => mergeById(prev, pg.posts));
        setCursor(pg.endCursor);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "could not load more");
      })
      .finally(() => setLoadingMore(false));
  }, [source, loadingMore, cursor, baseQuery]);

  const flush = useCallback(() => {
    if (buffered.length === 0) return;
    buffered.forEach((p) => {
      loadedIds.current.add(String(p.id));
      bufferedIds.current.delete(String(p.id));
    });
    setLoaded((prev) => mergeById(prev, buffered));
    setBuffered([]);
  }, [buffered]);

  // Overlay: prepend the pending optimistic cards + apply count patches over the loaded list.
  const posts = useMemo(() => mergeFeed(loaded, overlay), [loaded, overlay]);

  // Presence-reconcile (preserved from useOptimisticFeed): retire a pending top-level post once its
  // real twin LANDS in `loaded` (keyed author+text, matching mergeFeed's dedup) — NOT on tx-confirm —
  // so the optimistic→chain handoff stays continuous (no blank-then-reappear).
  useEffect(() => {
    const top = overlay.pending.filter((p) => p.status === "pending" && p.parentId === undefined);
    if (top.length === 0) return;
    const realKeys = new Set(loaded.map((p) => `${p.author}\n${p.text}`));
    for (const pp of top) {
      if (realKeys.has(`${pp.post.author}\n${pp.post.text}`)) dropPending(pp.clientId);
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
