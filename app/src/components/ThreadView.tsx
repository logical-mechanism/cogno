"use client";

// ThreadView — the conversation composite for /post/[id] (surface 08, doc 03 §22.5).
//
// Renders, top-down: the "Replying to @parent" ancestor-context line (from thread.parent, a shallow
// QuotedRef → tappable, routes to /post/<parent>/) → the FOCAL post as `PostCard variant='detail'`
// (enlarged body; the weighted score + up/down weight STATS ROW is shown HERE and only here — D2/D12;
// the focal carries its PollCard-with-results when isPoll and its QuotedPostEmbed when it quotes) →
// the inline ReplyComposer ("Post your reply", wired to submitReply + addOptimisticReply for the
// optimistic pending reply card) → the list of direct replies as `PostCard variant='reply'` with the
// connecting thread line.
//
// v1 ThreadView = root + ONE level of direct replies (deeper replies open their own /post/[id]/ — the
// recursive-tree is a deferred follow-up). It owns the session/feed wiring: one socket via useSession.
//
// Cardinal constraints: D1 512-byte replies (the Composer's ByteCounter enforces); D2 Like==up-vote +
// the weighted score IS surfaced on this detail surface (may be negative → formatSignedWeight renders
// the leading sign); D3 permanent repost; D4 polls never expire ("Live results"); D5 capacity →
// RateLimitNotice (reactive ExhaustsResources → error toast, never a battery); D10 banned authors are
// dimmed not hidden (PostCard owns the dim+chip); D11 optimistic reply (pending opacity 0.6, silent
// success, rollback + toast on error). No honesty/block-number chrome.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import styles from "./ThreadView.module.css";
import { PostCard } from "./PostCard";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import { NotFoundInline } from "./AppShell";
import { Spinner } from "./icons";
import { useSession } from "./Providers";
import { useThread } from "@/hooks/useThread";
import { useViewerStates } from "@/hooks/useViewerStates";
import { carriedViewerStates } from "@/lib/chain/node-reads";
import { useVote } from "@/hooks/useVote";
import { usePinPost } from "@/hooks/usePinPost";
import { useRepost } from "@/hooks/useRepost";
import { usePoll } from "@/hooks/usePoll";
import { useOptimistic } from "@/hooks/useOptimistic";
import { useMutation } from "@/hooks/useMutation";
import { useCapacity } from "@/hooks/useCapacity";
import { useToaster, RATE_LIMIT_COPY } from "@/components/toast/ToasterProvider";
import { modalActions } from "@/lib/modalStore";
import { submitReply } from "@/lib/chain/mutations";
import { formatCount, formatSignedWeight, formatWeight } from "@/lib/format";
import { handleOf } from "@/lib/ss58";
import type { CognoPost, ViewerPostState } from "@/lib/types";
import type { ActionState, ComposerDraft, PostActionCallbacks } from "@/components/kit";

const NO_VIEWER: ViewerPostState = { myVote: null, reposted: false };

// How many reply levels expand inline before a branch routes to its own /post/[id] page.
const MAX_INLINE_DEPTH = 2;

function isRateLimit(message: string): boolean {
  return /rate limit|ExhaustsResources/i.test(message);
}

export interface ThreadViewProps {
  /** The root/focal post id read from /post/[id] (already validated /^\d+$/ by the route). */
  rootId: bigint;
}

