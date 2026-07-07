"use client";

// ExplorePage — /explore (surface 10). The search-first discovery surface. A full-width SearchBar in
// a sticky blurred header; below it two modes derived from the URL term `q` (read client-side via
// useSearchParams) + feedSource.caps.search:
//
//   caps.search === false → NO-SOURCE   : the reader isn't ready yet (no `source` before connect;
//                                          search is node-served, so once connected caps.search is true) —
//                                          SearchBar disabled + `search-unavailable` EmptyState; firehose
//                                          still renders (the live window).
//   caps.search === true, q === ''       → DEFAULT : firehose Timeline + FirehoseOrderToggle (Top|Recent).
//   caps.search === true, q !== ''       → QUERY   : ResultTabStrip (People | Latest) + result list.
//
// `q` is the committed term (mirrored to ?q=). The SearchBar's controlled value is a SEPARATE local
// `draft` that debounces into `q` (300ms) while typing — router.replace (not push) so keystroke term
// changes never stack history; Enter commits immediately; the clear ✕ → router.replace('/explore').
//
// The firehose + Latest both use useFeedPage(source, …), both NODE-DIRECT: the firehose via the spec-200
// feed_page (recency by id, cursor-paginated), Latest via search_posts (the in-runtime substring scan).
// caps.pagination is true, so the Timeline shows infinite-scroll for both. People search uses
// source.searchPeople (node-served — search_people). Every result-card write is optimistic and
// funnels disconnected/unbound viewers to /welcome; capacity exhaustion → RateLimitNotice toast. No
// honesty/block-number chrome anywhere.
//
// useSearchParams() requires a <Suspense> boundary under output:'export' (mirrors /compose) — the route
// default mounts <ExploreView> inside one.
//
// HOOK: notifications — deferred (surface 10 §10 / useNotifications). A future /notifications surface
// (+ a bell in LeftNav/BottomTabBar) would fold the indexer edges Voted / Reposted / Followed /
// reply-PostCreated (parentId ∈ my posts) / quote (quote.id ∈ my posts) via useNotifications(who). No
// notifications affordance ships here — this comment is the only hook.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "./page.module.css";
import { SearchBar } from "@/components/SearchBar";
import { Timeline } from "@/components/Timeline";
import { EmptyState } from "@/components/EmptyState";
import { FirehoseOrderToggle, type FirehoseOrder } from "@/components/explore/FirehoseOrderToggle";
import { ResultTabStrip, RESULT_PANEL_ID, type ResultTab } from "@/components/explore/ResultTabStrip";
import { ExploreList } from "@/components/explore/ExploreList";
import { useSession } from "@/components/Providers";
import { useFeedPage } from "@/hooks/useFeed";
import { useViewerStates } from "@/hooks/useViewerStates";
import { carriedViewerStates } from "@/lib/chain/node-reads";
import { FEED_PAGE_SIZE } from "@/lib/feed/constants";
import { useVote } from "@/hooks/useVote";
import { usePinPost } from "@/hooks/usePinPost";
import { useRepost } from "@/hooks/useRepost";
import { useFollow } from "@/hooks/useFollow";
import { useToaster } from "@/components/toast/ToasterProvider";
import { modalActions } from "@/lib/modalStore";
import { copyToClipboard, postLink } from "@/lib/share";
import { profileRouteForQuery } from "@/lib/ss58";
import { normalizeQuery, isQueryTooShort, MIN_QUERY_LEN } from "@/lib/search";
import { useRecentSearches, recentSearchActions } from "@/lib/recentSearchStore";
import type { CognoPost, FeedQuery, Suggestion, ViewerPostState } from "@/lib/types";
import type { PostActionCallbacks } from "@/components/kit";

const NO_VIEWER: ViewerPostState = { myVote: null, reposted: false };
const SEARCH_DEBOUNCE_MS = 300;
const PEOPLE_LIMIT = 20;
// The firehose + Latest-search page size (one node `state_call` per page since spec-120).
const PAGE_SIZE = FEED_PAGE_SIZE;

export default function ExploreRoute() {
  // useSearchParams() resolves client-side under the static export — wrap in Suspense (mirrors /compose).
  return (
    <Suspense fallback={null}>
      <ExploreView />
    </Suspense>
  );
}

