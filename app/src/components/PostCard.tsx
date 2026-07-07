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
// TIME (D11): CognoPost.at is a block height, never a wall-clock timestamp; PostCardHeader surfaces
// only a relative age from it via <PostTime> (e.g. "· 2h"), never the raw block number.
// The up/down weight breakdown is NOT rendered here (detail-only, D2/D12) — the net score is.
//
// Presentational + optimistic. It NEVER imports a reader and NEVER builds an extrinsic — every write
// is a callback (the PostActionCallbacks bundle) supplied by the surface, optimistically overridden.

import { useCallback, useMemo, useState } from "react";
import styles from "./PostCard.module.css";
import { PostCardHeader } from "./PostCardHeader";
import { PostBody } from "./PostBody";
import { QuotedPostEmbed } from "./QuotedPostEmbed";
import { PollCard } from "./PollCard";
import { InlinePoll } from "./InlinePoll";
import { PostCardActions } from "./PostCardActions";
import { Spinner } from "./icons";
import { handleOf } from "@/lib/ss58";
import { useMuted, muteActions } from "@/lib/muteStore";
import { useBookmarked, bookmarkActions } from "@/lib/bookmarkStore";
import { useToaster } from "./toast/ToasterProvider";
import type {
  CognoPost,
  ViewerPostState,
  Viewer,
  PollView,
  AuthorRef,
  OverflowMenuItem,
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
  /** Search term to <mark> in the body (set only on search-result surfaces). */
  highlight?: string;
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
  highlight,
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

  // The "···" overflow menu now carries exactly one owner-only action: "Pin to profile" (the rest —
  // down-vote, clear-vote, copy-link — are buttons in the action row). Shown only on YOUR OWN, already
  // posted (non-pending) posts, and only when the surface wired onPin. Unpin lives in Settings → Profile.
  const isOwnPost =
    gate.status === "ready" && gate.address != null && gate.address === post.author;
  // Client-local mute (device-only, no chain state): collapse another account's posts everywhere.
  const muted = useMuted(post.author);
  // Client-local bookmark (device-only, no chain state): save any post to the /bookmarks shortlist.
  const bookmarked = useBookmarked(post.id);
  // Bookmarking lives only in the ··· menu (which closes on select) → toast so the save is confirmed,
  // mirroring the "Link copied" feedback on the sibling copy-link action.
  const { toast } = useToaster();
  const [revealed, setRevealed] = useState(false);
  const menuItems = useMemo<OverflowMenuItem[] | undefined>(() => {
    if (pending) return undefined;
    const items: OverflowMenuItem[] = [];
    if (isOwnPost && handlers.onPin) {
      items.push({ id: "pin", label: "Pin to profile", onSelect: () => handlers.onPin!(post) });
    }
    // Bookmark is available on EVERY post (your own included) — a personal, device-local save.
    items.push({
      id: "bookmark",
      label: bookmarked ? "Remove bookmark" : "Bookmark",
      onSelect: () => {
        bookmarkActions.toggle(post.id);
        toast(
          bookmarked
            ? { kind: "info", message: "Removed from bookmarks" }
            : { kind: "success", message: "Saved to bookmarks" },
        );
      },
    });
    if (!isOwnPost) {
      const handle = handleOf(post.author);
      items.push({
        id: "mute",
        label: muted ? `Unmute ${handle}` : `Mute ${handle}`,
        onSelect: () => muteActions.toggle(post.author),
      });
    }
    return items.length > 0 ? items : undefined;
  }, [pending, isOwnPost, handlers, post, muted, bookmarked, toast]);

  // A muted author's post collapses to a "Show" stub everywhere EXCEPT the detail focal (you opened it
  // on purpose). Revealing is local + reversible; the full card keeps its "Unmute" in the ··· menu.
  const collapsed = muted && !detail && !isOwnPost && !pending && !revealed;
  if (collapsed) {
    return (
      <article
        className={[styles.card, styles[variant], styles.mutedRow, showThreadLine ? styles.threadLine : ""]
          .filter(Boolean)
          .join(" ")}
        data-post-id={String(post.id)}
      >
        <div className={styles.mutedStub}>
          <span className={styles.mutedText}>Post from a muted account</span>
          <button type="button" className={styles.mutedShow} onClick={() => setRevealed(true)}>
            Show
          </button>
        </div>
      </article>
    );
  }

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
          menuItems={menuItems}
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
              <button
                type="button"
                className={styles.replyTarget}
                // parent is a post id, not an account — link to the parent post (not a fake @handle).
                onClick={(e) => {
                  e.stopPropagation();
                  if (post.parent != null) handlers.onOpen(post.parent);
                }}
              >
                a post
              </button>
            </p>
          )}

          <PostBody text={post.text} size={detail ? "lg" : "base"} dim={dim} highlight={highlight} />

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
            onCopyLink={handlers.onShare}
            dense={detail ? false : undefined}
          />
        </div>
      </div>
    </article>
  );
}
