"use client";

// useProfile — fetch one author's profile + posts via the seam (tab-aware: Posts / Replies / Likes).
// The seam returns the FIRST page (with a cursor); on the Posts tab `loadMore` pages by post id via
// `source.page({authorId, after})` and appends. Everything is node-served now (pallet-profile + the
// reverse maps for the header/counts, and `author_replies_page` for the Replies tab).
//
// `loadMore` threads `tab` back into `source.page(...)`, so a tab continues down its OWN read. Before
// spec 225 it omitted `tab`, which routed every load-more to the top-level author feed and is why
// paging was gated to the Posts tab — so the Likes tab showed one page and could never reach the rest.
// `canPage` still gates Replies, which has the routing but no end-to-end check of its walk.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mergeById } from "@/lib/feed/live";
import { FEED_PAGE_SIZE } from "@/lib/feed/constants";
import { useOptimistic } from "@/hooks/useOptimistic";
import { applyProfilePatch } from "@/lib/optimistic";
import type { FeedSource, ProfileArgs } from "@/lib/feed/source";
import { readErrorCopy } from "@/lib/chain/errors";
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
  /**
   * The RAW posts of the page that landed most recently (the first page, then each `loadMore` page).
   * `null` until one lands; a SILENT refresh does not replace it, since that is a re-read of page 1
   * rather than a step down the cursor.
   *
   * Timeline filters it with its own moderation predicate to decide whether the tail may keep
   * auto-loading — see lib/feed/tail.ts. This is the profile half of the >50-blocked-posts runaway.
   */
  lastPage: CognoPost[] | null;
  loadingMore: boolean;
  loadMore: () => void;
  /**
   * Re-run the read now. A failed profile read already self-heals on the next `liveKey` tick, so this
   * is about immediacy: the error card's Retry called `router.refresh()`, which under `output: 'export'`
   * does nothing, leaving the user staring at an error for up to a block with no idea it would fix
   * itself. (Contrast useThread.reload, where the equivalent failure is terminal.)
   */
  reload: () => void;
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
  // The raw posts of the page that landed most recently — the tail's per-page guard (lib/feed/tail.ts).
  const [lastPage, setLastPage] = useState<CognoPost[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by `reload()` to re-arm the read effect (the error card's Retry).
  const [retryNonce, setRetryNonce] = useState(0);
  const reload = useCallback(() => setRetryNonce((n) => n + 1), []);
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
  // Which tabs can page. `loadMore` threads `tab` back into the seam, so each tab continues down its
  // own read rather than falling through to the author feed. The Replies tab stays gated off: the seam
  // routes it, but nothing has verified that walk end-to-end. Turning it on is a one-line change once
  // something has.
  const canPage = args.tab == null || args.tab === "forYou" || args.tab === "likes";

  useEffect(() => {
    if (!source || (!args.author && !args.identityHash)) {
      epochRef.current += 1;
      setProfile(null);
      setBase([]);
      setAppended([]);
      setLastPage(null);
      setCursor(null);
      setHasMore(false);
      loadedKey.current = null;
      return;
    }
    let cancelled = false;
    const firstForKey = loadedKey.current !== key;
    if (firstForKey) {
      epochRef.current += 1;
      // Clear the previous key's post list so `posts` (mergeById(base, appended)) doesn't render the
      // prior author's/tab's posts under the spinner during a same-mount switch (/u/A → /u/B, Posts →
      // Replies). The profile record itself is kept to avoid blanking the header on a tab switch.
      setBase([]);
      setAppended([]);
      setLastPage(null);
      setCursor(null);
      setHasMore(false);
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
          setLastPage(p.page.posts);
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
          setError(readErrorCopy(e, "Couldn't load this profile."));
        }
      })
      .finally(() => {
        if (!cancelled && firstForKey) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `retryNonce` re-arms this for the error card's Retry. Safe: `loadedKey` is only stamped on
    // SUCCESS, so a retry after a failure still computes `firstForKey === true` and runs as a fresh
    // load (spinner + error surfacing), exactly as the first attempt did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, key, liveKey, retryNonce]);

  const loadMore = useCallback(() => {
    const account = profile?.author;
    if (!source || loadingMore || cursor == null || !canPage || !account) return;
    const epoch = epochRef.current;
    setLoadingMore(true);
    // `tab` is threaded back in so the page routes to the SAME read the first page came from and
    // continues down the same cursor domain. Omitting it (what this did before spec 225) silently
    // routed every load-more to the top-level author feed, which is why paging was gated to Posts.
    // Thread the viewer through so a spec-120 node stamps the overlay on load-more pages too.
    source
      .page({ authorId: account, after: cursor, first: PAGE, viewer: args.viewer, tab: args.tab })
      .then((pg) => {
        if (epochRef.current !== epoch) return; // tab/author switched mid-flight — drop the stale page
        setAppended((prev) => mergeById(prev, pg.posts));
        setLastPage(pg.posts);
        setCursor(pg.endCursor);
        setHasMore(pg.hasNextPage);
      })
      .catch(() => {
        // A load-more failure is non-fatal — keep what's shown; the tail can retry on next intersect.
      })
      .finally(() => {
        if (epochRef.current === epoch) setLoadingMore(false);
      });
  }, [source, loadingMore, cursor, canPage, profile, args.viewer, args.tab]);

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

  return {
    profile: mergedProfile,
    posts,
    loading,
    error,
    hasMore,
    lastPage,
    loadingMore,
    loadMore,
    reload,
  };
}
