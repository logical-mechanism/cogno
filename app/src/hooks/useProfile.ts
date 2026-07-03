"use client";

// useProfile — fetch one author's profile + posts via the seam (tab-aware: Posts / Replies / Likes).
// The seam returns the FIRST page (with a cursor); on the Posts tab `loadMore` pages by post id via
// `source.page({authorId, after})` and appends. Everything is node-served now (pallet-profile + the
// spec-118 reverse maps for the header/counts, and spec-200 `author_replies_page` for the Replies tab).
//
// Only the Posts tab paginates here. `loadMore` issues `page({authorId, after})` WITHOUT a `tab`, which
// routes to the top-level author-feed branch — so enabling it for Replies/Likes would append the WRONG
// set (the node DOES expose a replies cursor via `author_replies_page`, but this hook doesn't thread
// `tab:"replies"` through load-more). We gate load-more to the Posts tab (`canPage`) to avoid that.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergeById } from "@/lib/feed/live";
import { FEED_PAGE_SIZE } from "@/lib/feed/constants";
import { useOptimistic } from "@/hooks/useOptimistic";
import { applyProfilePatch } from "@/lib/optimistic";
import type { FeedSource, ProfileArgs } from "@/lib/feed/source";
import type { CognoPost, ProfileView } from "@/lib/types";

// Posts-tab "load more" page size (the first page comes back from `source.profile()` at the seam
// default). One node `state_call` per page since spec-120, so it tracks the shared feed page size.
const PAGE = FEED_PAGE_SIZE;

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
 *   A silent refresh MERGES the fresh first page over the existing one (so a post evicted from page 1
 *   by a new author post isn't dropped) and does NOT reset the cursor, so it never clobbers load-more.
 */
export function useProfile(
  source: FeedSource | null,
  args: ProfileArgs,
  liveKey?: number | null,
): UseProfile {
  const [profile, setProfile] = useState<ProfileView | null>(null);
  // The first page (merged across silent refreshes) + the load-more pages (page 2+); shown together.
  const [base, setBase] = useState<CognoPost[]>([]);
  const [appended, setAppended] = useState<CognoPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optimistic profile overlay: a just-saved edit shows instantly (merged below), retired once a fresh
  // read agrees (reconcile) or after the store's TTL backstop.
  const { overlay, reconcileProfile } = useOptimistic();
  const profilePatch = args.author ? overlay.profiles[args.author] : undefined;
  const key = JSON.stringify(args);
  // Track which args we've already shown data for, so a liveKey tick is a silent refresh (no spinner,
  // no error clobber, no cursor reset) while a new args/source is a fresh load.
  const loadedKey = useRef<string | null>(null);
  // Epoch: bumped on a fresh load (new source/args), so an in-flight load-more from a previous
  // tab/author is ignored when it resolves after the switch.
  const epochRef = useRef(0);
  // Only the Posts tab pages by id (Likes/Replies are reverse-index reads — no per-id cursor).
  const canPage = args.tab == null || args.tab === "forYou";

  useEffect(() => {
    if (!source || (!args.author && !args.identityHash)) {
      epochRef.current += 1;
      setProfile(null);
      setBase([]);
      setAppended([]);
      setCursor(null);
      setHasMore(false);
      loadedKey.current = null;
      return;
    }
    let cancelled = false;
    const firstForKey = loadedKey.current !== key;
    if (firstForKey) {
      epochRef.current += 1;
      setLoading(true);
      setError(null);
    }
    source
      .profile(args)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        loadedKey.current = key;
        if (firstForKey) {
          setBase(p.page.posts);
          setAppended([]);
          setCursor(canPage ? p.page.endCursor : null);
          setHasMore(canPage ? p.page.hasNextPage : false);
        } else {
          // Silent refresh: MERGE the fresh first page over the existing base so a post just evicted
          // from page 1 (by a new author post) isn't lost; cursor + appended pages stay intact.
          setBase((prev) => mergeById(prev, p.page.posts));
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
    if (!source || loadingMore || cursor == null || !canPage || !account) return;
    const epoch = epochRef.current;
    setLoadingMore(true);
    // Posts tab only → page by author id (no `tab`: the seam's likes/replies have no per-id cursor).
    // Thread the viewer through so a spec-120 node stamps the overlay on load-more pages too.
    source
      .page({ authorId: account, after: cursor, first: PAGE, viewer: args.viewer })
      .then((pg) => {
        if (epochRef.current !== epoch) return; // tab/author switched mid-flight — drop the stale page
        setAppended((prev) => mergeById(prev, pg.posts));
        setCursor(pg.endCursor);
        setHasMore(pg.hasNextPage);
      })
      .catch(() => {
        // A load-more failure is non-fatal — keep what's shown; the tail can retry on next intersect.
      })
      .finally(() => {
        if (epochRef.current === epoch) setLoadingMore(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, loadingMore, cursor, canPage, profile, args.viewer]);

  // First page (merged across silent refreshes) + any loaded-more pages, de-duped + newest-first.
  const posts = useMemo(() => mergeById(base, appended), [base, appended]);

  // Retire a confirmed optimistic profile patch once THIS read (chain truth) already carries it.
  useEffect(() => {
    if (profile && args.author && profilePatch?.expected) {
      reconcileProfile(args.author, profile);
    }
  }, [profile, args.author, profilePatch, reconcileProfile]);

  // Merge the optimistic overlay over the read profile so a just-saved edit renders instantly.
  const mergedProfile = useMemo(
    () => (profile ? applyProfilePatch(profile, profilePatch) : profile),
    [profile, profilePatch],
  );

  return { profile: mergedProfile, posts, loading, error, hasMore, loadingMore, loadMore };
}
