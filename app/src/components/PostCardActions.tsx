"use client";

// PostCardActions — the X action row under every post (doc 03 §3, D2/D3).
//
//   ⟲ Reply 12     ↻ Repost 4     ❝ Quote 1     ♥ 38              ↗ Share
//   teal hover     green/perm     teal hover     LIKE=UP vote      copy→toast
//
// Spread across ~425px max (X parity) with Share pushed to the trailing edge. The up-vote == an
// on-chain UP vote (D2). Repost submits on a single click (everything on-chain is permanent, so we
// don't call it out) → it turns filled green (--cg-repost), disabled, aria-pressed — there is no
// un-repost. The clear-vote callback stays part of the contract (tap an active vote to clear). The
// weighted score / up-down weights are NOT shown here (detail-only, D2/D12).
//
// Presentational + optimistic: every count/filled state is driven by props the surface
// optimistically overrides; this row NEVER builds an extrinsic.

import { useCallback } from "react";
import styles from "./PostCardActions.module.css";
import { IconReply, IconRepost, IconQuote, IconShare, IconDownvote } from "./icons";
import { formatCount, formatSignedWeight } from "@/lib/format";
import type { CognoPost, ViewerPostState, Viewer, ActionState } from "./kit";

export interface PostCardActionsProps {
  post: CognoPost;
  /** The viewer's relationship to this post (drives filled heart / disabled repost). */
  viewer: ViewerPostState;
  /** Gate state (not-connected → welcome; not-identity-bound → disabled tooltip). */
  gate: Viewer;
  onReply: (post: CognoPost) => void;
  onQuote: (post: CognoPost) => void;
  /** Toggle the heart (UP vote): next=true → like, next=false → clear. */
  onLike: (post: CognoPost, next: boolean) => void;
  /** Repost — submitted on a single click; no un-repost. */
  onRepost: (post: CognoPost) => void;
  /** Secondary down-vote (surfaced in the header overflow): next=true → downvote, false → clear. */
  onDownvote: (post: CognoPost, next: boolean) => void;
  /** Clear any vote (surfaced in the header overflow). */
  onClearVote: (post: CognoPost) => void;
  /** Copy /post/[id] link → success toast (Share + the header "Copy link" item). */
  onCopyLink: (post: CognoPost) => void;
  /** Optimistic states for the Like + Repost buttons (spinner overlay until ok). */
  likeState?: ActionState;
  repostState?: ActionState;
  /** Compact row (e.g. inside a denser context). */
  dense?: boolean;
}

export function PostCardActions({
  post,
  viewer,
  gate,
  onReply,
  onQuote,
  onLike,
  onRepost,
  onDownvote,
  onClearVote: _onClearVote,
  onCopyLink,
  likeState = "idle",
  repostState = "idle",
  dense,
}: PostCardActionsProps) {
  // onClearVote stays part of the contract (header overflow "Clear vote"); unused in this row now
  // that up/down both toggle-clear inline.
  void _onClearVote;

  const up = viewer.myVote === "Up";
  const down = viewer.myVote === "Down";
  const reposted = viewer.reposted;
  const notBound = gate.status === "not-identity-bound";
  const likePending = likeState === "pending";
  const repostPending = repostState === "pending";

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

  const doRepost = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (reposted) return; // terminal — no un-repost
      onRepost(post);
    },
    [reposted, onRepost, post],
  );

  const replyCount = formatCount(post.replyCount);
  const repostCount = formatCount(post.repostCount);
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
        disabled={notBound}
        title={notBound ? "Finish setup to reply." : undefined}
        onClick={doReply}
      >
        <span className={styles.iconWrap}>
          <IconReply style={{ width: "var(--cg-icon-sm)", height: "var(--cg-icon-sm)" }} />
        </span>
        {replyCount && <span className={styles.count}>{replyCount}</span>}
      </button>

      {/* Repost — single click submits (no un-repost) */}
      <button
        type="button"
        className={`${styles.action} ${styles.repost} ${reposted ? styles.repostOn : ""}`}
        aria-label={`Repost${post.repostCount ? `, ${post.repostCount}` : ""}`}
        aria-pressed={reposted}
        disabled={reposted || repostPending || notBound}
        title={reposted ? "Reposted" : notBound ? "Finish setup to repost." : "Repost"}
        onClick={doRepost}
      >
        <span className={styles.iconWrap}>
          <IconRepost
            filled={reposted}
            style={{ width: "var(--cg-icon-sm)", height: "var(--cg-icon-sm)" }}
          />
        </span>
        {repostCount && <span className={styles.count}>{repostCount}</span>}
      </button>

      {/* Quote */}
      <button
        type="button"
        className={`${styles.action} ${styles.quote}`}
        aria-label="Quote"
        disabled={notBound}
        title={notBound ? "Finish setup to quote." : undefined}
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
          aria-label={`Upvote${post.upCount ? `, ${post.upCount} up` : ""}`}
          aria-pressed={up}
          disabled={notBound || likePending}
          title={notBound ? "Finish setup to vote." : "Upvote (stake-weighted)"}
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
        >
          {score}
        </span>
        <button
          type="button"
          className={`${styles.action} ${styles.down} ${down ? styles.downOn : ""}`}
          aria-label={`Downvote${post.downCount ? `, ${post.downCount} down` : ""}`}
          aria-pressed={down}
          disabled={notBound || likePending}
          title={notBound ? "Finish setup to vote." : "Downvote (stake-weighted)"}
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
        aria-label="Copy link to post"
        onClick={doShare}
      >
        <span className={styles.iconWrap}>
          <IconShare style={{ width: "var(--cg-icon-sm)", height: "var(--cg-icon-sm)" }} />
        </span>
      </button>
    </div>
  );
}
