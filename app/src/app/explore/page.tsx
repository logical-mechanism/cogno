"use client";

// ExplorePage — /explore. The search-first discovery surface. A full-width SearchBar in
// a sticky blurred header; below it three modes, derived from whether a reader is connected and from
// the URL term `q` (read client-side via useSearchParams):
//
//   no source yet  → NO-SOURCE : the reader isn't connected — SearchBar disabled +
//                                `search-unavailable` EmptyState; the firehose still renders.
//   source, q ===  '' → DEFAULT : firehose Timeline + FirehoseControls (order ?s= + role lens ?r=).
//   source, q !== '' → QUERY   : ResultTabStrip (People | Latest) + result list. When the term is
//                                exactly one #hashtag this is also the TOPIC surface (TopicHeader).
//
// `?s=` (order) and `?r=` (role lens) are DERIVED values, deliberately NOT a fourth `mode` — `mode` has
// many read sites and none of them need to know. A ranked order re-sorts ONE window (there is no score
// index to page) and therefore does not paginate; see lib/feed/rank for why that is a hard constraint
// rather than a shortcut.
//
// `q` is the committed term (mirrored to ?q=). The SearchBar's controlled value is a SEPARATE local
// `draft` that debounces into `q` (300ms) while typing — router.replace (not push) so keystroke term
// changes never stack history; Enter commits immediately; the clear ✕ → router.replace('/explore').
//
// The firehose + Latest both use useFeedPage(source, …), both node-direct: the firehose via feed_page
// (recency by id, cursor-paginated), Latest via search_posts (the in-runtime substring scan). Both
// paginate, so the Timeline shows infinite-scroll for each. People search uses source.searchPeople
// (search_people). Every result-card write is optimistic and funnels disconnected/unbound viewers to
// /welcome; capacity exhaustion → RateLimitNotice toast. No honesty/block-number chrome anywhere.
//
// useSearchParams() requires a <Suspense> boundary under output:'export' (mirrors /compose) — the route
// default mounts <ExploreView> inside one.
//

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "./page.module.css";
import { SearchBar } from "@/components/SearchBar";
import { Timeline } from "@/components/Timeline";
import { EmptyState } from "@/components/EmptyState";
import { Loading } from "@/components/Loading";
import { ResultTabStrip, RESULT_PANEL_ID, type ResultTab } from "@/components/explore/ResultTabStrip";
import { ExploreList } from "@/components/explore/ExploreList";
import { FirehoseControls, LENSES } from "@/components/explore/FirehoseControls";
import { TopicHeader } from "@/components/explore/TopicHeader";
import { FollowedTopics } from "@/components/explore/FollowedTopics";
import { useSession } from "@/components/Providers";
import { useFeedPage } from "@/hooks/useFeed";
import { usePostActions } from "@/hooks/usePostActions";
import { useViewerStates } from "@/hooks/useViewerStates";
import { carriedViewerStates } from "@/lib/chain/node-reads";
import { FEED_PAGE_SIZE } from "@/lib/feed/constants";
import { useVote } from "@/hooks/useVote";
import { usePinPost } from "@/hooks/usePinPost";
import { useFollow } from "@/hooks/useFollow";
import { useModeration } from "@/hooks/useModeration";
import { useToaster } from "@/components/toast/ToasterProvider";
import { profileRouteForQuery } from "@/lib/ss58";
import { normalizeQuery, isQueryTooShort, MIN_QUERY_LEN } from "@/lib/search";
import { useRecentSearches, recentSearchActionsFor } from "@/lib/recentSearchStore";
import { readErrorCopy } from "@/lib/chain/errors";
import {
  parseSort,
  isRanked,
  rankWindow,
  isUndifferentiated,
  RANK_WINDOW,
  type Sort,
} from "@/lib/feed/rank";
import { topicOfQuery } from "@/lib/topics";
import { topicActionsFor, useTopicFollowed, useFollowedTopics } from "@/lib/topicStore";
import { viewerBucket } from "@/lib/viewerBucket";
import type { RoleKindType } from "@/lib/chain/roles";
import type { CognoPost, FeedQuery, Suggestion } from "@/lib/types";

const SEARCH_DEBOUNCE_MS = 300;
const PEOPLE_LIMIT = 20;
// The firehose + Latest-search page size (one node `state_call` per page since spec-120).
const PAGE_SIZE = FEED_PAGE_SIZE;

