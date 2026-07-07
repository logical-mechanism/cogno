"use client";

// useFeed — subscribes to a FeedSource's live `watch()` and exposes the snapshot as plain React
// state. NOTE: the home/profile feeds now read via the id-paged `useLiveFeed` / `useFeedPage`; this
// generic watch hook is retained for any consumer that wants the source's whole live window. Neither
// source uses `watchEntries` (PAPI's `watch()` is NextPostId-driven; the indexer's is poll-driven).
//
// useFeedPage — for the paginated/search read path (indexer-only): fetches one page on demand,
// supports cursor "load more" by appending, and surfaces a clear error state instead of
// blanking the feed if the indexer is unreachable.

import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedSnapshot, FeedPage, FeedQuery, CognoPost } from "@/lib/types";
import type { FeedSource } from "@/lib/feed/source";

const EMPTY: FeedSnapshot = { posts: [], asOf: null };

export interface UseFeed {
  /** Full current post set, newest-first. */
  snapshot: FeedSnapshot;
  /** false until the first emission lands (so the UI can tell "loading" from "empty"). */
  ready: boolean;
  /** A live error (e.g. the indexer is unreachable), so the UI can degrade honestly. */
  error: string | null;
}

export function useFeed(source: FeedSource | null): UseFeed {
  const [snapshot, setSnapshot] = useState<FeedSnapshot>(EMPTY);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) {
      setSnapshot(EMPTY);
      setReady(false);
      setError(null);
      return;
    }
    setReady(false);
    setError(null);
    const sub = source.watch().subscribe({
      next: (snap) => {
        setSnapshot(snap);
        setReady(true);
        setError(null);
      },
      error: (err: unknown) => {
        // Keep the last good snapshot, but stop claiming readiness and surface why so the UI
        // can show a clear error state (indexer unreachable → user can clear it to use PAPI).
        setReady(false);
        setError(err instanceof Error ? err.message : "the feed source errored");
      },
    });
    return () => sub.unsubscribe();
  }, [source]);

  return { snapshot, ready, error };
}

export interface UseFeedPage {
  page: FeedPage | null;
  posts: CognoPost[];
  loading: boolean;
  error: string | null;
  hasNextPage: boolean;
  totalCount?: number;
  /** Fetch the next cursor page and append it (no-op when there is no further page). */
  loadMore: () => void;
}

/**
 * The paginated read path: fetch the first page whenever the source or query changes, then
 * append cursor pages on `loadMore`. Used for search and "load more" — gated on
 * `source.caps.pagination` by the caller. Honest error state; never blanks on failure.
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
  // The query the currently-mounted results belong to. A `loadMore` fetch captures the key it was
  // dispatched under and compares against this ref when it resolves, so a page that lands AFTER the
  // term changed can't append stale-term posts onto the new results or clobber the new cursor.
  const queryKeyRef = useRef(queryKey);

  // (Re)load the first page when the source or query changes (and the path is enabled).
  useEffect(() => {
    queryKeyRef.current = queryKey;
    if (!source || !enabled) {
      setPosts([]);
      setPage(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Clear the previous query's results immediately so a term change shows the loading state
    // rather than stale matches from the old term until the new page resolves.
    setPosts([]);
    setPage(null);
    cursorRef.current = null;
    source
      .page(query)
      .then((p) => {
        if (cancelled) return;
        setPage(p);
        setPosts(p.posts);
        cursorRef.current = p.endCursor;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPage(null);
        setPosts([]);
        setError(err instanceof Error ? err.message : "could not load the page");
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
        setPage(p);
        setPosts((prev) => [...prev, ...p.posts]);
        cursorRef.current = p.endCursor;
      })
      .catch((err: unknown) => {
        if (queryKeyRef.current !== dispatchedKey) return;
        setError(err instanceof Error ? err.message : "could not load more");
      })
      .finally(() => {
        if (queryKeyRef.current === dispatchedKey) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, queryKey, page, loading]);

  return {
    page,
    posts,
    loading,
    error,
    hasNextPage: page?.hasNextPage ?? false,
    totalCount: page?.totalCount,
    loadMore,
  };
}
