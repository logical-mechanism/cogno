"use client";

// HomePage — the Home route '/' (doc 06). The default landing surface: a sticky header carrying the
// TimelineTabs (For you / Following), an inline Composer at the top (desktop/tablet), a "Show N posts"
// new-posts pill, and the Timeline of PostCards. Every write is optimistic; the only chain realities
// surfaced are a graceful rate-limit notice + a quiet failure toast. No honesty/block-number chrome.
//
// Two tabs (doc 06 §4):
//   • For you   — useOptimisticFeed(source) LIVE snapshot. Fresh OTHER-author items buffer behind the
//                 pill (the scroll never jumps); the viewer's OWN optimistic post injects directly.
//   • Following — useFeedPage(source, { tab:'following', followeeOf, first:30 }, enabled); skipped +
//                 shows the follows empty-state when the viewer follows nobody / is disconnected.
//   The Following tab is HIDDEN entirely on PAPI-direct (caps.follows === false) — never greyed (§5.5).
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
import { useOptimisticFeed } from "@/hooks/useOptimisticFeed";
import { useFeedPage } from "@/hooks/useFeed";
import { useViewerStates } from "@/hooks/useViewerStates";
import { useVote } from "@/hooks/useVote";
import { useRepost } from "@/hooks/useRepost";
import { useOptimistic } from "@/hooks/useOptimistic";
import { useMutation } from "@/hooks/useMutation";
import { useCapacity } from "@/hooks/useCapacity";
import { useHeads } from "@/hooks/useHeads";
import { draftStatus } from "@/lib/chain/capacity";
import { useToaster, RATE_LIMIT_COPY } from "@/components/toast/ToasterProvider";
import { modalActions } from "@/lib/modalStore";
import { submitPost } from "@/lib/chain/mutations";
import type { CognoPost, ViewerPostState, FeedQuery } from "@/lib/types";
import type { ActionState, ComposerDraft, PostActionCallbacks } from "@/components/kit";

const NO_VIEWER: ViewerPostState = { myVote: null, reposted: false };

function isRateLimit(message: string): boolean {
  return /rate limit|ExhaustsResources/i.test(message);
}

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
  const { api, client, signer, source, viewer, votingPower } = useSession();

  const me = viewer.address ?? null;
  const canFollow = source?.caps.follows === true;
  const paginationCapable = source?.caps.pagination === true;

  // Active tab is CLIENT state (not a route change). Ignore a persisted 'following' on PAPI-direct.
  const [tab, setTab] = useState<TimelineTab>("for-you");
  const activeTab: TimelineTab = tab === "following" && !canFollow ? "for-you" : tab;

  // ── For you: live optimistic snapshot ──────────────────────────────────────────────────────
  const { snapshot, ready, error: feedError } = useOptimisticFeed(source);
  const livePosts = snapshot.posts;

  // The new-posts pill buffers fresh OTHER-author items. `baseline` is the set of real ids the user
  // has accepted into view; new real ids (not own) stay buffered until flush. The viewer's own
  // optimistic post (id < 0n) and own confirmed posts inject directly.
  const [baseline, setBaseline] = useState<Set<string>>(new Set());
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current && ready) {
      initialized.current = true;
      setBaseline(new Set(livePosts.filter((p) => p.id >= 0n).map((p) => String(p.id))));
    }
  }, [ready, livePosts]);

  const isOwn = useCallback((p: CognoPost) => me != null && p.author === me, [me]);

  const { displayedForYou, bufferedCount } = useMemo(() => {
    const shown: CognoPost[] = [];
    let buffered = 0;
    for (const p of livePosts) {
      const pending = p.id < 0n;
      if (pending || isOwn(p) || baseline.has(String(p.id))) shown.push(p);
      else buffered += 1;
    }
    return { displayedForYou: shown, bufferedCount: buffered };
  }, [livePosts, baseline, isOwn]);

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
    () => ({ tab: "following", followeeOf: me ?? undefined, first: 30, order: "recency" }),
    [me],
  );
  const followingEnabled =
    activeTab === "following" && canFollow && me != null && !followeesEmpty;
  const followingPage = useFeedPage(source, followingQuery, followingEnabled);

  // ── the post-id set + viewer-relative state (filled heart / active repost) ──────────────────
  const visiblePosts = activeTab === "following" ? followingPage.posts : displayedForYou;
  const postIds = useMemo(() => visiblePosts.map((p) => p.id), [visiblePosts]);
  const viewerStates = useViewerStates(source, postIds, me);

  // ── write hooks ─────────────────────────────────────────────────────────────────────────────
  const vote = useVote(api, signer, votingPower ?? 0n);
  const repost = useRepost(api, signer);
  const { addPending, dropPending, failPending } = useOptimistic();
  const { run } = useMutation();
  const { toast } = useToaster();

  // ── inline composer capacity gate (doc 06 §9) ──────────────────────────────────────────────
  const heads = useHeads(client);
  const bestBlock = heads.best?.number ?? null;
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
        id: -BigInt(Date.now()),
        author: me ?? signer.ss58,
        text: draft.text,
        at: 0,
        authorDisplayName: viewer.displayName,
        authorAvatar: viewer.avatar,
      };
      const clientId = addPending(optimistic);
      setComposerText("");
      void run(submitPost(api, signer, draft.text), {
        onConfirm: () => dropPending(clientId),
        onError: (message) => {
          failPending(clientId);
          setComposerText(draft.text); // restore the draft for a retry
          if (isRateLimit(message))
            toast({ id: "rate-limit", kind: "rate-limit", message: RATE_LIMIT_COPY });
          else toast({ kind: "error", message });
        },
      }).catch(() => {});
    },
    [viewer, api, signer, me, addPending, dropPending, failPending, run, toast, router],
  );

  // ── new-posts pill flush ────────────────────────────────────────────────────────────────────
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const flushPending = useCallback(() => {
    setBaseline(new Set(livePosts.filter((p) => p.id >= 0n).map((p) => String(p.id))));
    const scroller = scrollContainerOf(anchorRef.current);
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduce ? "auto" : "smooth";
    if (scroller) scroller.scrollTo({ top: 0, behavior });
    else window.scrollTo({ top: 0, behavior });
  }, [livePosts]);

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
        void navigator.clipboard
          ?.writeText(url)
          .then(() => toast({ kind: "success", message: "Link copied" }))
          .catch(() => toast({ kind: "error", message: "Couldn't copy the link" }));
      },
    }),
    [router, viewer.status, viewerStates, vote, repost, toast],
  );

  const composeState: ActionState = "idle"; // inline composer clears optimistically; per-tx state lives on the card

  // Open the inline composer (the `n` shortcut / mobile FAB path). On desktop we focus the textarea.
  const onCompose = useCallback(() => {
    if (viewer.status !== "ready") {
      router.push("/welcome/");
      return;
    }
    const ta = document.getElementById("cg-composer-post") as HTMLTextAreaElement | null;
    if (ta) ta.focus();
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
          hasMore={false}
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
