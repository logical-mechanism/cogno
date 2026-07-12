"use client";

// ThreadView — the conversation composite for /post/[id] (surface 08, doc 03 §22.5).
//
// Focal-navigation ("true Twitter") model. One screen renders, top-down: the connected ANCESTOR chain
// above the focal (root→focal, each a tappable PostCard; a shallow "Replying to @parent" fallback line
// when the chain can't be resolved) → the FOCAL post as `PostCard variant='detail'` (enlarged body; the
// weighted score + up/down weight STATS ROW is shown HERE and only here — D2/D12; the focal carries its
// PollCard-with-results when isPoll and its QuotedPostEmbed when it quotes) → the inline ReplyComposer
// ("Post your reply", wired to submitReply(parent=focal) + addOptimisticReply for the optimistic pending
// card) → the flat list of the focal's DIRECT replies as `PostCard variant='thread'`.
//
// Depth is UNBOUNDED and consistent: tapping any reply (or its "N replies →" affordance) navigates to
// /post/<replyId>/, making it the new focal — the same three-part screen re-renders one level down. There
// is NO inline sub-thread nesting; descending is just a fresh source.thread(newRoot) via navigation. A
// reply's own Reply button focuses the inline composer when it targets the focal, else descends-to-focus
// (/post/<id>/?reply=1) — so every reply is authored where parentId===rootId and shows optimistically.
//
// Cardinal constraints: D1 512-byte replies (the Composer's ByteCounter enforces); D2 Like==up-vote +
// the weighted score IS surfaced on this detail surface (may be negative → formatSignedWeight renders
// the leading sign); D4 polls never expire ("Live results"); D5 capacity →
// RateLimitNotice (reactive ExhaustsResources → error toast, never a battery); D10 banned authors are
// dimmed not hidden (PostCard owns the dim+chip); D11 optimistic reply (pending opacity 0.6, phase toast
// submit→posted, rollback + toast on error). No honesty/block-number chrome.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./ThreadView.module.css";
import { PostCard } from "./PostCard";
import { Composer } from "./Composer";
import { NewPostsPill } from "./NewPostsPill";
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
import { usePoll } from "@/hooks/usePoll";
import { useOptimistic } from "@/hooks/useOptimistic";
import { nextPendingId } from "@/lib/optimistic";
import { useMutation } from "@/hooks/useMutation";
import { useActionToast } from "@/hooks/useActionToast";
import { useComposerGate } from "@/hooks/useComposerGate";
import { useToaster } from "@/components/toast/ToasterProvider";
import { modalActions } from "@/lib/modalStore";
import { submitReply } from "@/lib/chain/mutations";
import { sharePostWithToast } from "@/lib/share";
import { formatCount, formatSignedWeight, formatWeight } from "@/lib/format";
import { handleOf } from "@/lib/ss58";
import type { CognoPost, ViewerPostState } from "@/lib/types";
import type { ActionState, ComposerDraft, PostActionCallbacks } from "@/components/kit";

const NO_VIEWER: ViewerPostState = { myVote: null };
// Render replies in pages so a huge thread doesn't mount hundreds of cards at once (useThread fetches
// them all). Pending (optimistic, id<0) replies are ALWAYS shown so a just-posted reply is never hidden.
const REPLIES_PAGE = 20;

export interface ThreadViewProps {
  /** The root/focal post id read from /post/[id] (already validated /^\d+$/ by the route). */
  rootId: bigint;
}

