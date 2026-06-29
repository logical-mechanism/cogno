"use client";

// ExplorePage — /explore (surface 10). The search-first discovery surface. A full-width SearchBar in
// a sticky blurred header; below it two modes derived from the URL term `q` (read client-side via
// useSearchParams) + feedSource.caps.search:
//
//   caps.search === false → NO-INDEXER  : SearchBar disabled + `search-unavailable` EmptyState in the
//                                          results area; the firehose still renders (PAPI live window).
//   caps.search === true, q === ''       → DEFAULT : firehose Timeline + FirehoseOrderToggle (Top|Recent).
//   caps.search === true, q !== ''       → QUERY   : ResultTabStrip (People | Latest) + result list.
//
// `q` is the committed term (mirrored to ?q=). The SearchBar's controlled value is a SEPARATE local
// `draft` that debounces into `q` (300ms) while typing — router.replace (not push) so keystroke term
// changes never stack history; Enter commits immediately; the clear ✕ → router.replace('/explore').
//
// The firehose + Latest both use useFeedPage(source, …) — it serves a single live window on PAPI-direct
// (no search/after/following → no throw) and full cursor pagination on the indexer; the Timeline's
// `paginationCapable` flag picks infinite-scroll vs the quiet "connect an indexer to load more" footer.
// People search uses source.searchPeople (indexer-only). Every result-card write is optimistic and
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
  const scoreOrderEnabled = source?.kind === "graphql"; // PAPI-direct has no score ordering

  // The committed term is the URL ?q=; the SearchBar value is a separate local draft.
  const committedQ = (searchParams.get("q") ?? "").trim();
  const [draft, setDraft] = useState(committedQ);

  // Keep the draft in sync when the URL term changes from OUTSIDE this input (deep link / rail submit /
  // back-forward) — but never clobber what the user is mid-typing (only adopt when they actually differ
  // after trim AND the draft isn't a superset being debounced; simplest correct rule: adopt on mount +
  // whenever the committed term changes to something the draft's trim doesn't already equal).
  const lastCommitted = useRef(committedQ);
  useEffect(() => {
    if (committedQ !== lastCommitted.current) {
      lastCommitted.current = committedQ;
      if (committedQ !== draft.trim()) setDraft(committedQ);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedQ]);

  // Debounce draft → committed term (router.replace, no history stacking). Skip when search is off.
  useEffect(() => {
    if (!searchEnabled) return;
    const next = draft.trim();
    if (next === committedQ) return;
    const t = setTimeout(() => {
      router.replace(next.length > 0 ? `/explore/?q=${encodeURIComponent(next)}` : "/explore/");
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, committedQ, searchEnabled]);

  const commitNow = useCallback(
    (value: string) => {
      const next = value.trim();
      router.replace(next.length > 0 ? `/explore/?q=${encodeURIComponent(next)}` : "/explore/");
    },
    [router],
  );

  const onChangeDraft = useCallback(
    (v: string) => {
      setDraft(v);
      // The clear ✕ sets v === "" — return to DEFAULT immediately (don't wait for the debounce).
      if (v.length === 0 && committedQ.length > 0) router.replace("/explore/");
    },
    [router, committedQ],
  );

  // Mode: NO-INDEXER overrides everything; else DEFAULT (empty term) vs QUERY (term present).
  const mode: "no-indexer" | "default" | "query" = !searchEnabled
    ? "no-indexer"
    : committedQ.length > 0
      ? "query"
      : "default";

  // ── DEFAULT firehose order toggle ────────────────────────────────────────────────────────────
  // Default to "Top" (score) on the indexer; force "recency" on PAPI-direct (no score order).
  const [order, setOrder] = useState<FirehoseOrder>("score");
  const effectiveOrder: FirehoseOrder = scoreOrderEnabled ? order : "recency";

  // ── QUERY result-scope tab (default Latest) ──────────────────────────────────────────────────
  const [resultTab, setResultTab] = useState<ResultTab>("latest");
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
    () => ({ first: PAGE_SIZE, search: committedQ, order: "recency" }),
    [committedQ],
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
      .searchPeople(committedQ, PEOPLE_LIMIT)
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
        const url = `${typeof window !== "undefined" ? window.location.origin : ""}/post/${post.id}/`;
        void navigator.clipboard
          ?.writeText(url)
          .then(() => toast({ kind: "success", message: "Link copied" }))
          .catch(() => toast({ kind: "error", message: "Couldn't copy the link" }));
      },
      onPin: (post) => pin(post.id),
    }),
    [router, viewer.status, viewerStates, vote, repost, pin, toast],
  );

  // ── "/" global shortcut: focus the SearchBar (X parity, §9). Ignore while typing / a modal is open. ─
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable === true;
      if (typing) return;
      // A modal/composer open → don't steal the slash.
      if (document.querySelector("[role='dialog']")) return;
      const input = document.querySelector<HTMLInputElement>(
        "[role='search'] input[type='search']",
      );
      if (input) {
        e.preventDefault();
        input.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
            autoFocus
            loading={mode === "query" && (latest.loading || peopleLoading)}
          />
        </div>
        {mode === "default" && (
          <FirehoseOrderToggle
            value={order}
            onChange={setOrder}
            scoreEnabled={scoreOrderEnabled}
          />
        )}
        {mode === "query" && peopleEnabled && (
          <ResultTabStrip active={activeResultTab} onChange={setResultTab} />
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