/** Narrow an untrusted `?r=` value to an offered lens. Anything else (incl. `Committee`, which the
 *  observer can never populate) means "no lens". */
function parseLens(raw: string | null): RoleKindType | null {
  return LENSES.includes(raw as RoleKindType) ? (raw as RoleKindType) : null;
}

export default function ExploreRoute() {
  // useSearchParams() resolves client-side under the static export — wrap in Suspense (mirrors /compose).
  return (
    <Suspense fallback={<Loading variant="surface" label="Loading Explore…" />}>
      <ExploreView />
    </Suspense>
  );
}

function ExploreView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { api, signer, source, viewer, votingPower } = useSession();

  const me = viewerBucket(viewer);
  const searchEnabled = source != null;
  const peopleEnabled = source != null;
  const paginationCapable = source != null;

  // The committed term is the URL ?q= (normalized so "a  b"/"a b"/NFD accents share one URL + result
  // set); the SearchBar value is a separate local draft.
  const committedQ = normalizeQuery(searchParams.get("q") ?? "");
  const [draft, setDraft] = useState(committedQ);

  // The QUERY result-scope tab lives in the URL (?f=people; the default "latest" is omitted) so results
  // are shareable/bookmarkable and Back restores the scope.
  const resultTab: ResultTab = searchParams.get("f") === "people" ? "people" : "latest";

  // DEFAULT-mode firehose order (?s=) and verified-role lens (?r=). Both are DERIVED values, NOT a fourth
  // `mode`: `mode` has many read sites below and every one of them stays untouched. Same discipline the
  // topic surface uses — a topic is just a ?q= whose term happens to be one tag.
  const sort = parseSort(searchParams.get("s"));
  const lens = parseLens(searchParams.get("r"));

  // One builder for every /explore URL write so q + f + s + r stay in sync (defaults omitted). Keep the
  // People scope even with an empty q so editing the query text down to nothing / below the min length
  // doesn't silently reset the tab — it's restored on retype.
  //
  // EVERY param must be threaded through here. This rebuilds the query string FROM SCRATCH, so a param
  // that isn't passed is ERASED by the next write — and the next write is any keystroke (the debounce
  // calls writeTerm) or any result-tab switch.
  const buildExploreUrl = useCallback(
    (q: string, f: ResultTab, s: Sort, r: RoleKindType | null) => {
      const params = new URLSearchParams();
      if (q.length > 0) params.set("q", q);
      if (f === "people") params.set("f", f);
      if (s !== "latest") params.set("s", s);
      if (r !== null) params.set("r", r);
      const qs = params.toString();
      return qs ? `/explore/?${qs}` : "/explore/";
    },
    [],
  );

  // writeTerm reads the CURRENT tab/order/lens from refs (not captured values) so a debounce timer that
  // fires AFTER a switch preserves what the user is now on, instead of the value at schedule time.
  const resultTabRef = useRef(resultTab);
  resultTabRef.current = resultTab;
  const sortRef = useRef(sort);
  sortRef.current = sort;
  const lensRef = useRef(lens);
  lensRef.current = lens;

  // The last term THIS input wrote to the URL. The sync effect uses it to tell our own debounce commits
  // apart from genuinely external URL changes — the single write path so every self-write records itself.
  const selfCommittedRef = useRef(committedQ);
  const writeTerm = useCallback(
    (next: string) => {
      selfCommittedRef.current = next;
      router.replace(buildExploreUrl(next, resultTabRef.current, sortRef.current, lensRef.current));
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

  // Commit a NORMALIZED term — shared by the typed-debounce and the Enter/submit paths so they never
  // drift: a checksum-valid account address jumps straight to that profile (text search never matches a
  // raw ss58 address; push, not replace, so Back returns to /explore); a below-min ASCII term drops any
  // committed term and stays in DEFAULT (the "keep typing" hint shows); otherwise it becomes the term.
  const commitTerm = useCallback(
    (next: string) => {
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

  // Debounce draft → committed term (router.replace, no history stacking). Skip when search is off.
  useEffect(() => {
    if (!searchEnabled) return;
    const next = normalizeQuery(draft);
    if (next === committedQ) return;
    const t = setTimeout(() => commitTerm(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, committedQ, searchEnabled]);

  // Enter / explicit submit: commit immediately (no debounce).
  const commitNow = useCallback((value: string) => commitTerm(normalizeQuery(value)), [commitTerm]);

  const onChangeDraft = useCallback(
    (v: string) => {
      setDraft(v);
      // The clear ✕ sets v === "" — return to DEFAULT immediately (don't wait for the debounce).
      if (v.length === 0 && committedQ.length > 0) writeTerm("");
    },
    [writeTerm, committedQ],
  );

  // When the committed query is exactly one #hashtag, this is the TOPIC surface: the same search, narrowed
  // to an exact tag. Null for every other query (a multi-term query stays a plain search). Derived ONCE,
  // here, and threaded to every read site below — two independent `topicOfQuery(committedQ)` calls could
  // drift, and the Follow control would then toggle a tag the surface is not showing.
  const topic = useMemo(() => topicOfQuery(committedQ), [committedQ]);

  // Followed topics (device-local, per account) — the strip in DEFAULT mode + the Follow control on the
  // topic band. `useFollowedTopics` subscribes, so following a topic updates the strip immediately.
  const topicActions = useMemo(() => topicActionsFor(me), [me]);
  const topicFollowed = useTopicFollowed(topic, me);
  const followedTopics = useFollowedTopics(me);

  // Recent searches (device-local). Record a term once it has SETTLED (stable ≥1.2s) so live-typed
  // prefixes ("ab" → "abc" → "abcd") aren't each saved — only the query the user actually landed on.
  const recentSearches = useRecentSearches(me);
  const recentSearchActions = useMemo(() => recentSearchActionsFor(me), [me]);
  useEffect(() => {
    // Gate on the SAME isQueryTooShort predicate as `mode` (not raw .length) so a committed single
    // non-ASCII/CJK term — which DID run a search — is also recorded, while below-min ASCII is skipped.
    if (committedQ.length === 0 || isQueryTooShort(committedQ)) return;
    const t = setTimeout(() => recentSearchActions.push(committedQ), 1200);
    return () => clearTimeout(t);
    // `recentSearchActions` is memoized on `me`, so listing it would restart the settle timer on an
    // account switch — recording the term under whichever account you landed on. Keyed on the TERM: the
    // pending write targets the account that was connected when the term settled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Mode: DISCONNECTED overrides everything; else DEFAULT vs QUERY. Gate on the SAME isQueryTooShort
  // predicate the write paths use (NOT raw .length): a single non-ASCII/CJK char is a complete word the
  // node's byte-substring scan can match, so it must SEARCH — using raw .length here silently dropped
  // it back to the firehose. A below-min ASCII term (only reachable from an external ?q=, since our own
  // writes gate it) still stays in DEFAULT with the "keep typing" hint.
  const mode: "disconnected" | "default" | "query" = !searchEnabled
    ? "disconnected"
    : committedQ.length > 0 && !isQueryTooShort(committedQ)
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

  // ── QUERY result-scope tab (default Latest, mirrored to ?f=) ───────────────────────────────────
  const setResultTab = useCallback(
    (tab: ResultTab) => router.replace(buildExploreUrl(committedQ, tab, sortRef.current, lensRef.current)),
    [router, buildExploreUrl, committedQ],
  );

  // ── DEFAULT firehose order + role lens (mirrored to ?s= / ?r=, defaults omitted) ────────────────
  // `replace`, not `push`: flipping an order is not a navigation step, and stacking history on every
  // chip tap would make Back walk sort states instead of leaving the surface. Both leave `selfCommittedRef`
  // ALONE — it tracks the search TERM, and touching it here would desync the search box.
  const setSort = useCallback(
    (next: Sort) => router.replace(buildExploreUrl(committedQ, resultTabRef.current, next, lensRef.current)),
    [router, buildExploreUrl, committedQ],
  );
  const setLens = useCallback(
    (next: RoleKindType | null) =>
      router.replace(buildExploreUrl(committedQ, resultTabRef.current, sortRef.current, next)),
    [router, buildExploreUrl, committedQ],
  );
  // When People is unreachable, fall back to Latest.
  const activeResultTab: ResultTab = resultTab === "people" && !peopleEnabled ? "latest" : resultTab;

  // ── DEFAULT firehose / QUERY Latest feed (both via the page seam) ──────────────────────────────
  const firehoseQuery = useMemo<FeedQuery>(
    // `viewer: me` lets the node stamp the myVote overlay node-side, in the same state_call.
    //
    // A RANKED order pulls the whole runtime page (RANK_WINDOW) instead of PAGE_SIZE, because for a
    // ranking the window IS the claim: it must be one read at one block, or ages and engagement would
    // come from two different clocks. Changing `first` changes useFeed's queryKey, which DISCARDS the
    // previous order's list — correct, since two orders have different pagination semantics and must
    // never share an array.
    () => ({
      first: isRanked(sort) ? RANK_WINDOW : PAGE_SIZE,
      viewer: me ?? undefined,
      ...(lens !== null ? { role: lens } : {}),
    }),
    [me, sort, lens],
  );
  // The firehose renders in DEFAULT mode AND in DISCONNECTED mode (it still shows the live
  // window) — only QUERY mode swaps it out for the result list.
  const firehoseEnabled = mode === "default" || mode === "disconnected";
  const firehose = useFeedPage(source, firehoseQuery, firehoseEnabled);

  const latestQuery = useMemo<FeedQuery>(
    // `viewer: me` lets the node stamp the `myVote` overlay node-side (same as the
    // firehose), so search results show my vote state and `carriedViewerStates` skips the
    // per-card viewerPostState read (no flash of unfilled action icons).
    () => ({
      first: PAGE_SIZE,
      search: committedQ,
      viewer: me ?? undefined,
      ...(topic !== null ? { topic } : {}),
    }),
    [committedQ, me, topic],
  );
  // Deliberately NOT gated on the active result tab. `useFeedPage` treats `enabled: false` as DISCARD,
  // not pause — it clears `posts` and the cursor — so tying this to the tab would throw away every loaded
  // page the moment you looked at People, and re-run the whole `search_posts` scan from page 1 on the way
  // back. The read this gating existed to avoid is the per-card `useViewerStates` fan-out, which is
  // skipped below on the ids instead.
  const latestEnabled = mode === "query" && searchEnabled;
  const latest = useFeedPage(source, latestQuery, latestEnabled);

  // ── the list that is actually RENDERED ─────────────────────────────────────────────────────────
  // Timeline removes blocked authors and hidden posts from the array it is handed, so every guard and
  // every disclosure on this surface has to be computed from the SURVIVORS, not from the raw read.
  // Reading `firehose.posts` for those was wrong twice over: a window whose posts are all suppressed
  // renders empty while the "did the lens find anything" guard says it found plenty (the runaway below),
  // and "Sorting the 20 most recent posts by …" printed above 12 rows is a false sentence in the copy
  // FirehoseControls itself calls the feature's honesty guarantee.
  //
  // Timeline still filters what we pass (its contract is unchanged for every other caller); a second
  // pass over an already-filtered array is a no-op.
  const mod = useModeration(me);
  const visibleFirehose = useMemo(() => mod.filterPosts(firehose.posts), [mod, firehose.posts]);
  const visibleLatest = useMemo(() => mod.filterPosts(latest.posts), [mod, latest.posts]);

  // Which post list is on screen (firehose in DEFAULT + DISCONNECTED; Latest results in QUERY).
  const activePosts: CognoPost[] = mode === "query" ? visibleLatest : visibleFirehose;
  // Empty while People is on screen: those cards are not rendered, so their viewer overlay is a read of
  // up to PAGE_SIZE posts nobody is looking at. The posts themselves stay loaded (see above).
  const showingPosts = mode !== "query" || activeResultTab === "latest";
  const postIds = useMemo(
    () => (showingPosts ? activePosts.map((p) => p.id) : []),
    [showingPosts, activePosts],
  );
  // Node-served posts carry the overlay → skip the per-card viewer read for those ids.
  const carriedStates = useMemo(() => carriedViewerStates(activePosts), [activePosts]);
  const viewerStates = useViewerStates(source, postIds, me, carriedStates);

  // ── People search (node-served) ────────────────────────────────────────────────────────────────
  const [people, setPeople] = useState<Suggestion[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [peopleNonce, setPeopleNonce] = useState(0);
  const peopleActive = mode === "query" && activeResultTab === "people" && peopleEnabled;

  // A blocked account never shows in People results (hard suppression, viewer-side) — the same
  // moderation the post lists above are filtered through, so the two can't disagree.
  const visiblePeople = useMemo(
    () => people.filter((p) => !mod.isBlocked(p.author)),
    [people, mod],
  );

  useEffect(() => {
    if (!source || !peopleActive || committedQ.length === 0) {
      setPeople([]);
      setPeopleError(null);
      // Also clear the loading flag here: switching People→Latest mid-fetch cancels the in-flight
      // promise (its `.finally` is skipped by the `!cancelled` guard) and re-runs this effect into the
      // early return, which otherwise left `peopleLoading` stuck true — spinning the search field on the
      // Latest tab over already-loaded results.
      setPeopleLoading(false);
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
        if (!cancelled) setPeopleError(readErrorCopy(err, "People search failed."));
      })
      .finally(() => {
        if (!cancelled) setPeopleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, peopleActive, committedQ, peopleNonce]);

  // ── follow graph (optimistic) — drives People-row FollowButtons ────────────────────────────────
  const follow = useFollow(api, signer, source, me);
  const onToggleFollow = useCallback(
    (target: string, next: boolean) => {
      if (!viewer.writeReady) {
        router.push("/welcome/");
        return;
      }
      if (next) follow.follow(target);
      else follow.unfollow(target);
    },
    [viewer.writeReady, router, follow],
  );

  // ── write hooks for result/firehose cards ──────────────────────────────────────────────────────
  const vote = useVote(api, signer, votingPower ?? 0n);
  const { pin } = usePinPost(api, signer);
  const { toast } = useToaster();

  // ── per-card action bundle (identical wiring to the home Timeline) ─────────────────────────────
  const handlers = usePostActions({ viewer, viewerStates, vote, pin, toast, follow });

  // The "/" focus shortcut is now app-wide (useSearchHotkey in AppShell) — no per-surface effect here.

  // ── result-count live summary (polite) ─────────────────────────────────────────────────────────
  // People fetches PEOPLE_LIMIT+1 as a truncation probe but ExploreList renders only PEOPLE_LIMIT, so the
  // announced count is clamped to what's on screen (else a screen reader says "21 people" over 20 rows).
  const peopleShown = Math.min(visiblePeople.length, PEOPLE_LIMIT);
  const liveSummary =
    mode === "query"
      ? activeResultTab === "people"
        ? peopleLoading
          ? ""
          : peopleError
            ? // Announce the failure, not a false "0 people" — else a screen reader hears no-results and
              // never discovers the visible "Couldn't run that search." + Retry.
              "Couldn't run that search."
            : `${peopleShown} ${peopleShown === 1 ? "person" : "people"} for ${committedQ}`
        : latest.loading
          ? ""
          : `${activePosts.length} ${activePosts.length === 1 ? "result" : "results"} for ${committedQ}`
      : "";

  const firehoseLoading = firehose.loading && firehose.posts.length === 0;
  const latestLoading = latest.loading && latest.posts.length === 0;

  // ── the ranked window ──────────────────────────────────────────────────────────────────────────
  // The reference block for `hot`'s age term, FROZEN per window read rather than read from a ticking
  // clock: a moving reference would silently re-order rows under the user's cursor between renders.
  // The newest post in the window is the best in-band proxy for "now" (the window came from one
  // best-block read, so its head IS that block, near enough for a decay term).
  const headBlock = useMemo(
    () => visibleFirehose.reduce((max, p) => (p.at > max ? p.at : max), 0),
    [visibleFirehose],
  );
  const rankedPosts = useMemo(
    () => (isRanked(sort) ? rankWindow(visibleFirehose, sort, headBlock) : visibleFirehose),
    [visibleFirehose, sort, headBlock],
  );
  // When every post ties on the active key the ranking reproduces recency, and the disclosure says so.
  // This — NOT a window-size threshold — is how a corpus too small to order tells the truth. A threshold
  // was worse in three ways: it hid the "Everyone" chip that clears an active LENS (one click in, no
  // click out), it hid a ranking that was still being applied to a deep-linked `?s=`, and because the
  // un-ranked fallback paginates, the growing window would cross the threshold and switch the ranking on
  // mid-scroll over an array assembled from several reads at different blocks.
  const undifferentiated = useMemo(
    () => isUndifferentiated(visibleFirehose, sort),
    [visibleFirehose, sort],
  );

  // Show the controls wherever they are HONOURED: a served source, in DEFAULT mode. Both axes are applied
  // in exactly that case, so the control and the effect can never disagree.
  //
  // DISCONNECTED is excluded deliberately: `renderFirehose()` still mounts there over an always-empty
  // array, so a shared /explore/?s=hot opened while the chain is unreachable would otherwise render
  // nothing underneath a ranking claim.
  const showFirehoseControls = source != null && mode === "default";

  // ── the filtered-surface runaway ────────────────────────────────────────────────────────────────
  //
  // A LENS and a TOPIC both run the reader on a bounded hop budget (FILTERED_LENS_MAX_HOPS), so each can
  // legitimately hand back an EMPTY page plus a live cursor, which is what starts the auto-loading tail
  // walking the cursor down to post id 0 to append nothing. /explore used to carry its own guard for
  // exactly this, on exactly these two axes. It now lives in Timeline (`lastPage` → lib/feed/tail.ts),
  // where the moderation filter is — so it covers Home, profile and /lists too, and covers the block/hide
  // axis this surface's copy never could. Passing `page.posts` down is the whole wiring.

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
        {showFirehoseControls && (
          <FirehoseControls
            sort={sort}
            onSortChange={setSort}
            lens={lens}
            onLensChange={setLens}
            windowSize={rankedPosts.length}
            undifferentiated={undifferentiated}
          />
        )}
        {topic !== null && mode === "query" && activeResultTab === "latest" && (
          <TopicHeader
            topic={topic}
            followed={topicFollowed}
            onToggleFollow={() => topicActions.toggle(topic)}
            loading={latestLoading}
            empty={!latest.loading && visibleLatest.length === 0}
          />
        )}
        {mode === "default" && <FollowedTopics topics={followedTopics} />}
        {mode === "query" && peopleEnabled && (
          <ResultTabStrip active={activeResultTab} onChange={setResultTab} />
        )}
        {showTooShortHint && (
          <p className={styles.tooShortHint} role="status">
            Type at least {MIN_QUERY_LEN} characters to search.
          </p>
        )}
      </header>

      {/* visually-hidden polite live region for result-count announcements */}
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
        {mode === "disconnected" ? (
          <DisconnectedBody firehose={renderFirehose()} router={router} />
        ) : mode === "default" ? (
          renderFirehose()
        ) : activeResultTab === "people" ? (
          <ExploreList
            people={visiblePeople}
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
            posts={visibleLatest}
            gate={viewer}
            viewerStates={viewerStates}
            handlers={handlers}
            loading={latestLoading}
            error={latest.error}
            hasMore={latest.hasNextPage}
            onLoadMore={latest.loadMore}
            loadingMore={latest.loading}
            paginationCapable={paginationCapable}
            lastPage={latest.page?.posts ?? null}
            emptyVariant="feed"
            emptyTitle={
              topic !== null ? `No recent posts tagged #${topic}` : `No results for "${committedQ}"`
            }
            emptyDescription={
              topic !== null
                ? "No recent posts have this tag."
                : "Try different keywords."
            }
            highlight={committedQ}
          />
        )}
      </section>
    </>
  );

  // The firehose Timeline — shared by DEFAULT mode and the DISCONNECTED firehose (still renders).
  function renderFirehose() {
    // A RANKED window MUST NOT paginate and MUST NEVER be handed loadMore/refresh. A cursor is monotone
    // in id and a rank is not, so "load more" would interleave and duplicate rows; and the load-more /
    // refresh merge ends in a sort by id, which would silently dissolve the ranking back into recency —
    // reading to the user as a broken control rather than a design limit. One window, no pagination.
    // A ranked window still must not paginate — that is about ORDER, not about suppression, so it stays
    // here rather than moving into the tail decision.
    const frozen = isRanked(sort);
    // The lens copy must not claim a scan happened where none did: DISCONNECTED mounts this same tree
    // with no source and an always-empty array.
    const lensEmpty = lens !== null && source != null;
    return (
      <Timeline
        posts={rankedPosts}
        gate={viewer}
        viewerStates={viewerStates}
        handlers={handlers}
        loading={firehoseLoading}
        error={firehose.error}
        hasMore={frozen ? false : firehose.hasNextPage}
        onLoadMore={frozen ? undefined : firehose.loadMore}
        loadingMore={firehose.loading}
        paginationCapable={frozen ? false : paginationCapable}
        lastPage={firehose.page?.posts ?? null}
        emptyVariant="feed"
        emptyTitle={lensEmpty ? "Nothing from these accounts yet" : "Nothing here yet"}
        emptyDescription={
          lensEmpty
            ? `Nobody with a verified ${lens === "Spo" ? "SPO" : "dRep"} badge has posted recently. Choose Everyone to see everyone's posts.`
            : "Be the first to post."
        }
        emptyAction={{ label: "Go home", onClick: () => router.push("/") }}
      />
    );
  }
}

// DISCONNECTED body: the firehose still renders (the live window), and the search-unavailable
// EmptyState sits ABOVE it so a user who reaches for search is told why + linked to Settings.
function DisconnectedBody({
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