export function ThreadView({ rootId }: ThreadViewProps) {
  const router = useRouter();
  const { api, signer, source, viewer, votingPower, bestBlock } = useSession();
  const me = viewer.address ?? null;

  // Zero locked ADA → no posting power: hard-disable the inline reply CTA (the Composer's
  // self-contained NoPostingPowerNotice shows the "Lock ADA to post" banner), matching the other surfaces.
  const { view: capacityView } = useCapacity(api, viewer.address ?? null, bestBlock);
  const noPostingPower = viewer.status === "ready" && !!capacityView && capacityView.weight === 0n;

  // `me` threaded into the thread read so a spec-120 node stamps the myVote/reposted overlay node-side.
  const { thread, loading, error, addOptimisticReply } = useThread(source, rootId, me);
  // The focal's reply-context is rendered ONCE, as the tappable ancestor line above the card. We
  // prefer thread.parent (the richer QuotedRef with a display name; indexer path); on PAPI-direct
  // thread.parent is absent but the focal still carries its parent id, so we fall back to a bare
  // tappable id. Either way we strip `parent` off the focal so PostCard does NOT also render its own
  // static (non-tappable, id-only) "Replying to" line — one affordance, no duplicate.
  const ancestor = useMemo<{ id: bigint; label: string } | null>(() => {
    if (thread?.parent) {
      return {
        id: thread.parent.id,
        label: thread.parent.displayName?.trim() || handleOf(thread.parent.author),
      };
    }
    const pid = thread?.root.parent;
    return pid !== undefined ? { id: pid, label: `#${pid}` } : null;
  }, [thread?.parent, thread?.root.parent]);

  const focal = useMemo<CognoPost | null>(() => {
    const root = thread?.root;
    if (!root) return null;
    if (root.parent === undefined) return root;
    const { parent: _parent, ...rest } = root;
    return rest;
  }, [thread?.root]);
  const replies = useMemo<CognoPost[]>(() => thread?.replies ?? [], [thread?.replies]);
  const ancestors = useMemo<CognoPost[]>(() => thread?.ancestors ?? [], [thread?.ancestors]);

  // ── inline-thread expansion: which replies are open + their fetched direct children ──
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [childrenById, setChildrenById] = useState<Map<string, CognoPost[]>>(() => new Map());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());

  // Every card on screen (focal + ancestor chain + replies + any expanded descendants) drives the
  // viewer's vote/repost state, so a like reflects instantly anywhere in the tree.
  const visibleIds = useMemo(() => {
    const ids: bigint[] = [];
    if (focal) ids.push(focal.id);
    for (const a of ancestors) ids.push(a.id);
    const walk = (list: CognoPost[]) => {
      for (const r of list) {
        ids.push(r.id);
        if (expanded.has(String(r.id))) walk(childrenById.get(String(r.id)) ?? []);
      }
    };
    walk(replies);
    return ids;
  }, [focal, ancestors, replies, expanded, childrenById]);
  // Every visible card's node-served overlay (focal + ancestors + replies + expanded children) →
  // useViewerStates skips the per-card Reposts scan for ids it covers.
  const carriedStates = useMemo(() => {
    const all: CognoPost[] = [];
    if (focal) all.push(focal);
    all.push(...ancestors, ...replies);
    for (const list of childrenById.values()) all.push(...list);
    return carriedViewerStates(all);
  }, [focal, ancestors, replies, childrenById]);
  const viewerStates = useViewerStates(source, visibleIds, me, carriedStates);

  const vote = useVote(api, signer, votingPower ?? 0n);
  const repost = useRepost(api, signer);
  const { pin } = usePinPost(api, signer);
  const { dropPending, failPending } = useOptimistic();
  const { run } = useMutation();
  const { toast } = useToaster();

  // Toggle a reply's inline sub-thread: collapse if open, else fetch its direct children once
  // (source.thread reuses the same reader) and expand. Children are cached so a re-open is instant.
  const toggleExpand = useCallback(
    async (reply: CognoPost) => {
      const key = String(reply.id);
      if (expanded.has(key)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        return;
      }
      if (!childrenById.has(key) && source) {
        setLoadingIds((prev) => new Set(prev).add(key));
        try {
          const sub = await source.thread(reply.id, me ?? undefined);
          setChildrenById((prev) => new Map(prev).set(key, sub.replies));
        } catch {
          toast({ kind: "error", message: "Couldn't load these replies" });
          setLoadingIds((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
          return;
        }
        setLoadingIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
      setExpanded((prev) => new Set(prev).add(key));
    },
    [expanded, childrenById, source, toast, me],
  );

  // ── poll on the FOCAL post (always-show results on the detail surface, D4) ──
  const focalIsPoll = focal?.isPoll === true;
  const { poll, myChoice, castVote } = usePoll(
    source,
    focalIsPoll ? rootId : null,
    api,
    signer,
    me,
    bestBlock,
  );

  // ── inline reply composer → submitReply(parent = focal) with the optimistic pending card (D11) ──
  // NOTIFICATIONS SEAM (doc 08 §10, deferred): a reply whose parent is the focal author's post is one
  // of the edges a future useNotifications(focal.author) folds — leave the seam, do not build it here.
  const onSubmitReply = useCallback(
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
        parent: rootId,
        at: 0,
        authorDisplayName: viewer.displayName,
        authorAvatar: viewer.avatar,
      };
      // addOptimisticReply pins the pending card under THIS thread (parentId = rootId) so it surfaces
      // at the bottom of the replies list via useThread's merge.
      const clientId = addOptimisticReply(optimistic);
      void run(submitReply(api, signer, draft.text, rootId), {
        onConfirm: () => dropPending(clientId),
        onError: (message) => {
          failPending(clientId);
          if (isRateLimit(message)) toast({ id: "rate-limit", kind: "rate-limit", message: RATE_LIMIT_COPY });
          else toast({ kind: "error", message });
        },
      }).catch(() => {});
    },
    [
      viewer.status,
      viewer.displayName,
      viewer.avatar,
      api,
      signer,
      me,
      rootId,
      addOptimisticReply,
      run,
      dropPending,
      failPending,
      toast,
      router,
    ],
  );

  // ── the per-card action bundle (mirrors the home surface; D2 Like==up, D3 permanent repost) ──
  // NOTIFICATIONS SEAM (doc 08 §10): the Voted / Reposted / quote edges raised here targeting the
  // focal author are exactly what a future useNotifications(who) folds — deferred, seam left.
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

  // ── scroll-to-focal once per id (X behavior: focal lands just under the sticky header) ──
  const focalRef = useRef<HTMLDivElement | null>(null);
  const scrolledFor = useRef<bigint | null>(null);
  useEffect(() => {
    if (!focal || scrolledFor.current === rootId) return;
    scrolledFor.current = rootId;
    const el = focalRef.current;
    if (!el) return;
    // After layout; guarded so it fires only on the initial mount for this id (not per reply insert).
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: "start" });
      el.focus({ preventScroll: true });
    });
  }, [focal, rootId]);

  // ── states (§6.2 / §6.3) — the route already guarded an invalid id; here we cover load/error/missing ──
  if (loading && !thread) {
    return (
      <section className={styles.thread} aria-label="Conversation" aria-busy="true">
        <Skeleton variant="thread" />
      </section>
    );
  }

  if (error) {
    return (
      <section className={styles.thread} aria-label="Conversation">
        <EmptyState
          title="Couldn't load this post."
          description="Something went wrong reading the thread."
          action={{ label: "Retry", onClick: () => router.refresh() }}
        />
      </section>
    );
  }

  // Valid-but-absent id (never created, or outside the PAPI-direct snapshot window). Content is
  // permanent (D10) so this is "never existed / not loaded", never "deleted".
  if (!thread || !focal) {
    return <NotFoundInline kind="post" />;
  }

  const composeState: ActionState = "idle"; // the composer clears optimistically; per-tx state lives on the pending card

  // One reply + its inline-expanded sub-thread. Up to MAX_INLINE_DEPTH levels expand in place;
  // deeper branches offer "Show this thread →" which routes to that reply's own page (X behavior).
  const renderReply = (reply: CognoPost, depth: number): ReactNode => {
    const key = String(reply.id);
    const isOpen = expanded.has(key);
    const isLoading = loadingIds.has(key);
    const kids = childrenById.get(key) ?? [];
    const childCount = reply.replyCount ?? 0;
    const expandable = childCount > 0 && depth < MAX_INLINE_DEPTH && reply.id >= 0n;
    return (
      <div key={key} className={styles.replyNode}>
        <PostCard
          post={reply}
          viewer={viewerStates.get(reply.id) ?? NO_VIEWER}
          gate={viewer}
          handlers={handlers}
          variant="thread"
          showThreadLine
          pending={reply.id < 0n}
        />
        {expandable && (
          <button
            type="button"
            className={styles.showThread}
            onClick={() => void toggleExpand(reply)}
            aria-expanded={isOpen}
          >
            {isLoading
              ? "Loading replies…"
              : isOpen
                ? "Hide replies"
                : `Show ${formatCount(childCount)} ${childCount === 1 ? "reply" : "replies"}`}
          </button>
        )}
        {childCount > 0 && depth >= MAX_INLINE_DEPTH && reply.id >= 0n && (
          <button
            type="button"
            className={styles.showThread}
            onClick={() => router.push(`/post/${reply.id}/`)}
          >
            Show this thread →
          </button>
        )}
        {isOpen && kids.length > 0 && (
          <div className={styles.subReplies}>{kids.map((k) => renderReply(k, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <section className={styles.thread} aria-label="Conversation">
      {/* Connected ancestor chain above the focal (top-down): each parent post as a full, tappable
          card joined by the thread line. When the chain can't be resolved (PAPI-direct with a parent
          outside the snapshot) we fall back to the shallow tappable "Replying to" id line. */}
      {ancestors.length > 0 ? (
        <div className={styles.ancestors}>
          {ancestors.map((a) => (
            <PostCard
              key={String(a.id)}
              post={a}
              viewer={viewerStates.get(a.id) ?? NO_VIEWER}
              gate={viewer}
              handlers={handlers}
              variant="thread"
              showThreadLine
            />
          ))}
        </div>
      ) : (
        ancestor && (
          <button
            type="button"
            className={styles.replyingTo}
            onClick={() => router.push(`/post/${ancestor.id}/`)}
          >
            Replying to <span className={styles.replyTarget}>{ancestor.label}</span>
          </button>
        )
      )}

      {/* FOCAL post (detail variant): enlarged body, PollCard-with-results / QuotedPostEmbed handled by
          PostCard from focal.isPoll / focal.quote. focalRef anchors scroll-to-focal + SR focus. */}
      <div ref={focalRef} className={styles.focal} tabIndex={-1}>
        <PostCard
          post={focal}
          viewer={viewerStates.get(focal.id) ?? NO_VIEWER}
          gate={viewer}
          handlers={handlers}
          variant="detail"
          poll={focalIsPoll ? poll : null}
          pollMyChoice={myChoice}
          onPollVote={focalIsPoll ? castVote : undefined}
        />

        {/* The ONE weighted-nature surface (D2/D12): score (signed, may be negative) + up/down weight,
            with Like/Repost counts. Detail-only — never rendered on timeline/reply cards. */}
        <div className={styles.stats} role="group" aria-label="Post statistics">
          {(focal.upCount ?? 0) > 0 && (
            <span className={styles.stat}>
              <strong>{formatCount(focal.upCount)}</strong> Likes
            </span>
          )}
          {(focal.repostCount ?? 0) > 0 && (
            <span className={styles.stat}>
              <strong>{formatCount(focal.repostCount)}</strong> Reposts
            </span>
          )}
          <span
            className={styles.stat}
            aria-label={`score ${formatSignedWeight(focal.score ?? 0n)} (weighted)`}
          >
            score <strong>{formatSignedWeight(focal.score ?? 0n)}</strong>
          </span>
          {(focal.upWeight ?? 0n) > 0n && (
            <span className={styles.statMuted}>↑{formatWeight(focal.upWeight)}</span>
          )}
          {(focal.downWeight ?? 0n) > 0n && (
            <span className={styles.statMuted}>↓{formatWeight(focal.downWeight)}</span>
          )}
        </div>
      </div>

      {/* Inline ReplyComposer — pinned under the focal, "Post your reply". On submit it clears + stays
          open (X "reply again"); the optimistic pending card appears at the bottom of the replies list
          and reconciles on inBestBlock (D11). When session-gated the Composer renders its own
          finish-setup / connect prompt (§6.1). */}
      <div className={styles.composerSlot}>
        <Composer
          viewer={viewer}
          mode="reply"
          submitState={composeState}
          noPostingPower={noPostingPower}
          onSubmit={onSubmitReply}
          draftExtras={{ parentId: rootId }}
        />
      </div>

      {/* Direct replies (oldest-first) as connected thread cards. A reply with its own replies offers
          an inline "Show N replies" expander (renderReply recurses up to MAX_INLINE_DEPTH; deeper
          branches route to their own page). While the thread refetches we keep the rendered replies; a
          pending optimistic reply is merged in by useThread (id<0 → opacity 0.6, actions disabled). */}
      <div className={styles.replies}>
        {replies.length === 0 ? (
          <EmptyState variant="replies" />
        ) : (
          replies.map((reply) => renderReply(reply, 0))
        )}
        {loading && thread && (
          <div className={styles.refetching}>
            <Spinner label="Refreshing replies" />
          </div>
        )}
      </div>
    </section>
  );
}

export default ThreadView;
