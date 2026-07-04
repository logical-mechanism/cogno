"use client";

// HomePage — the Home route '/' (doc 06). The default landing surface: a sticky header carrying the
// TimelineTabs (For you / Following), an inline Composer at the top (desktop/tablet), a "Show N posts"
// new-posts pill, and the Timeline of PostCards. Every write is optimistic; the only chain realities
// surfaced are a graceful rate-limit notice + a quiet failure toast. No honesty/block-number chrome.
//
// Two tabs (doc 06 §4):
//   • For you   — useLiveFeed(source) id-paged live feed (NextPostId-driven; "load more" reads one
//                 page at a time). Fresh OTHER-author items buffer behind the pill (the scroll never
//                 jumps); the viewer's OWN optimistic post injects directly.
//   • Following — useFeedPage(source, { tab:'following', followeeOf, first }, enabled); skipped +
//                 shows the follows empty-state when the viewer follows nobody / is disconnected. The
//                 node serves the Following timeline directly (spec-120 following_feed_page), so the
//                 tab shows on the PAPI-direct/hybrid path too; it only hides if caps.follows is false.
//
// One socket: everything reads from useSession(); this page never instantiates a client.
//
// HOOK: notifications — deferred (doc 06 §11 / useNotifications). The indexer's vote/repost/follow/
// reply/quote edges targeting the viewer make a future /notifications surface a clean follow-up; no
// bell/badge is built here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { StickyHeader } from "@/components/AppShell";
import { TimelineTabs, type TimelineTab } from "@/components/TimelineTabs";
import { NewPostsPill } from "@/components/NewPostsPill";
import { Timeline } from "@/components/Timeline";
import { Composer } from "@/components/Composer";
import { useSession } from "@/components/Providers";
import { useLiveFeed } from "@/hooks/useLiveFeed";
import { useFeedPage } from "@/hooks/useFeed";
import { useViewerStates } from "@/hooks/useViewerStates";
import { useVote } from "@/hooks/useVote";
import { usePinPost } from "@/hooks/usePinPost";
import { useRepost } from "@/hooks/useRepost";
import { useOptimistic } from "@/hooks/useOptimistic";
import { nextPendingId } from "@/lib/optimistic";
import { useMutation } from "@/hooks/useMutation";
import { useActionToast } from "@/hooks/useActionToast";
import { useCapacity } from "@/hooks/useCapacity";
import { carriedViewerStates } from "@/lib/chain/node-reads";
import { FEED_PAGE_SIZE } from "@/lib/feed/constants";
import { draftStatus } from "@/lib/chain/capacity";
import { useToaster } from "@/components/toast/ToasterProvider";
import { modalActions } from "@/lib/modalStore";
import { submitPost } from "@/lib/chain/mutations";
import type { CognoPost, ViewerPostState, FeedQuery } from "@/lib/types";
import type { ActionState, ComposerDraft, PostActionCallbacks } from "@/components/kit";

const NO_VIEWER: ViewerPostState = { myVote: null, reposted: false };