export function ThreadView({ rootId }: ThreadViewProps) {
  const router = useRouter();
  const { api, signer, source, viewer, votingPower, bestBlock } = useSession();
  const me = viewer.address ?? null;

  // The pre-flight capacity gate, matching every other composing surface. This one previously computed
  // only `noPostingPower` and never `rateLimited`, so the thread reply box — the highest-volume reply
  // path in the app — was the ONE composer that could not show a RateLimitNotice or disable its CTA on
  // an exhausted bucket; every rate-limited reply round-tripped to a failure toast instead.
  //
  // "" because this composer is UNCONTROLLED: the gate then probes the BASE post cost, which is exactly
  // what we want (an exhausted bucket disables the CTA before a single character is typed).
  const { rateLimited, noPostingPower } = useComposerGate("");

  // `me` threaded into the thread read so a spec-120 node stamps the myVote/reposted overlay node-side;
  // `bestBlock` drives the live re-read (tallies refresh in place; new replies buffer behind the pill).
  const {
    thread,
    loading,
    error,
    addOptimisticReply,
    confirmReply,
    newReplyCount,
    flushReplies,
    reload,
  } = useThread(source, rootId, me, bestBlock);
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

  // Paged replies: the NEWEST N confirmed + ALL pending. Replies come chronological (oldest-first), and
  // a just-posted reply is the NEWEST one — the target of the scroll-to-reply effect — so it must stay
  // in the shown window even after it confirms. We therefore keep the TAIL (newest `visibleReplies`) and
  // let "Show more" reveal OLDER replies above. Slicing the HEAD instead paged the just-posted reply out
  // the moment its optimistic card was retired on confirm (position > REPLIES_PAGE in a busy thread).
  const [visibleReplies, setVisibleReplies] = useState(REPLIES_PAGE);
  useEffect(() => setVisibleReplies(REPLIES_PAGE), [rootId]); // reset when navigating to a new focal
  const confirmedReplyCount = useMemo(() => replies.filter((r) => r.id >= 0n).length, [replies]);
  const shownReplies = useMemo(() => {
    const confirmed = replies.filter((r) => r.id >= 0n);
    const pending = replies.filter((r) => r.id < 0n);
    return [...confirmed.slice(Math.max(0, confirmed.length - visibleReplies)), ...pending];
  }, [replies, visibleReplies]);
  const hiddenReplies = Math.max(0, confirmedReplyCount - visibleReplies);

  // Every card on screen (focal + ancestor chain + direct replies) drives the viewer's vote/repost
  // state, so a like reflects instantly anywhere on the screen.
  const visibleIds = useMemo(() => {
    const ids: bigint[] = [];
    if (focal) ids.push(focal.id);
    for (const a of ancestors) ids.push(a.id);
    for (const r of replies) ids.push(r.id);
    return ids;
  }, [focal, ancestors, replies]);
  // Every visible card's node-served overlay (focal + ancestors + replies) → useViewerStates skips the
  // per-card Reposts scan for ids it covers.
  const carriedStates = useMemo(() => {
    const all: CognoPost[] = [];
    if (focal) all.push(focal);
    all.push(...ancestors, ...replies);
    return carriedViewerStates(all);
  }, [focal, ancestors, replies]);
  const viewerStates = useViewerStates(source, visibleIds, me, carriedStates);

  const vote = useVote(api, signer, votingPower ?? 0n);
  const { pin } = usePinPost(api, signer);
  const { failPending } = useOptimistic();
  const { run } = useMutation();
  const { toast } = useToaster();
  const { phase } = useActionToast();

  // The inline reply composer slot — the focus target for "reply to the focal" and the ?reply=1 descend.
  const composerSlotRef = useRef<HTMLDivElement | null>(null);
  // Scroll to a just-posted reply: the replies container + a flag set on submit (the effect below fires
  // when the optimistic card lands at the bottom of the list).
  const repliesRef = useRef<HTMLDivElement | null>(null);
  const justRepliedRef = useRef(false);
  const focusComposer = useCallback(() => {
    const slot = composerSlotRef.current;
    if (!slot) return;
    slot.scrollIntoView({ block: "center" });
    slot.querySelector("textarea")?.focus();
  }, []);

  // "N new replies" pill: reveal the buffered replies, then scroll to the newest — they land at the
  // BOTTOM of the (oldest-first) list, so without this the pill would appear to do nothing. Reuses the
  // just-replied scroll effect below (fires once shownReplies grows), which centers the last reply node.
  const onShowNewReplies = useCallback(() => {
    flushReplies();
    justRepliedRef.current = true;
  }, [flushReplies]);

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
        id: nextPendingId(),
        author: me ?? signer.ss58,
        text: draft.text,
        parent: rootId,
        at: 0,
        authorDisplayName: viewer.displayName,
        authorAvatar: viewer.avatar,
      };
      // addOptimisticReply pins the pending card under THIS thread (parentId = rootId) so it surfaces
      // at the bottom of the replies list via useThread's merge — always, since every reply is a
      // reply-to-focal (the focal-nav model routes deeper replies to their own /post/[id]/ first).
      const clientId = addOptimisticReply(optimistic);
      justRepliedRef.current = true; // the effect below scrolls to the new card once it renders
      void run(
        submitReply(api, signer, draft.text, rootId),
        phase({
          id: clientId,
          pending: "Replying…",
          success: "Replied",
          view: (u) =>
            u.postId != null
              ? { label: "View →", onClick: () => router.push(`/post/${u.postId}/`) }
              : undefined,
          // Hand off to chain truth: confirmReply re-reads the thread and retires the pending card in
          // the SAME commit, so the reply never blinks out. Keyed by clientId (duplicate-text safe), and
          // the retire always runs — even if you navigated away — so no overlay entry can leak.
          onConfirm: () => confirmReply(clientId),
          onError: () => failPending(clientId),
          onCancel: () => failPending(clientId),
        }),
      );
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
      phase,
      confirmReply,
      failPending,
      router,
    ],
  );

  // ── the per-card action bundle (mirrors the home surface; D2 Like==up) ──
  // NOTIFICATIONS SEAM (doc 08 §10): the Voted / Reposted / quote edges raised here targeting the
  // focal author are exactly what a future useNotifications(who) folds — deferred, seam left.
  const handlers = useMemo<PostActionCallbacks>(
    () => ({
      onOpen: (id) => router.push(`/post/${id}/`),
      onAuthorOpen: (address) => router.push(`/u/${address}/`),
      // Focal-nav reply: the focal's Reply focuses the inline composer in place; a non-focal reply
      // descends to that reply's own focal (?reply=1 auto-focuses its composer) so the reply is always
      // authored where parentId===rootId and shows optimistically.
      onReply: (post) => {
        if (viewer.status !== "ready") return void router.push("/welcome/");
        if (post.id === rootId) focusComposer();
        else router.push(`/post/${post.id}/?reply=1`);
      },
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
      onShare: (post) => void sharePostWithToast(post.id, toast),
      onPin: (post) => pin(post.id),
    }),
    [router, viewer.status, viewerStates, vote, pin, toast, rootId, focusComposer],
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

  // ── descend-to-reply auto-focus: when we arrived via a reply card (/post/<id>/?reply=1), focus the
  //    inline composer once so the user can type immediately. Reads location.search directly to avoid
  //    the useSearchParams Suspense-boundary requirement under next `output:'export'`. ──
  const autofocusedFor = useRef<bigint | null>(null);
  useEffect(() => {
    if (!focal || autofocusedFor.current === rootId) return;
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("reply") !== "1") return;
    autofocusedFor.current = rootId;
    requestAnimationFrame(() => focusComposer());
  }, [focal, rootId, focusComposer]);

  // ── scroll to your just-posted reply once its optimistic card renders at the bottom of the list ──
  useEffect(() => {
    if (!justRepliedRef.current) return;
    justRepliedRef.current = false;
    const nodes = repliesRef.current?.querySelectorAll("[data-reply-node]");
    const last = nodes && nodes.length ? nodes[nodes.length - 1] : null;
    if (last) requestAnimationFrame(() => last.scrollIntoView({ block: "center" }));
  }, [shownReplies]);

  // ── browser tab title: author + snippet, so multiple open post tabs are distinguishable ──
  useEffect(() => {
    if (typeof document === "undefined" || !focal) return;
    const who = focal.authorDisplayName?.trim() || handleOf(focal.author);
    const snippet = focal.text.trim().replace(/\s+/g, " ");
    const clipped = snippet.length > 60 ? `${snippet.slice(0, 60)}…` : snippet;
    document.title = clipped ? `${who} on cogno-chain: “${clipped}”` : `${who} on cogno-chain`;
    // No cleanup — the next route sets its own title.
  }, [focal]);

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
          // `useThread.reload()`, not `router.refresh()` — under `output: 'export'` there is no RSC
          // payload to refetch, so the old Retry did nothing whatsoever. This one is load-bearing: a
          // failed COLD read leaves the hook unseeded, and the per-block live refetch skips unseeded
          // threads, so a hard reload used to be the only way out of this error card.
          action={{ label: "Retry", onClick: reload }}
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
            with the Like count. Detail-only — never rendered on timeline/reply cards. */}
        <div className={styles.stats} role="group" aria-label="Post statistics">
          {(focal.upCount ?? 0) > 0 && (
            <span className={styles.stat}>
              <strong>{formatCount(focal.upCount)}</strong> Likes
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
          and reconciles on inBestBlock (D11), with a submit→posted phase toast. When session-gated the
          Composer renders its own finish-setup / connect prompt (§6.1). */}
      <div ref={composerSlotRef} className={styles.composerSlot}>
        <Composer
          viewer={viewer}
          mode="reply"
          submitState={composeState}
          noPostingPower={noPostingPower}
          rateLimited={rateLimited}
          onSubmit={onSubmitReply}
          draftExtras={{ parentId: rootId }}
          contextAbove={
            <p className={styles.replyingToComposer}>
              Replying to <span className={styles.replyTarget}>{handleOf(focal.author)}</span>
            </p>
          }
        />
      </div>

      {/* The focal's DIRECT replies as connected thread cards (flat — no inline nesting). A reply with
          its own replies offers a subtle "N replies →" descend link; tapping the card or the link
          navigates to that reply's own /post/[id]/ focal. While the thread refetches we keep the
          rendered replies; a pending optimistic reply is merged in by useThread (id<0 → opacity 0.6). */}
      <div className={styles.replies} ref={repliesRef}>
        {/* New replies from OTHERS arrive live, buffered behind a pill so the scroll never jumps
            (your own reply shows at once). Tap to reveal them in the list below. */}
        <NewPostsPill
          count={newReplyCount}
          onClick={onShowNewReplies}
          noun="reply"
          nounPlural="replies"
          variant="inline"
        />
        {/* Reveals OLDER replies above the newest window (see the shownReplies tail-slice). */}
        {hiddenReplies > 0 && (
          <button
            type="button"
            className={styles.showMoreReplies}
            onClick={() => setVisibleReplies((n) => n + REPLIES_PAGE)}
          >
            Show {Math.min(hiddenReplies, REPLIES_PAGE)} older{" "}
            {hiddenReplies === 1 ? "reply" : "replies"}
          </button>
        )}
        {replies.length === 0 && newReplyCount === 0 ? (
          <EmptyState variant="replies" />
        ) : (
          shownReplies.map((reply) => (
            <div key={String(reply.id)} className={styles.replyNode} data-reply-node>
              <PostCard
                post={reply}
                viewer={viewerStates.get(reply.id) ?? NO_VIEWER}
                gate={viewer}
                handlers={handlers}
                variant="thread"
                pending={reply.id < 0n}
              />
              {(reply.replyCount ?? 0) > 0 && reply.id >= 0n && (
                <button
                  type="button"
                  className={styles.showThread}
                  onClick={() => router.push(`/post/${reply.id}/`)}
                >
                  {formatCount(reply.replyCount)} {reply.replyCount === 1 ? "reply" : "replies"} →
                </button>
              )}
            </div>
          ))
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
