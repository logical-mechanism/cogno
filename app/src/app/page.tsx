"use client";

// HomePage — the Home route '/'. The default landing surface: a sticky header carrying the
// TimelineTabs (For you / Following), an inline Composer at the top (desktop/tablet), a "Show N posts"
// new-posts pill, and the Timeline of PostCards. Every write is optimistic; the only chain realities
// surfaced are a graceful rate-limit notice + a quiet failure toast. No honesty/block-number chrome.
//
// Two tabs:
//   • For you   — useLiveFeed(source) id-paged live feed (NextPostId-driven; "load more" reads one
//                 page at a time). Fresh OTHER-author items buffer behind the pill (the scroll never
//                 jumps); the viewer's OWN optimistic post injects directly.
//   • Following — useFeedPage(source, { tab:'following', followeeOf, first }, enabled); skipped +
//                 shows the follows empty-state when the viewer follows nobody / is disconnected. The
//                 node serves the Following timeline directly (spec-120 following_feed_page), so the
//                 node serves the Following timeline directly, so the tab is always available.
//
// One socket: everything reads from useSession(); this page never instantiates a client.
//

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { StickyHeader } from "@/components/AppShell";
import { TimelineTabs, type TimelineTab } from "@/components/TimelineTabs";
import { NewPostsPill } from "@/components/NewPostsPill";
import { Timeline } from "@/components/Timeline";
import { Composer } from "@/components/Composer";
import { useSession } from "@/components/Providers";
import { useLiveFeed } from "@/hooks/useLiveFeed";
import { usePostActions } from "@/hooks/usePostActions";
import { modalActions } from "@/lib/modalStore";
import { useFeedPage } from "@/hooks/useFeed";
import { useViewerStates } from "@/hooks/useViewerStates";
import { useVote } from "@/hooks/useVote";
import { usePinPost } from "@/hooks/usePinPost";
import { useFollow } from "@/hooks/useFollow";
import { useOptimistic } from "@/hooks/useOptimistic";
import { nextPendingId } from "@/lib/optimistic";
import { useMutation } from "@/hooks/useMutation";
import { useActionToast } from "@/hooks/useActionToast";
import { useComposerGate } from "@/hooks/useComposerGate";
import { carriedViewerStates } from "@/lib/chain/node-reads";
import { FEED_PAGE_SIZE } from "@/lib/feed/constants";
import { useToaster } from "@/components/toast/ToasterProvider";
import { submitPost } from "@/lib/chain/mutations";
import { scrollToTop } from "@/lib/scroll";
import { subscribeHomeReset } from "@/lib/homeSignal";
import type { CognoPost, FeedQuery } from "@/lib/types";
import type { ActionState, ComposerDraft } from "@/components/kit";

