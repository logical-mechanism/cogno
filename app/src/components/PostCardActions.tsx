"use client";

// PostCardActions — the X action row under every post (D2/D3).
//
//   ⟲ Reply 12     ❝ Quote     ♥ 38              ↗ Share
//   teal hover     teal hover  LIKE=UP vote      copy→toast
//
// Spread across ~425px max (X parity) with Share pushed to the trailing edge. The up-vote == an
// on-chain UP vote (D2). Tapping an active up/down vote toggle-clears it inline. The net
// stake-weighted SCORE is rendered inline between the up/down buttons; only the separate up/down
// weight breakdown stays detail-only (D2/D12). (Repost was dropped — quote + the stake-weighted
// vote cover amplification, and a bare repost redistributed nothing on this chain.)
//
// Presentational + optimistic: every count/filled state is driven by props the surface
// optimistically overrides; this row NEVER builds an extrinsic.

import { useCallback } from "react";
import { affordanceFor, affordanceTitle } from "@/lib/writeAffordance";
import styles from "./PostCardActions.module.css";
import { IconReply, IconQuote, IconShare, IconDownvote } from "./icons";
import { formatCount, formatSignedWeight } from "@/lib/format";
import type { CognoPost, ViewerPostState, Viewer } from "./kit";

export interface PostCardActionsProps {
  post: CognoPost;
  /** The viewer's relationship to this post (drives the filled up-vote). */
  viewer: ViewerPostState;
  /** Gate state (not-connected → welcome; not-identity-bound → disabled tooltip). */
  gate: Viewer;
  onReply: (post: CognoPost) => void;
  onQuote: (post: CognoPost) => void;
  /** Toggle the heart (UP vote): next=true → like, next=false → clear. */
  onLike: (post: CognoPost, next: boolean) => void;
  /** Secondary down-vote: next=true → downvote, false → clear (tap the active ▼ to clear). */
  onDownvote: (post: CognoPost, next: boolean) => void;
  /** Copy /post/[id] link → success toast (Share + the header "Copy link" item). */
  onCopyLink: (post: CognoPost) => void;
  /** Compact row (e.g. inside a denser context). */
  dense?: boolean;
  /**
   * This post is the OPTIMISTIC card, still carrying id -1n until the real one lands.
   *
   * PostCard's `.pending` rule sets `pointer-events: none`, which removes the mouse and nothing else —
   * the buttons kept their tab stops, so a keyboard user could reach them. That is not cosmetic: a vote
   * on -1n encodes as u64::MAX and submits a real signed extrinsic that can only fail PostNotFound,
   * spending talk-capacity and a nonce, and Share copies a permanently dead /post/-1/ link under a
   * "Link copied" toast. `disabled` is what actually removes the tab stop; keep the CSS rule too.
   */
  pending?: boolean;
}

