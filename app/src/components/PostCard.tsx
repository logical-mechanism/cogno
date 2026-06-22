"use client";

// PostCard — the load-bearing unit: one post in any list context (doc 03 §1).
//
// Composes PostCardHeader + an optional "Replying to" line + PostBody + an optional QuotedPostEmbed
// OR PollCard + PostCardActions. Carries the optimistic-pending rendering (opacity 0.6, actions
// disabled, no row nav) and the banned/authorRevoked dimming (D10 — content STAYS, we dim + chip,
// never hide). Clicking anywhere on the row (outside an interactive child) navigates to /post/[id]/
// via an X-style overlay <a> covering the non-interactive area, so the whole card is a real link
// without nesting buttons inside an anchor; every inner control stopPropagation()s so it doesn't
// trigger the row link.
//
// NO TIME / NO BLOCK MARGINALIA (locked decision + D11): CognoPost.at is a block height, never shown.
// The weighted score + up/down weights are NOT rendered here (detail-only, D2/D12).
//
// Presentational + optimistic. It NEVER imports a reader and NEVER builds an extrinsic — every write
// is a callback (the PostActionCallbacks bundle) supplied by the surface, optimistically overridden.

import { useCallback, useMemo } from "react";
import styles from "./PostCard.module.css";
import { PostCardHeader } from "./PostCardHeader";
import { PostBody } from "./PostBody";
import { QuotedPostEmbed } from "./QuotedPostEmbed";
import { PollCard } from "./PollCard";
import { InlinePoll } from "./InlinePoll";
import { PostCardActions } from "./PostCardActions";
import { Spinner } from "./icons";
import { handleOf } from "@/lib/ss58";
import type {
  CognoPost,
  ViewerPostState,
  Viewer,
  PollView,
  AuthorRef,
  PostActionCallbacks,
  PostCardVariant,
} from "./kit";

export interface PostCardProps {
  /** The post (§0.4). */
  post: CognoPost;
  /** The viewer's relationship to this post — drives filled heart / disabled repost / poll choice. */
  viewer: ViewerPostState;
  /** Coarse write-gate state (§0.2) — supplied by AppShell, never computed here. */
  gate: Viewer;
  /** The shared callback bundle every list surface forwards (open / author / reply / quote / like / …). */
  handlers: PostActionCallbacks;
  /** dense timeline row / focused detail / threaded reply. */
  variant?: PostCardVariant;
  /** This card is an optimistic, not-yet-confirmed post → renders at opacity 0.6, actions disabled. */
  pending?: boolean;
  /** Draw the connecting vertical thread line (reply/thread context). */
  showThreadLine?: boolean;
  /** Surface-specific header slot (e.g. a "Pinned" marker on a profile). */
  headerExtra?: React.ReactNode;
  /** The poll attached to this post (when post.isPoll). Fetched separately by the surface. */
  poll?: PollView | null;
  /** The viewer's poll choice (option index), or null. */
  pollMyChoice?: number | null;
  /** Optimistic cast for the attached poll. */
  onPollVote?: (option: number) => void;
}

/** Build the minimal author descriptor the header/embed need from a CognoPost's flattened fields. */
function authorOf(post: CognoPost): AuthorRef {
  return {
    address: post.author,
    displayName: post.authorDisplayName,
    avatar: post.authorAvatar,
    banned: post.authorRevoked === true,
  };
}

export function PostCard({
  post,
  viewer,
  gate,
  handlers,
  variant = "timeline",
  pending,
  showThreadLine,
  headerExtra,
  poll,
  pollMyChoice,
  onPollVote,
}: PostCardProps) {
  const author = useMemo(() => authorOf(post), [post]);
  const dim = post.authorRevoked === true;
  const detail = variant === "detail";
  const isReply = post.parent != null;
  // The detail (focal) card is the post you're already on → not a self-opening link; pending cards
  // aren't navigable yet. Everything else is a clickable row.
  const clickable = !pending && !detail;

  // The WHOLE card opens the post: any click that isn't on an interactive child (button / link /
  // input) and isn't a text selection navigates. Replaces the old inset overlay button, which sat
  // under the content and only caught the thin padding → users couldn't tell the card was clickable.
  const onCardClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("a,button,input,textarea,select,label,[role='button']")) {
        return;
      }
      if (window.getSelection()?.toString()) return; // don't hijack a text selection
      handlers.onOpen(post.id);
    },
    [handlers, post.id],
  );

  const onCardKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return; // only when the card itself is focused
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handlers.onOpen(post.id);
      }
    },
    [handlers, post.id],
  );

  // Clearing a vote is expressed through the existing bundle (no dedicated onClearVote on the seam):
  // an Up vote clears via onLike(post,false); a Down vote clears via onDownvote(post,false).
  const clearVote = useCallback(
    (p: CognoPost) => {
      if (viewer.myVote === "Up") handlers.onLike(p, false);
      else if (viewer.myVote === "Down") handlers.onDownvote(p, false);
    },
    [handlers, viewer.myVote],
  );

  // No "···" overflow menu: every action it held (down-vote, clear-vote, copy-link) is a button in
  // the action row below (down-vote ▼, tap-active-to-clear, Share = copy link), so it was redundant.

  const cls = [
    styles.card,
    styles[variant],
    pending ? styles.pending : "",
    dim ? styles.dimmed : "",
    showThreadLine ? styles.threadLine : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={cls}
      data-post-id={String(post.id)}
      aria-busy={pending || undefined}
      role={clickable ? "link" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? "Open post" : undefined}
      onClick={clickable ? onCardClick : undefined}
      onKeyDown={clickable ? onCardKeyDown : undefined}
    >
      <div className={styles.inner}>
        <PostCardHeader
          author={author}
          at={post.at}
          onAuthorOpen={handlers.onAuthorOpen}
          detail={detail}
          headerExtra={
            <>
              {headerExtra}
              {pending && (
                <span className={styles.pendingMark}>
                  <Spinner size="sm" label="Posting" />
                </span>
              )}
            </>
          }
        />

        <div className={styles.column}>
          {isReply && variant !== "thread" && (
            <p className={styles.replyContext}>
              Replying to{" "}
              <span className={styles.replyTarget}>{handleOf(String(post.parent))}</span>
            </p>
          )}

          <PostBody text={post.text} size={detail ? "lg" : "base"} dim={dim} />

          {post.quote && (
            <QuotedPostEmbed
              quoted={post.quote}
              onOpen={handlers.onOpen}
              isPoll={false}
            />
          )}

          {post.isPoll &&
            (poll && onPollVote ? (
              // Surface pre-wired the poll (ThreadView focal): use it directly.
              <PollCard
                poll={poll}
                myChoice={pollMyChoice ?? null}
                onVote={onPollVote}
                showResults={detail}
                disabled={gate.status === "not-identity-bound"}
                compact={!detail}
              />
            ) : (
              // List context (timeline/profile): self-fetch + render the votable poll inline so it
              // isn't just a plain text post.
              !pending && <InlinePoll postId={post.id} gate={gate} detail={detail} />
            ))}

          <PostCardActions
            post={post}
            viewer={viewer}
            gate={gate}
            onReply={handlers.onReply}
            onQuote={handlers.onQuote}
            onLike={handlers.onLike}
            onRepost={handlers.onRepost}
            onDownvote={handlers.onDownvote}
            onClearVote={clearVote}
            onCopyLink={handlers.onShare}
            dense={detail ? false : undefined}
          />
        </div>
      </div>
    </article>
  );
}
