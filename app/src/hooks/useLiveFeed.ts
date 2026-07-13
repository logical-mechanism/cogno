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
import { mergeFeed, pendingKey, viewerPatchSettled } from "@/lib/optimistic";
import { bridgeFetchSize, mergeById, partitionFresh } from "@/lib/feed/live";
import { FEED_PAGE_SIZE } from "@/lib/feed/constants";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoPost, FeedQuery, Ss58 } from "@/lib/types";

/** Posts per page (base load + each "load more"). One node `state_call` per page since spec-120. */
const PAGE = FEED_PAGE_SIZE;
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
  /**
   * Re-read page 1 and fold it into the loaded list (the Home-tab re-tap + the error row's Retry).
   *
   * It FLUSHES the pill buffer, then merges a fresh page 1 over what is loaded — it does NOT replace
   * the list. That distinction is the whole design: a replace would have to reset `cursor` (dropping
   * every "load more" page under the viewer) and invalidate the in-flight `loadMore` epoch (whose
   * epoch-gated `.finally` would then never clear `loadingMore`, wedging load-more for the session).
   * A merge keys on post id, so it can neither duplicate nor drop a row, and the pages below stay put.
   *
   * Liveness already folds in NEW posts off the head id; what a manual refresh adds is fresh TALLIES
   * (a vote writes no post, so the head never moves) and a way back from a read error.
   */
  refresh: () => void;
}

export function useLiveFeed(
  source: FeedSource | null,
  me: Ss58 | null,
  /** Best-block number — ticks the vote/repost reconcile refetch (votes don't advance the head id). */
  bestBlock?: number | null,
): UseLiveFeed {
  const { overlay, dropPending, clearPost } = useOptimistic();

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
  // Latest overlay reachable inside the async reconcile-refetch callback (resolves after the closure).
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;
  // Epoch: bumped on every source change so an in-flight load-more from the OLD source is ignored.
  const epochRef = useRef(0);
  // Single-flight guard for `refresh` — a spam-clicked Home button must not stack page-1 reads.
  const refreshingRef = useRef(false);

  // `viewer: me` lets a spec-120 node stamp each post's myVote/reposted overlay node-side (one
  // state_call); the keyed + indexer paths ignore it. Re-keyed on `me` so connecting mid-session
  // re-pages with the overlay (the source-change effect below re-seeds on a new baseQuery identity).
  const baseQuery = useMemo<FeedQuery>(
    () => ({ tab: "forYou", first: PAGE, viewer: me ?? undefined }),
    [me],
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
    // The epoch bump above orphans any in-flight load-more, and its `.finally` is epoch-gated — so
    // without this, a source change mid-load-more leaves `loadingMore` true forever and `loadMore`
    // dead-returns on its own guard for the rest of the session.
    setLoadingMore(false);
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

    // `liveHeadId` is a REQUIRED member of FeedSource, so the old `if (source.liveHeadId)` was always
    // true and its else-branch — an indexer-era `source.watch()` fold — was statically unreachable.
    const sub = source.liveHeadId().subscribe({
      next: handleHead,
      error: (e: unknown) => fail(e, "the live feed errored"),
    });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, [source, baseQuery, applyFresh]);

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

  // Re-read page 1 and MERGE it over the loaded list (see the `refresh` doc on UseLiveFeed above for
  // why a merge and not a replace). Deliberately touches neither `cursor`, `epochRef`, `ready` nor
  // `loadingMore`: the tail the viewer has paged in stays exactly where it is, and an in-flight
  // load-more still lands. Failure is silent — the list on screen is still valid, and the head
  // subscription keeps the feed live regardless.
  const refresh = useCallback(() => {
    flush(); // the pill's posts are already in memory: promote them for free, before any read
    if (!source || refreshingRef.current) return; // single-flight: a double-tap reads page 1 once
    refreshingRef.current = true;
    const epoch = epochRef.current; // compared, never bumped
    source
      .page(baseQuery)
      .then((pg) => {
        if (epochRef.current !== epoch) return; // the source changed mid-flight — drop the stale page
        const fresh = new Set(pg.posts.map((p) => String(p.id)));
        pg.posts.forEach((p) => {
          loadedIds.current.add(String(p.id));
          // An explicit refresh means "show me everything now" — nothing it returns goes back behind
          // the pill (and a concurrent head-tick that already buffered one of these ids must not leave
          // a phantom count pointing at a post that is now visible).
          bufferedIds.current.delete(String(p.id));
        });
        setLoaded((prev) => mergeById(prev, pg.posts)); // by id: cannot duplicate, cannot drop
        setBuffered((prev) => prev.filter((p) => !fresh.has(String(p.id))));
        setError(null); // the read demonstrably works — retire any stale error row
      })
      .catch(() => {
        // Silent by design: this is a re-read of content already on screen, not a load.
      })
      .finally(() => {
        refreshingRef.current = false;
      });
  }, [source, baseQuery, flush]);

  // (A former mid-session "promote my own buffered posts" effect lived here; it was redundant — a `me`
  // change re-keys baseQuery, which re-runs the reset effect above and re-seeds page-1 with the viewer
  // stamped in node-side, so the viewer's newest own post returns already loaded.)

  // Overlay: prepend the pending optimistic cards + apply count patches over the loaded list.
  const posts = useMemo(() => mergeFeed(loaded, overlay), [loaded, overlay]);

  // Presence-reconcile: retire a pending top-level post once its real twin LANDS in `loaded` (keyed by
  // `pendingKey`, the SAME key mergeFeed dedups on) — NOT on tx-confirm — so the optimistic→chain
  // handoff stays continuous (no blank-then-reappear).
  useEffect(() => {
    const top = overlay.pending.filter((p) => p.parentId === undefined);
    if (top.length === 0) return;
    const realKeys = new Set(loaded.map(pendingKey));
    for (const pp of top) {
      if (realKeys.has(pendingKey(pp.post))) dropPending(pp.clientId);
    }
  }, [loaded, overlay.pending, dropPending]);

  // Vote/repost reconcile refetch: a vote/repost writes VoteTally/Reposts but creates NO new post, so
  // the head-id liveness never refetches it and the loaded row's tally + carried myVote stay frozen
  // (the optimistic overlay would otherwise just TTL-expire back to the stale row). While a CONFIRMED
  // (expected) vote/repost patch sits on a loaded post, re-read page-1 each block; retire the patches
  // whose fresh (best-block) row now agrees — BEFORE folding the fresh row in, so the clear + the fold
  // batch into one render (the tally hands off from overlay to chain truth with no double-count flash).
  useEffect(() => {
    if (!source) return;
    const needs = Object.entries(overlay.viewer).some(
      ([id, v]) => v.expected && loadedIds.current.has(id),
    );
    if (!needs) return;
    let cancelled = false;
    source
      .page(baseQuery)
      .then((pg) => {
        if (cancelled) return;
        const v = overlayRef.current.viewer;
        for (const p of pg.posts) {
          const patch = v[String(p.id)];
          if (
            patch?.expected &&
            viewerPatchSettled({ myVote: p.myVote ?? null }, patch)
          ) {
            clearPost(p.id);
          }
        }
        applyFresh(pg.posts);
      })
      .catch(() => {
        // Transient refetch failure — the next block re-attempts (the patch is still expected).
      });
    return () => {
      cancelled = true;
    };
  }, [source, baseQuery, bestBlock, overlay.viewer, applyFresh, clearPost]);

  return {
    posts,
    ready,
    error,
    hasMore: cursor != null,
    loadingMore,
    loadMore,
    newCount: buffered.length,
    flush,
    refresh,
  };
}