export function PostCardActions({
  post,
  viewer,
  gate,
  onReply,
  onQuote,
  onLike,
  onDownvote,
  onCopyLink,
  dense,
  pending,
}: PostCardActionsProps) {
  const up = viewer.myVote === "Up";
  const down = viewer.myVote === "Down";
  // How this viewer's write controls should present themselves. Keyed on `writeReady` first, so a
  // signed-out guest and a bound-but-unlocked account are both handled (see lib/writeAffordance).
  const mode = affordanceFor({ status: gate.status, writeReady: gate.writeReady });
  // A guest's controls stay ENABLED and read as sign-in; only a mid-setup viewer is greyed out.
  // A pending card disables ALL FIVE, Share included — there is nothing yet to share, reply to or vote
  // on. Its own title, not affordanceTitle's: that resolves to a plain "Reply", which would leave a
  // disabled button promising an action it cannot perform.
  const gateDisabled = mode === "blocked" || pending === true;
  const titleFor = (verb: "reply" | "quote" | "vote", fallback: string) =>
    pending ? "Posting" : (affordanceTitle(mode, verb) ?? fallback);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const doUp = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onLike(post, !up); // onLike toggles the UP vote (next=false clears it)
    },
    [up, onLike, post],
  );

  const doDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDownvote(post, !down); // onDownvote toggles the DOWN vote (next=false clears it)
    },
    [down, onDownvote, post],
  );

  const doReply = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onReply(post);
    },
    [onReply, post],
  );

  const doQuote = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onQuote(post);
    },
    [onQuote, post],
  );

  const doShare = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onCopyLink(post);
    },
    [onCopyLink, post],
  );

  const replyCount = formatCount(post.replyCount);
  // Net stake-weighted score (upWeight − downWeight); may be negative. The appchain vote model
  // surfaced directly — ▲ score ▼ replaces the Twitter heart (user 2026-06-21).
  const score = formatSignedWeight(post.score ?? 0n);

  return (
    <div className={`${styles.row} ${dense ? styles.dense : ""}`} onClick={stop}>
      {/* Reply */}
      <button
        type="button"
        className={`${styles.action} ${styles.reply}`}
        aria-label={`Reply${post.replyCount ? `, ${post.replyCount}` : ""}`}
        disabled={gateDisabled}
        title={titleFor("reply", "Reply")}
        onClick={doReply}
      >
        <span className={styles.iconWrap}>
          <IconReply style={{ width: "var(--cg-icon-sm)", height: "var(--cg-icon-sm)" }} />
        </span>
        {replyCount && <span className={styles.count}>{replyCount}</span>}
      </button>

      {/* Quote */}
      <button
        type="button"
        className={`${styles.action} ${styles.quote}`}
        aria-label="Quote"
        disabled={gateDisabled}
        title={titleFor("quote", "Quote")}
        onClick={doQuote}
      >
        <span className={styles.iconWrap}>
          <IconQuote style={{ width: "var(--cg-icon-sm)", height: "var(--cg-icon-sm)" }} />
        </span>
      </button>

      {/* Stake-weighted up / down vote (replaces the Twitter heart) */}
      <div className={styles.voteGroup}>
        <button
          type="button"
          className={`${styles.action} ${styles.up} ${up ? styles.upOn : ""}`}
          aria-label={`Upvote${post.upCount ? `, ${post.upCount} upvote${post.upCount === 1 ? "" : "s"}` : ""}`}
          aria-pressed={up}
          disabled={gateDisabled}
          title={titleFor("vote", "Upvote")}
          onClick={doUp}
        >
          <span className={`${styles.iconWrap} ${up ? styles.pop : ""}`}>
            <IconDownvote
              style={{ width: "var(--cg-icon-sm)", height: "var(--cg-icon-sm)", transform: "rotate(180deg)" }}
            />
          </span>
        </button>
        <span
          className={`${styles.score} ${up ? styles.scoreUp : ""} ${down ? styles.scoreDown : ""}`}
          title="Net stake-weighted score"
          aria-label={`Net stake-weighted score ${score}`}
        >
          {score}
        </span>
        <button
          type="button"
          className={`${styles.action} ${styles.down} ${down ? styles.downOn : ""}`}
          aria-label={`Downvote${post.downCount ? `, ${post.downCount} downvote${post.downCount === 1 ? "" : "s"}` : ""}`}
          aria-pressed={down}
          disabled={gateDisabled}
          title={titleFor("vote", "Downvote")}
          onClick={doDown}
        >
          <span className={styles.iconWrap}>
            <IconDownvote style={{ width: "var(--cg-icon-sm)", height: "var(--cg-icon-sm)" }} />
          </span>
        </button>
      </div>

      {/* Share — trailing */}
      <button
        type="button"
        className={`${styles.action} ${styles.share}`}
        aria-label="Share post"
        disabled={gateDisabled}
        title={pending ? "Posting" : "Share"}
        onClick={doShare}
      >
        <span className={styles.iconWrap}>
          <IconShare style={{ width: "var(--cg-icon-sm)", height: "var(--cg-icon-sm)" }} />
        </span>
      </button>
    </div>
  );
}
