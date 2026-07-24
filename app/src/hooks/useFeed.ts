"use client";

// useFeedPage — the paginated/search read path: fetches one page on demand, supports cursor "load
// more" by appending, and surfaces a clear error state instead of blanking the feed when the node is
// unreachable.

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeById } from "@/lib/feed/live";
import type { FeedPage, FeedQuery, CognoPost } from "@/lib/types";
import { readErrorCopy } from "@/lib/chain/errors";
import type { FeedSource } from "@/lib/feed/source";


export interface UseFeedPage {
  page: FeedPage | null;
  posts: CognoPost[];
  loading: boolean;
  error: string | null;
  hasNextPage: boolean;
  totalCount?: number;
  /** Fetch the next cursor page and append it (no-op when there is no further page). */
  loadMore: () => void;
  /**
   * Re-read the FIRST page and merge it over the loaded posts, without clearing them.
   *
   * For the Home "Following" tab, which — unlike For-you — has no head-id liveness subscription at
   * all, so this is the only way new followee posts appear without leaving the tab. Non-destructive on
   * purpose: it leaves `page`, the cursor and `loading` alone, so the tail the viewer paged in stays
   * put, the skeleton never flashes over content, and an in-flight `loadMore` (whose ids are strictly
   * older, hence disjoint) still lands cleanly.
   *
   * CONTRACT: the merge is newest-id-first, so this is only sound for an id-ordered feed. Do not wire
   * it to the search path, whose results are not ordered by id.
   */
  refresh: () => void;
}

/**
 * The paginated read path: fetch the first page whenever the source or query changes, then
 * append cursor pages on `loadMore`. Used for search and "load more" — gated on
 * the caller. Honest error state; never blanks on failure.
 */
export function useFeedPage(
  source: FeedSource | null,
  query: FeedQuery,
  enabled: boolean,
): UseFeedPage {
  const [posts, setPosts] = useState<CognoPost[]>([]);
  const [page, setPage] = useState<FeedPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable key for the query so the first-page effect only re-fires on a real change.
  const queryKey = JSON.stringify(query);
  const cursorRef = useRef<string | null>(null);
  // A ref mirror of `page`, kept in lockstep by `applyPage`. It lets `refresh` ask "was a first page
  // ever established?" without taking `page` as a dep — `refresh` must keep a stable identity (the
  // Home re-tap subscribes an effect to it), and `cursorRef` can't answer that question: it is null
  // both when nothing ever loaded AND at the true tail of the feed.
  const pageRef = useRef<FeedPage | null>(null);
  const applyPage = useCallback((p: FeedPage | null) => {
    pageRef.current = p;
    setPage(p);
  }, []);
  // The query the currently-mounted results belong to. A `loadMore` fetch captures the key it was
  // dispatched under and compares against this ref when it resolves, so a page that lands AFTER the
  // term changed can't append stale-term posts onto the new results or clobber the new cursor.
  const queryKeyRef = useRef(queryKey);

  // (Re)load the first page when the source or query changes (and the path is enabled).
  useEffect(() => {
    queryKeyRef.current = queryKey;
    if (!source || !enabled) {
      setPosts([]);
      applyPage(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Clear the previous query's results immediately so a term change shows the loading state
    // rather than stale matches from the old term until the new page resolves.
    setPosts([]);
    applyPage(null);
    cursorRef.current = null;
    source
      .page(query)
      .then((p) => {
        if (cancelled) return;
        applyPage(p);
        setPosts(p.posts);
        cursorRef.current = p.endCursor;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        applyPage(null);
        setPosts([]);
        setError(readErrorCopy(err, "Couldn't load posts."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // queryKey captures the query contents; source identity drives re-fetch on path change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, queryKey, enabled]);

  const loadMore = useCallback(() => {
    if (!source || loading) return;
    if (!page?.hasNextPage || cursorRef.current == null) return;
    // The query this page belongs to. If the term changes mid-flight (the first-page effect resets
    // results + updates queryKeyRef), the guards below drop this now-stale page instead of appending
    // old-term posts onto the new results or advancing the new term's cursor to the wrong id.
    const dispatchedKey = queryKey;
    setLoading(true);
    setError(null);
    source
      .page({ ...query, after: cursorRef.current })
      .then((p) => {
        if (queryKeyRef.current !== dispatchedKey) return;
        applyPage(p);
        setPosts((prev) => [...prev, ...p.posts]);
        cursorRef.current = p.endCursor;
      })
      .catch((err: unknown) => {
        if (queryKeyRef.current !== dispatchedKey) return;
        setError(readErrorCopy(err, "Couldn't load more."));
      })
      .finally(() => {
        if (queryKeyRef.current === dispatchedKey) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, queryKey, page, loading]);

  // Re-read page 1 over the top of what is already displayed (see the `refresh` doc above). It reuses
  // loadMore's staleness guard — a page that lands after the QUERY changed is dropped rather than
  // merged onto another query's results. A failure is silent: the posts on screen are still valid.
  const refresh = useCallback(() => {
    if (!source || !enabled) return;
    const dispatchedKey = queryKey;
    source
      .page(query)
      .then((p) => {
        if (queryKeyRef.current !== dispatchedKey) return;
        setPosts((prev) => mergeById(prev, p.posts)); // by id: no duplicate rows, no dropped rows
        // Adopt the page metadata ONLY when the first-page load never established any — i.e. it FAILED
        // and this refresh is the Retry that recovered it. Without this the recovery looks complete
        // (posts render, the error row retires) while `hasNextPage` stays false and the cursor stays
        // null, so the load-more tail never mounts again for the session.
        //
        // The `pageRef.current == null` gate is load-bearing: when a page IS established we must leave
        // `page`/`cursorRef` alone. Rewinding the cursor to page 1's endCursor under an already-paged
        // tail would make the next `loadMore` re-read rows it has already appended — and it appends
        // blind (`[...prev, ...p.posts]`, no dedup), so every one of them would show up twice.
        if (pageRef.current == null) {
          applyPage(p);
          cursorRef.current = p.endCursor;
        }
        setError(null);
      })
      .catch(() => {
        // Silent — a re-read of content already on screen, not a load.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, enabled, queryKey, applyPage]);

  return {
    page,
    posts,
    loading,
    error,
    hasNextPage: page?.hasNextPage ?? false,
    totalCount: page?.totalCount,
    loadMore,
    refresh,
  };
}
