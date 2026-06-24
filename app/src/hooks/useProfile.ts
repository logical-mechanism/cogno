"use client";

// useProfile — fetch one author's profile + posts via the seam (tab-aware: Posts / Replies / Likes).
// The seam returns the FIRST page (with a cursor); `loadMore` pages the Posts tab by post id via
// `source.page({authorId, after})` and appends. Display fields (name/bio/avatar/counts) come back on
// both readers now (pallet-profile + the spec-118 reverse maps); the Replies tab needs the indexer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergeById } from "@/lib/feed/live";
import type { FeedSource, ProfileArgs } from "@/lib/feed/source";
import type { CognoPost, ProfileView } from "@/lib/types";

const PAGE = 30;

export interface UseProfile {
  profile: ProfileView | null;
  posts: CognoPost[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

/**
 * @param liveKey changing value (e.g. the best block number) that triggers a SILENT re-fetch — so a
 *   profile edit or a fresh post lands as soon as the block comes in, with no spinner/manual refresh.
 *   A silent refresh refreshes the first page IN PLACE (merged over any loaded-more pages) and does
 *   NOT reset the cursor, so it never clobbers "load more" progress.
 */
export function useProfile(
  source: FeedSource | null,
  args: ProfileArgs,
  liveKey?: number | null,
): UseProfile {
  const [profile, setProfile] = useState<ProfileView | null>(null);
  // Pages fetched via load-more (page 2+); merged under the profile's first page for display.
  const [appended, setAppended] = useState<CognoPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(args);
  // Track which args we've already shown data for, so a liveKey tick is a silent refresh (no spinner,
  // no error clobber, no cursor reset) while a new args/source is a fresh load.
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!source || (!args.author && !args.identityHash)) {
      setProfile(null);
      setAppended([]);
      setCursor(null);
      setHasMore(false);
      loadedKey.current = null;
      return;
    }
    let cancelled = false;
    const firstForKey = loadedKey.current !== key;
    if (firstForKey) {
      setLoading(true);
      setError(null);
    }
    source
      .profile(args)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        loadedKey.current = key;
        // Only a FRESH load (re)seeds the cursor + clears loaded-more pages; a silent refresh keeps
        // them so it can't undo "load more" or re-page the same cursor.
        if (firstForKey) {
          setAppended([]);
          setCursor(p.page.endCursor);
          setHasMore(p.page.hasNextPage);
        }
      })
      .catch((e: unknown) => {
        // Only surface an error on the initial load; a silent refresh failure keeps the last data.
        if (!cancelled && firstForKey) {
          setError(e instanceof Error ? e.message : "could not load the profile");
        }
      })
      .finally(() => {
        if (!cancelled && firstForKey) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, key, liveKey]);

  const loadMore = useCallback(() => {
    const account = profile?.author;
    if (!source || loadingMore || cursor == null || !account) return;
    setLoadingMore(true);
    source
      .page({ authorId: account, after: cursor, first: PAGE, tab: args.tab })
      .then((pg) => {
        setAppended((prev) => mergeById(prev, pg.posts));
        setCursor(pg.endCursor);
        setHasMore(pg.hasNextPage);
      })
      .catch(() => {
        // A load-more failure is non-fatal — keep what's shown; the tail can retry on next intersect.
      })
      .finally(() => setLoadingMore(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, loadingMore, cursor, profile, args.tab]);

  // First page (from the profile) + any loaded-more pages, de-duped + newest-first.
  const posts = useMemo(
    () => mergeById(profile?.page.posts ?? [], appended),
    [profile, appended],
  );

  return { profile, posts, loading, error, hasMore, loadingMore, loadMore };
}