export default function HomePage() {
  const router = useRouter();
  const { api, signer, source, viewer, votingPower, bestBlock } = useSession();

  const me = viewer.address ?? null;
  const canFollow = source != null;
  const paginationCapable = source != null;

  // Active tab is CLIENT state (not a route change). Ignore a persisted 'following' on PAPI-direct.
  const [tab, setTab] = useState<TimelineTab>("for-you");
  const activeTab: TimelineTab = tab === "following" && !canFollow ? "for-you" : tab;

  // ── For you: id-paged live feed (NextPostId-driven; "load more" reads one page at a time) ──────
  // useLiveFeed owns the new-posts pill buffer (a fresh OTHER-author post waits behind the pill so
  // the scroll never jumps; the viewer's own optimistic + confirmed post injects directly) AND the
  // optimistic overlay + presence-reconcile. It pages by post id — NO full `watchEntries`.
  const forYou = useLiveFeed(source, me, bestBlock);
  const displayedForYou = forYou.posts;
  const bufferedCount = forYou.newCount;
  const ready = forYou.ready;
  const feedError = forYou.error;

  // ── Following: paged followee feed ─────────────────────────────────────────────────────────────
  // We resolve the followee set through the page seam's `followeeOf`. Skip the query (and show the
  // follows empty-state) when disconnected or the viewer follows nobody.
  const [followeesEmpty, setFolloweesEmpty] = useState(false);
  useEffect(() => {
    if (!source || !canFollow || !me) {
      setFolloweesEmpty(false);
      return;
    }
    let cancelled = false;
    source
      .followEdges(me)
      .then((e) => {
        if (!cancelled) setFolloweesEmpty(e.following.length === 0);
      })
      .catch(() => {
        if (!cancelled) setFolloweesEmpty(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, canFollow, me]);

  const followingQuery = useMemo<FeedQuery>(
    () => ({
      tab: "following",
      followeeOf: me ?? undefined,
      first: FEED_PAGE_SIZE,
      viewer: me ?? undefined,
    }),
    [me],
  );
  const followingEnabled =
    activeTab === "following" && canFollow && me != null && !followeesEmpty;
  const followingPage = useFeedPage(source, followingQuery, followingEnabled);

  // ── the post-id set + viewer-relative state (the filled heart) ────────────────────────────────
  const visiblePosts = activeTab === "following" ? followingPage.posts : displayedForYou;
  const postIds = useMemo(() => visiblePosts.map((p) => p.id), [visiblePosts]);
  // A node-served page carries each post's `myVote` overlay → useViewerStates skips its per-card
  // read for those ids (posts without an overlay fall back to the per-card read).
  const carriedStates = useMemo(() => carriedViewerStates(visiblePosts), [visiblePosts]);
  const viewerStates = useViewerStates(source, postIds, me, carriedStates);

  // ── write hooks ────────────────────────────────────────────────────────────────────────────────
  const vote = useVote(api, signer, votingPower ?? 0n);
  const { pin } = usePinPost(api, signer);
  const follow = useFollow(api, signer, source, me);
  const { addPending, failPending } = useOptimistic();
  const { run } = useMutation();
  const { toast } = useToaster();
  const { phase } = useActionToast();

  // ── inline composer capacity gate ──────────────────────────────────────────────────────────────
  // `composerText` is what the USER sees; `composerSerialized` is what actually gets posted (a mention
  // renders `@alice` but posts as `@<48-char ss58>`). The gate must measure the latter — this surface
  // used to measure the display text, so "hi @alice @bob" gated at 14 bytes and was rejected on-chain
  // at ~110. The two are kept apart deliberately: the gate reads serialized, the textarea reads display.
  const [composerText, setComposerText] = useState("");
  const [composerSerialized, setComposerSerialized] = useState("");
  const {
    rateLimited: composerRateLimited,
    noPostingPower: composerNoPower,
    needsVotingPower: composerNeedsVotingPower,
    retryInSeconds,
  } = useComposerGate(composerSerialized);

  // ── inline composer (top-level post) ───────────────────────────────────────────────────────────
  const onComposePost = useCallback(
    (draft: ComposerDraft) => {
      if (viewer.status !== "ready") {
        router.push("/welcome/");
        return;
      }
      if (!api || !signer || draft.text.trim().length === 0) return;
      const optimistic: CognoPost = {
        id: nextPendingId(),
        author: me ?? signer.ss58,
        text: draft.text,
        at: 0,
        authorDisplayName: viewer.displayName,
        authorAvatar: viewer.avatar,
      };
      const clientId = addPending(optimistic);
      // What the user typed, for the error restore below. `draft.text` is the SERIALIZED body — putting
      // that back in the textarea returned a failed post as a wall of raw `@5GrwvaEF…`.
      const displayText = composerText;
      setComposerText("");
      setComposerSerialized("");
      // Status toast (sticky "Posting…" → "Posted" + "View →"), but NO onConfirm dropPending: the
      // pending card is retired when its real twin lands in the feed (useLiveFeed presence-reconcile),
      // so the optimistic card never blinks out at confirm. onCancel drops the sticky toast if Home
      // unmounts mid-flight; onError rolls the card back + restores the draft (phase() surfaces the fail).
      void run(
        submitPost(api, signer, draft.text),
        phase({
          id: clientId,
          pending: "Posting…",
          success: "Posted",
          view: (u) =>
            u.postId != null
              ? { label: "View →", onClick: () => router.push(`/post/${u.postId}/`) }
              : undefined,
          onError: () => {
            failPending(clientId);
            setComposerText(displayText); // restore what they TYPED, not the serialized body
          },
          onCancel: () => failPending(clientId),
        }),
      );
    },
    [viewer, api, signer, me, composerText, addPending, failPending, run, phase, router],
  );

  // ── new-posts pill flush ───────────────────────────────────────────────────────────────────────
  // Depend on `forYou.flush` — a stable useCallback — and NOT on `forYou`, which useLiveFeed rebuilds
  // as a fresh object literal every render (so `[forYou]` gave this handler a new identity per render,
  // and the effect below would re-subscribe on every one of them).
  const forYouFlush = forYou.flush;
  const flushPending = useCallback(() => {
    forYouFlush(); // accept the buffered new posts into view
    scrollToTop();
  }, [forYouFlush]);

  // ── Home re-tap: the nav's Home button (or wordmark) clicked while already on "/" ──────────────
  // The X gesture. The nav owns the scroll-to-top (it does that for every tab); Home is the only
  // surface with a feed to re-read, so it owns what "refresh" means — which is per-TAB. For-you
  // promotes the pill buffer and re-reads page 1 for fresh tallies; Following has no liveness
  // subscription at all, so its re-read is the only way that tab ever picks up a new post.
  const forYouRefresh = forYou.refresh;
  const followingRefresh = followingPage.refresh;
  const onHomeReset = useCallback(() => {
    if (activeTab === "following") followingRefresh();
    else forYouRefresh();
  }, [activeTab, forYouRefresh, followingRefresh]);
  useEffect(() => subscribeHomeReset(onHomeReset), [onHomeReset]);

  // Tapping a timeline tab refreshes that tab's feed and scrolls to the top — the Home-button gesture,
  // scoped to the tab you clicked. It refreshes `next` (not the still-current `activeTab`, since setTab
  // hasn't applied yet) and fires on every click, including re-tapping the tab you're already on. On a
  // switch TO Following its refresh is a no-op (the query isn't enabled yet); the tab flip loads page 1.
  const onTabChange = useCallback(
    (next: TimelineTab) => {
      setTab(next);
      if (next === "following") followingRefresh();
      else forYouRefresh();
      scrollToTop();
    },
    [forYouRefresh, followingRefresh],
  );

  // ── per-card action bundle ─────────────────────────────────────────────────────────────────────
  const handlers = usePostActions({ viewer, viewerStates, vote, pin, toast, follow });

  const composeState: ActionState = "idle"; // inline composer clears optimistically; per-tx state lives on the card

  // Open the inline composer (the `n` shortcut / Timeline empty-state compose). On desktop we focus the
  // textarea. An explicit compose intent funnels to /welcome until setup is fully complete (writeReady).
  const onCompose = useCallback(() => {
    if (!viewer.writeReady) {
      router.push("/welcome/");
      return;
    }
    // The inline composer is always in the DOM when ready but CSS-hidden below 688px; offsetParent is
    // null when it (or an ancestor) is display:none, so fall back to the modal instead of a no-op focus.
    const ta = document.getElementById("cg-composer-post") as HTMLTextAreaElement | null;
    if (ta && ta.offsetParent !== null) ta.focus();
    else modalActions.openCompose();
  }, [viewer.writeReady, router]);

  // Following-tab loading/error mirror For-you.
  const followingLoading = followingEnabled && followingPage.loading && followingPage.posts.length === 0;
  const forYouLoading = !ready && displayedForYou.length === 0;

  return (
    <>
      <StickyHeader
        title="Home"
        tabs={
          <TimelineTabs active={activeTab} onChange={onTabChange} showFollowing={canFollow} />
        }
      />

      {/* inline composer — desktop/tablet only (CSS-gated < 688px); mobile uses the ComposeFab.
          Time-boxed: this is a simple NON-collapsing inline composer (no scroll-collapse). */}
      {viewer.status === "ready" && (
        <div className={styles.composerSlot}>
          <Composer
            viewer={viewer}
            mode="post"
            submitState={composeState}
            text={composerText}
            onTextChange={setComposerText}
            onSerializedChange={setComposerSerialized}
            rateLimited={composerRateLimited}
            retryInSeconds={retryInSeconds}
            noPostingPower={composerNoPower}
            needsVotingPower={composerNeedsVotingPower}
            onTogglePoll={() => modalActions.openPoll()}
            onSubmit={onComposePost}
          />
        </div>
      )}

      <NewPostsPill count={activeTab === "for-you" ? bufferedCount : 0} onClick={flushPending} />

      {activeTab === "following" ? (
        <Timeline
          posts={followingEnabled ? followingPage.posts : []}
          gate={viewer}
          viewerStates={viewerStates}
          handlers={handlers}
          loading={followingLoading}
          error={followingPage.error}
          onRetry={followingRefresh}
          hasMore={followingPage.hasNextPage}
          onLoadMore={followingPage.loadMore}
          loadingMore={followingPage.loading}
          paginationCapable={paginationCapable}
          emptyVariant="follows"
          emptyTitle={
            me == null
              ? "Follow people to see their posts"
              : followeesEmpty
                ? "Not following anyone yet."
                : "No posts from people you follow yet"
          }
          emptyDescription={
            me == null
              ? "When you connect and follow accounts, their posts show up here."
              : followeesEmpty
                ? undefined
                : "When the accounts you follow post, it'll show up here."
          }
          emptyAction={
            me == null
              ? { label: "Connect", onClick: () => router.push("/welcome/") }
              : { label: "Find people to follow", onClick: () => router.push("/explore/") }
          }
          onCompose={onCompose}
          onFlush={flushPending}
        />
      ) : (
        <Timeline
          posts={displayedForYou}
          gate={viewer}
          viewerStates={viewerStates}
          handlers={handlers}
          loading={forYouLoading}
          error={feedError}
          onRetry={forYouRefresh}
          hasMore={forYou.hasMore}
          onLoadMore={forYou.loadMore}
          loadingMore={forYou.loadingMore}
          paginationCapable={paginationCapable}
          emptyVariant="feed"
          emptyAction={{ label: "Explore", onClick: () => router.push("/explore/") }}
          onCompose={onCompose}
          onFlush={flushPending}
        />
      )}
    </>
  );
}