/** Walk up to the closest scrollable ancestor (the center column on desktop, document on mobile). */
function scrollContainerOf(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el?.parentElement ?? null;
  while (node) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

export default function HomePage() {
  const router = useRouter();
  const { api, signer, source, viewer, votingPower, bestBlock } = useSession();

  const me = viewer.address ?? null;
  const canFollow = source?.caps.follows === true;
  const paginationCapable = source?.caps.pagination === true;

  // Active tab is CLIENT state (not a route change). Ignore a persisted 'following' on PAPI-direct.
  const [tab, setTab] = useState<TimelineTab>("for-you");
  const activeTab: TimelineTab = tab === "following" && !canFollow ? "for-you" : tab;

  // ── For you: id-paged live feed (NextPostId-driven; "load more" reads one page at a time) ────
  // useLiveFeed owns the new-posts pill buffer (a fresh OTHER-author post waits behind the pill so
  // the scroll never jumps; the viewer's own optimistic + confirmed post injects directly) AND the
  // optimistic overlay + presence-reconcile. It pages by post id — NO full `watchEntries`.
  const forYou = useLiveFeed(source, me, bestBlock);
  const displayedForYou = forYou.posts;
  const bufferedCount = forYou.newCount;
  const ready = forYou.ready;
  const feedError = forYou.error;

  // ── Following: paged followee feed ─────────────────────────────────────────────────────────
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
      order: "recency",
      viewer: me ?? undefined,
    }),
    [me],
  );
  const followingEnabled =
    activeTab === "following" && canFollow && me != null && !followeesEmpty;
  const followingPage = useFeedPage(source, followingQuery, followingEnabled);

  // ── the post-id set + viewer-relative state (filled heart / active repost) ──────────────────
  const visiblePosts = activeTab === "following" ? followingPage.posts : displayedForYou;
  const postIds = useMemo(() => visiblePosts.map((p) => p.id), [visiblePosts]);
  // A node-served page carries each post's myVote/reposted overlay → useViewerStates skips its
  // per-card Reposts.getEntries scan for those ids (keyed-path posts have no overlay → per-card read).
  const carriedStates = useMemo(() => carriedViewerStates(visiblePosts), [visiblePosts]);
  const viewerStates = useViewerStates(source, postIds, me, carriedStates);

  // ── write hooks ─────────────────────────────────────────────────────────────────────────────
  const vote = useVote(api, signer, votingPower ?? 0n);
  const { pin } = usePinPost(api, signer);
  const repost = useRepost(api, signer);
  const { addPending, failPending } = useOptimistic();
  const { run } = useMutation();
  const { toast } = useToaster();
  const { phase } = useActionToast();

  // ── inline composer capacity gate (doc 06 §9) ──────────────────────────────────────────────
  const { view: capacityView, consts: capacityConsts } = useCapacity(api, me, bestBlock);
  const [composerText, setComposerText] = useState("");
  const composerRateLimited = useMemo(() => {
    if (viewer.status !== "ready" || !capacityView || !capacityConsts) return false;
    const byteLen = new TextEncoder().encode(composerText).length;
    // An empty draft is never "rate-limited" (the byte-counter/CTA handles empties).
    if (byteLen === 0) {
      // probe the minimum post (base cost) so a fully-exhausted bucket still disables the CTA
      const probe = draftStatus(capacityView, 0, capacityConsts);
      return probe.kind === "charging" || probe.kind === "wait";
    }
    // Zero locked ADA (weight 0) is surfaced separately as "lock ADA to post", NOT as a rate limit.
    // Any OTHER non-ok kind (incl. the weight>0 / rate==0 no_weight edge) still disables via rateLimited.
    const k = draftStatus(capacityView, byteLen, capacityConsts).kind;
    return k !== "ok" && !(k === "no_weight" && capacityView.weight === 0n);
  }, [viewer.status, capacityView, capacityConsts, composerText]);
  // Ready account with zero posting power (locked-ADA weight 0) → the honest "lock ADA to post" gate.
  const composerNoPower =
    viewer.status === "ready" && !!capacityView && capacityView.weight === 0n;

  // ── inline composer (top-level post) ──────────────────────────────────────────────────────
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
      setComposerText("");
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
            setComposerText(draft.text); // restore the draft for a retry
          },
          onCancel: () => failPending(clientId),
        }),
      ).catch(() => {});
    },
    [viewer, api, signer, me, addPending, failPending, run, phase, router],
  );

  // ── new-posts pill flush ────────────────────────────────────────────────────────────────────
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const flushPending = useCallback(() => {
    forYou.flush(); // accept the buffered new posts into view
    const scroller = scrollContainerOf(anchorRef.current);
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduce ? "auto" : "smooth";
    if (scroller) scroller.scrollTo({ top: 0, behavior });
    else window.scrollTo({ top: 0, behavior });
  }, [forYou]);

  // ── per-card action bundle ──────────────────────────────────────────────────────────────────
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
        // navigator.clipboard is undefined in insecure contexts / some in-app browsers; guard so the
        // user always gets feedback instead of a silent no-op (an optional chain would swallow both toasts).
        if (!navigator.clipboard) {
          toast({ kind: "error", message: "Couldn't copy the link" });
          return;
        }
        void navigator.clipboard
          .writeText(url)
          .then(() => toast({ kind: "success", message: "Link copied" }))
          .catch(() => toast({ kind: "error", message: "Couldn't copy the link" }));
      },
      onPin: (post) => pin(post.id),
    }),
    [router, viewer.status, viewerStates, vote, repost, pin, toast],
  );

  const composeState: ActionState = "idle"; // inline composer clears optimistically; per-tx state lives on the card

  // Open the inline composer (the `n` shortcut / mobile FAB path). On desktop we focus the textarea.
  const onCompose = useCallback(() => {
    if (viewer.status !== "ready") {
      router.push("/welcome/");
      return;
    }
    // The inline composer is always in the DOM when ready but CSS-hidden below 688px; offsetParent is
    // null when it (or an ancestor) is display:none, so fall back to the modal instead of a no-op focus.
    const ta = document.getElementById("cg-composer-post") as HTMLTextAreaElement | null;
    if (ta && ta.offsetParent !== null) ta.focus();
    else modalActions.openCompose();
  }, [viewer.status, router]);

  // Following-tab loading/error mirror For-you (doc 06 §7.2).
  const followingLoading = followingEnabled && followingPage.loading && followingPage.posts.length === 0;
  const forYouLoading = !ready && displayedForYou.length === 0;

  return (
    <>
      <StickyHeader
        title="Home"
        tabs={
          <TimelineTabs active={activeTab} onChange={setTab} showFollowing={canFollow} />
        }
      />

      {/* anchor for the scroll-to-top target resolution */}
      <div ref={anchorRef} aria-hidden />

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
            rateLimited={composerRateLimited}
            noPostingPower={composerNoPower}
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
          api={api}
          signer={signer}
        />
      ) : (
        <Timeline
          posts={displayedForYou}
          gate={viewer}
          viewerStates={viewerStates}
          handlers={handlers}
          loading={forYouLoading}
          error={feedError}
          hasMore={forYou.hasMore}
          onLoadMore={forYou.loadMore}
          loadingMore={forYou.loadingMore}
          paginationCapable={paginationCapable}
          emptyVariant="feed"
          emptyAction={{ label: "Explore", onClick: () => router.push("/explore/") }}
          onCompose={onCompose}
          onFlush={flushPending}
          api={api}
          signer={signer}
        />
      )}
    </>
  );
}