function ExploreView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { api, signer, source, viewer, votingPower } = useSession();

  const me = viewer.address ?? null;
  const searchEnabled = source?.caps.search === true;
  const peopleEnabled = source?.caps.search === true && source?.caps.profiles === true;
  const paginationCapable = source?.caps.pagination === true;
  // Node-first: the firehose is node-served (recency, by id) on every source makeFeedSource builds
  // (papi + hybrid). The node has no score index, so the score-ranked "Top" order is unavailable —
  // the toggle below honestly shows "Most recent" as selected (a node-side score index would flip this).
  const scoreOrderEnabled = false;

  // The committed term is the URL ?q= (normalized so "a  b"/"a b"/NFD accents share one URL + result
  // set); the SearchBar value is a separate local draft.
  const committedQ = normalizeQuery(searchParams.get("q") ?? "");
  const [draft, setDraft] = useState(committedQ);

  // The QUERY result-scope tab lives in the URL (?f=people; the default "latest" is omitted) so results
  // are shareable/bookmarkable and Back restores the scope.
  const resultTab: ResultTab = searchParams.get("f") === "people" ? "people" : "latest";

  // One builder for every /explore URL write so q + f stay in sync (default "latest" omitted). Keep the
  // People scope even with an empty q so editing the query text down to nothing / below the min length
  // doesn't silently reset the tab — it's restored on retype.
  const buildExploreUrl = useCallback((q: string, f: ResultTab) => {
    const params = new URLSearchParams();
    if (q.length > 0) params.set("q", q);
    if (f === "people") params.set("f", f);
    const qs = params.toString();
    return qs ? `/explore/?${qs}` : "/explore/";
  }, []);

  // writeTerm reads the CURRENT tab from a ref (not a captured value) so a debounce timer that fires
  // AFTER a tab switch preserves the tab the user is now on, instead of the tab at schedule time.
  const resultTabRef = useRef(resultTab);
  resultTabRef.current = resultTab;

  // The last term THIS input wrote to the URL. The sync effect uses it to tell our own debounce commits
  // apart from genuinely external URL changes — the single write path so every self-write records itself.
  const selfCommittedRef = useRef(committedQ);
  const writeTerm = useCallback(
    (next: string) => {
      selfCommittedRef.current = next;
      router.replace(buildExploreUrl(next, resultTabRef.current));
    },
    [router, buildExploreUrl],
  );

  // Adopt the URL term into the draft only when it changed from OUTSIDE this input (deep link / rail
  // submit / back-forward), never when it merely echoes what our own debounce just pushed. The old
  // rule adopted on any committedQ≠draft, so a keystroke typed in the tick between our router.replace
  // and the ?q= update was clobbered back to the just-committed (older) term — a dropped character.
  const lastCommitted = useRef(committedQ);
  useEffect(() => {
    if (committedQ !== lastCommitted.current) {
      lastCommitted.current = committedQ;
      // Decide external-vs-self-echo BEFORE updating the ref, then always track the latest committed
      // term so a later Back/Forward to a previously self-written term is still recognised as external
      // (the ref used to go stale, dropping that navigation and desyncing the box).
      const external = committedQ !== selfCommittedRef.current;
      selfCommittedRef.current = committedQ;
      if (external && committedQ !== draft.trim()) setDraft(committedQ);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedQ]);

  // Debounce draft → committed term (router.replace, no history stacking). Skip when search is off.
  useEffect(() => {
    if (!searchEnabled) return;
    const next = normalizeQuery(draft);
    if (next === committedQ) return;
    const t = setTimeout(() => {
      // A checksum-valid account address jumps straight to that profile (text search never matches a
      // raw ss58 address); push (not replace) so Back returns to /explore.
      const accountRoute = profileRouteForQuery(next);
      if (accountRoute) return void router.push(accountRoute);
      // Below the min length: don't run a scan for near-everything — drop any committed term and stay
      // in DEFAULT (the "keep typing" hint shows).
      if (isQueryTooShort(next)) {
        if (committedQ.length > 0) writeTerm("");
        return;
      }
      writeTerm(next);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, committedQ, searchEnabled]);

  const commitNow = useCallback(
    (value: string) => {
      const next = normalizeQuery(value);
      // Enter on a valid account address → jump to that profile (see the debounce effect above).
      const accountRoute = profileRouteForQuery(next);
      if (accountRoute) return void router.push(accountRoute);
      if (isQueryTooShort(next)) {
        if (committedQ.length > 0) writeTerm("");
        return;
      }
      writeTerm(next);
    },
    [router, writeTerm, committedQ],
  );

  const onChangeDraft = useCallback(
    (v: string) => {
      setDraft(v);
      // The clear ✕ sets v === "" — return to DEFAULT immediately (don't wait for the debounce).
      if (v.length === 0 && committedQ.length > 0) writeTerm("");
    },
    [writeTerm, committedQ],
  );

  // Recent searches (device-local). Record a term once it has SETTLED (stable ≥1.2s) so live-typed
  // prefixes ("ab" → "abc" → "abcd") aren't each saved — only the query the user actually landed on.
  const recentSearches = useRecentSearches();
  useEffect(() => {
    if (committedQ.length < MIN_QUERY_LEN) return;
    const t = setTimeout(() => recentSearchActions.push(committedQ), 1200);
    return () => clearTimeout(t);
  }, [committedQ]);
  const onSelectRecent = useCallback(
    (term: string) => {
      setDraft(term);
      commitNow(term);
    },
    [commitNow],
  );

  // autoFocus is a MOUNT-only attribute, so decide it once: focus the box only on a desktop pointer
  // AND a fresh visit (no deep-linked ?q=). Otherwise a shared search link and every Home→Explore tap
  // popped the mobile soft keyboard and scroll-jumped over the results the link meant to show.
  const [autoFocusOnMount] = useState(
    () =>
      typeof window !== "undefined" &&
      committedQ.length === 0 &&
      (window.matchMedia?.("(pointer: fine)")?.matches ?? false),
  );

  // Mode: NO-INDEXER overrides everything; else DEFAULT vs QUERY. A term below MIN_QUERY_LEN (only
  // reachable from an external ?q= — our own writes gate it) stays in DEFAULT rather than running a
  // 1-char scan for near-everything.
  const mode: "no-indexer" | "default" | "query" = !searchEnabled
    ? "no-indexer"
    : committedQ.length >= MIN_QUERY_LEN
      ? "query"
      : "default";

  // "Keep typing" hint: the box has a below-min term (and it isn't a pasted address about to route to
  // a profile), so nothing is searched yet — say so rather than silently showing the firehose.
  // Gate on mode !== "query" too: while backspacing a committed term below the min, committedQ (and so
  // the rendered results) lag by the debounce, so without this the hint would flash over the stale
  // full results for ~300ms.
  const draftNorm = normalizeQuery(draft);
  const showTooShortHint =
    searchEnabled &&
    mode !== "query" &&
    isQueryTooShort(draftNorm) &&
    !profileRouteForQuery(draftNorm);

  // ── DEFAULT firehose order toggle ────────────────────────────────────────────────────────────
  // Default to "Most recent"; "Top" (score) is only reachable when a source advertises score order
  // (none today — see scoreOrderEnabled). effectiveOrder is what's actually served + shown selected.
  const [order, setOrder] = useState<FirehoseOrder>("recency");
  const effectiveOrder: FirehoseOrder = scoreOrderEnabled ? order : "recency";

  // ── QUERY result-scope tab (default Latest, mirrored to ?f=) ──────────────────────────────────
  const setResultTab = useCallback(
    (tab: ResultTab) => router.replace(buildExploreUrl(committedQ, tab)),
    [router, buildExploreUrl, committedQ],
  );
  // When People is unreachable (shouldn't happen since the strip needs caps.search), fall back to Latest.
  const activeResultTab: ResultTab = resultTab === "people" && !peopleEnabled ? "latest" : resultTab;

  // ── DEFAULT firehose / QUERY Latest feed (both via the page seam) ────────────────────────────
  const firehoseQuery = useMemo<FeedQuery>(
    // `viewer: me` lets a spec-120 node stamp the myVote/reposted overlay node-side (PAPI-direct
    // firehose); the keyed + indexer paths ignore it.
    () => ({ first: PAGE_SIZE, order: effectiveOrder, viewer: me ?? undefined }),
    [effectiveOrder, me],
  );
  // The firehose renders in DEFAULT mode AND in NO-INDEXER mode (PAPI-direct still shows the live
  // window, §5.4) — only QUERY mode swaps it out for the result list.
  const firehoseEnabled = mode === "default" || mode === "no-indexer";
  const firehose = useFeedPage(source, firehoseQuery, firehoseEnabled);

  const latestQuery = useMemo<FeedQuery>(
    // `viewer: me` lets a spec-120 node stamp the myVote/reposted overlay node-side (same as the
    // firehose), so search results show my vote/repost state and `carriedViewerStates` skips the
    // per-card viewerPostState read (no flash of unfilled action icons).
    () => ({ first: PAGE_SIZE, search: committedQ, order: "recency", viewer: me ?? undefined }),
    [committedQ, me],
  );
  const latestEnabled = mode === "query" && searchEnabled;
  const latest = useFeedPage(source, latestQuery, latestEnabled);

  // Which post list is on screen (firehose in DEFAULT + NO-INDEXER; Latest results in QUERY).
  const activePosts: CognoPost[] = mode === "query" ? latest.posts : firehose.posts;
  const postIds = useMemo(() => activePosts.map((p) => p.id), [activePosts]);
  // Node-served posts carry the overlay → skip the per-card Reposts scan for those ids.
  const carriedStates = useMemo(() => carriedViewerStates(activePosts), [activePosts]);
  const viewerStates = useViewerStates(source, postIds, me, carriedStates);

  // ── People search (indexer-only) ─────────────────────────────────────────────────────────────
  const [people, setPeople] = useState<Suggestion[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [peopleNonce, setPeopleNonce] = useState(0);
  const peopleActive = mode === "query" && activeResultTab === "people" && peopleEnabled;

  useEffect(() => {
    if (!source || !peopleActive || committedQ.length === 0) {
      setPeople([]);
      setPeopleError(null);
      return;
    }
    let cancelled = false;
    setPeopleLoading(true);
    setPeopleError(null);
    setPeople([]);
    source
      // Fetch one extra so ExploreList can tell a full-but-complete page (exactly PEOPLE_LIMIT) from a
      // genuinely truncated one (a PEOPLE_LIMIT+1th row exists) — search_people has no cursor/total.
      .searchPeople(committedQ, PEOPLE_LIMIT + 1)
      .then((p) => {
        if (!cancelled) setPeople(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) setPeopleError(err instanceof Error ? err.message : "people search failed");
      })
      .finally(() => {
        if (!cancelled) setPeopleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, peopleActive, committedQ, peopleNonce]);

  // ── follow graph (optimistic) — drives People-row FollowButtons ──────────────────────────────
  const follow = useFollow(api, signer, source, me);
  const onToggleFollow = useCallback(
    (target: string, next: boolean) => {
      if (viewer.status !== "ready") {
        router.push("/welcome/");
        return;
      }
      if (next) follow.follow(target);
      else follow.unfollow(target);
    },
    [viewer.status, router, follow],
  );

  // ── write hooks for result/firehose cards ────────────────────────────────────────────────────
  const vote = useVote(api, signer, votingPower ?? 0n);
  const repost = useRepost(api, signer);
  const { pin } = usePinPost(api, signer);
  const { toast } = useToaster();

  // ── per-card action bundle (identical wiring to the home Timeline; surface 10 §3.5/§7.5) ─────
  const handlers = useMemo<PostActionCallbacks>(
    () => ({
      onOpen: (id) => router.push(`/post/${id}/`),
      onAuthorOpen: (address) => router.push(`/u/${address}/`),
      onReply: (post) =>
        viewer.status === "ready" ? modalActions.openReply(post.id) : router.push("/welcome/"),
      onQuote: (post) =>
        viewer.status === "ready" ? modalActions.openQuote(post.id) : router.push("/welcome/"),
      onLike: (post, next) => {
        if (viewer.status !== "ready") return void router.push("/welcome/");
        const cur = viewerStates.get(post.id) ?? NO_VIEWER;
        if (next) vote.like(post.id, cur);
        else vote.unlike(post.id, cur);
      },
      onDownvote: (post, next) => {
        if (viewer.status !== "ready") return void router.push("/welcome/");
        const cur = viewerStates.get(post.id) ?? NO_VIEWER;
        if (next) vote.downvote(post.id, cur);
        else vote.clear(post.id, cur);
      },
      onRepost: (post) => {
        if (viewer.status !== "ready") return void router.push("/welcome/");
        const cur = viewerStates.get(post.id) ?? NO_VIEWER;
        repost.repost(post.id, cur.reposted);
      },
      onShare: (post) => {
        void copyToClipboard(postLink(post.id)).then((ok) =>
          toast(
            ok
              ? { kind: "success", message: "Link copied" }
              : { kind: "error", message: "Couldn't copy the link" },
          ),
        );
      },
      onPin: (post) => pin(post.id),
    }),
    [router, viewer.status, viewerStates, vote, repost, pin, toast],
  );

  // The "/" focus shortcut is now app-wide (useSearchHotkey in AppShell) — no per-surface effect here.

  // ── result-count live summary (polite) ───────────────────────────────────────────────────────
  const liveSummary =
    mode === "query"
      ? activeResultTab === "people"
        ? peopleLoading
          ? ""
          : `${people.length} ${people.length === 1 ? "person" : "people"} for ${committedQ}`
        : latest.loading
          ? ""
          : `${activePosts.length} ${activePosts.length === 1 ? "result" : "results"} for ${committedQ}`
      : "";

  const firehoseLoading = firehose.loading && firehose.posts.length === 0;
  const latestLoading = latest.loading && latest.posts.length === 0;

  return (
    <>
      {/* sticky blurred header: the SearchBar + (DEFAULT) order toggle / (QUERY) result tabs */}
      <header className={styles.header}>
        <div className={styles.searchRow}>
          <SearchBar
            value={draft}
            onChange={onChangeDraft}
            onSubmit={commitNow}
            searchEnabled={searchEnabled}
            autoFocus={autoFocusOnMount}
            loading={mode === "query" && (latest.loading || peopleLoading)}
            recent={recentSearches}
            onSelectRecent={onSelectRecent}
            onRemoveRecent={recentSearchActions.remove}
            onClearRecent={recentSearchActions.clear}
          />
        </div>
        {/* Score ("Top") order isn't served yet (scoreOrderEnabled=false → the only reachable state is
            "Most recent"), so hide the toggle rather than show a permanently-disabled control. Flip
            scoreOrderEnabled back to true to restore it — no other change needed. */}
        {mode === "default" && scoreOrderEnabled && (
          <FirehoseOrderToggle
            value={effectiveOrder}
            onChange={setOrder}
            scoreEnabled={scoreOrderEnabled}
          />
        )}
        {mode === "query" && peopleEnabled && (
          <ResultTabStrip active={activeResultTab} onChange={setResultTab} />
        )}
        {showTooShortHint && (
          <p className={styles.tooShortHint} role="status">
            Keep typing to search — at least {MIN_QUERY_LEN} characters.
          </p>
        )}
      </header>

      {/* visually-hidden polite live region for result-count announcements (§9) */}
      <p className={styles.srOnly} aria-live="polite">
        {liveSummary}
      </p>

      <section
        id={RESULT_PANEL_ID}
        role={mode === "query" && peopleEnabled ? "tabpanel" : "region"}
        aria-labelledby={
          mode === "query" && peopleEnabled ? `cg-explore-tab-${activeResultTab}` : undefined
        }
        aria-label={mode === "query" ? undefined : "Explore"}
        aria-busy={
          (mode === "query" && activeResultTab === "people" && peopleLoading) || undefined
        }
      >
        {mode === "no-indexer" ? (
          <NoIndexerBody firehose={renderFirehose()} router={router} />
        ) : mode === "default" ? (
          renderFirehose()
        ) : activeResultTab === "people" ? (
          <ExploreList
            people={people}
            viewer={viewer}
            query={committedQ}
            loading={peopleLoading}
            error={peopleError}
            onRetry={() => setPeopleNonce((n) => n + 1)}
            isFollowing={follow.isFollowing}
            onToggleFollow={onToggleFollow}
            limit={PEOPLE_LIMIT}
          />
        ) : (
          <Timeline
            posts={latest.posts}
            gate={viewer}
            viewerStates={viewerStates}
            handlers={handlers}
            loading={latestLoading}
            error={latest.error}
            hasMore={latest.hasNextPage}
            onLoadMore={latest.loadMore}
            loadingMore={latest.loading}
            paginationCapable={paginationCapable}
            emptyVariant="feed"
            emptyTitle={`No results for "${committedQ}"`}
            emptyDescription="Try different keywords."
            api={api}
            signer={signer}
            highlight={committedQ}
          />
        )}
      </section>
    </>
  );

  // The firehose Timeline — shared by DEFAULT mode and the NO-INDEXER firehose (which still renders).
  function renderFirehose() {
    return (
      <Timeline
        posts={firehose.posts}
        gate={viewer}
        viewerStates={viewerStates}
        handlers={handlers}
        loading={firehoseLoading}
        error={firehose.error}
        hasMore={firehose.hasNextPage}
        onLoadMore={firehose.loadMore}
        loadingMore={firehose.loading}
        paginationCapable={paginationCapable}
        emptyVariant="feed"
        emptyTitle="Nothing here yet"
        emptyDescription="Be the first to post."
        emptyAction={{ label: "Go home", onClick: () => router.push("/") }}
        api={api}
        signer={signer}
      />
    );
  }
}

// NO-INDEXER body: the firehose still renders (PAPI live window), and the search-unavailable
// EmptyState sits ABOVE it so a user who reaches for search is told why + linked to Settings (§7.4).
function NoIndexerBody({
  firehose,
  router,
}: {
  firehose: React.ReactNode;
  router: ReturnType<typeof useRouter>;
}) {
  return (
    <>
      <EmptyState
        variant="search-unavailable"
        action={{ label: "Open settings", onClick: () => router.push("/settings/") }}
      />
      {firehose}
    </>
  );
}
