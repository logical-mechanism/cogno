"use client";

// PostCardActions — the X action row under every post (doc 03 §3, D2/D3).
//
//   ⟲ Reply 12     ↻ Repost 4     ❝ Quote 1     ♥ 38              ↗ Share
//   teal hover     green/perm     teal hover     LIKE=UP vote      copy→toast
//
// Spread across ~425px max (X parity) with Share pushed to the trailing edge. The HEART is the
// primary action and == an on-chain UP vote (D2): its count is `upCount` (number of likers, NOT
// weight); on like it fills --cg-like with the cg-like-pop animation. Repost is PERMANENT (D3):
// first click opens a one-time confirm dialog ("Reposts are permanent and cannot be undone."), then
// it turns filled green (--cg-repost), disabled, aria-pressed — there is NO un-repost. The SECONDARY
// down-vote, clear-vote, and copy-link live in the header's "···" overflow (doc §2.1), NOT in this
// row — but their callbacks are part of this component's contract (the PostCard wires the same bundle
// to both). The weighted score / up-down weights are NOT shown here (detail-only, D2/D12).
//
// Presentational + optimistic: every count/filled state is driven by props the surface
// optimistically overrides; this row NEVER builds an extrinsic.

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./PostCardActions.module.css";
import { IconReply, IconRepost, IconQuote, IconLike, IconShare } from "./icons";
import { formatCount } from "@/lib/format";
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
  /** Permanent repost — confirmed here, then submitted. */
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
  onDownvote: _onDownvote,
  onClearVote: _onClearVote,
  onCopyLink,
  likeState = "idle",
  repostState = "idle",
  dense,
}: PostCardActionsProps) {
  // onDownvote / onClearVote are part of the contract but routed through the header overflow; the
  // PostCard passes the same bundle to both. Referenced here so the prop is explicitly consumed.
  void _onDownvote;
  void _onClearVote;

  const [confirmRepost, setConfirmRepost] = useState(false);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  const liked = viewer.myVote === "Up";
  const reposted = viewer.reposted;
  const notBound = gate.status === "not-identity-bound";
  const likePending = likeState === "pending";
  const repostPending = repostState === "pending";

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const doLike = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onLike(post, !liked);
    },
    [liked, onLike, post],
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

  // close the confirm popover on click-out / Esc
  useEffect(() => {
    if (!confirmRepost) return;
    const onDoc = (e: MouseEvent) => {
      if (confirmRef.current && !confirmRef.current.contains(e.target as Node)) {
        setConfirmRepost(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmRepost(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [confirmRepost]);

  const onRepostClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (reposted) return; // terminal — no un-repost
      setConfirmRepost(true);
    },
    [reposted],
  );

  const confirmRepostNow = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setConfirmRepost(false);
      onRepost(post);
    },
    [onRepost, post],
  );

  const replyCount = formatCount(post.replyCount);
  const repostCount = formatCount(post.repostCount);
  // Quote count is hidden unless the seam provides it (no dedicated field today → omit).
  const likeCount = formatCount(post.upCount);

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

      {/* Repost — PERMANENT */}
      <div className={styles.repostWrap}>
        <button
          type="button"
          className={`${styles.action} ${styles.repost} ${reposted ? styles.repostOn : ""}`}
          aria-label={`Repost${post.repostCount ? `, ${post.repostCount}` : ""}`}
          aria-pressed={reposted}
          disabled={reposted || repostPending || notBound}
          title={
            reposted
              ? "Reposted (permanent)"
              : notBound
                ? "Finish setup to repost."
                : "Repost (permanent)"
          }
          onClick={onRepostClick}
        >
          <span className={styles.iconWrap}>
            <IconRepost
              filled={reposted}
              style={{ width: "var(--cg-icon-sm)", height: "var(--cg-icon-sm)" }}
            />
          </span>
          {repostCount && <span className={styles.count}>{repostCount}</span>}
        </button>

        {confirmRepost && (
          <div className={styles.confirm} ref={confirmRef} role="dialog" aria-label="Confirm repost">
            <p className={styles.confirmText}>Reposts are permanent and cannot be undone.</p>
            <button type="button" className={styles.confirmBtn} onClick={confirmRepostNow}>
              Repost
            </button>
          </div>
        )}
      </div>

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

      {/* Like == UP vote */}
      <button
        type="button"
        className={`${styles.action} ${styles.like} ${liked ? styles.likeOn : ""}`}
        aria-label={`Like${post.upCount ? `, ${post.upCount}` : ""}`}
        aria-pressed={liked}
        disabled={notBound || likePending}
        title={notBound ? "Finish setup to like." : undefined}
        onClick={doLike}
      >
        <span className={`${styles.iconWrap} ${liked ? styles.pop : ""}`}>
          <IconLike
            filled={liked}
            style={{ width: "var(--cg-icon-sm)", height: "var(--cg-icon-sm)" }}
          />
        </span>
        {likeCount && <span className={styles.count}>{likeCount}</span>}
      </button>

      {/* Share — trailing */}
      <button
        type="button"
        className={`${styles.action} ${styles.share}`}
        aria-label="Share — copy link to post"
        onClick={doShare}
      >
        <span className={styles.iconWrap}>
          <IconShare style={{ width: "var(--cg-icon-sm)", height: "var(--cg-icon-sm)" }} />
        </span>
      </button>
    </div>
  );
}
