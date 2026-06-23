"use client";

// QuotedPostEmbed — the shallow, one-level quoted-post card nested inside a PostCard when
// `post.quote` is set (doc 03 §5). Mirrors X's quoted-tweet embed: a bordered, rounded
// (--cg-radius-card) box with a small inline avatar + name + handle line, the quoted body clamped to
// a few lines, and NO action row. Clicking the box opens the quoted post's detail.
//
// Binds to the seam's QuotedRef (the compact, NON-recursive reference carried on CognoPost.quote) —
// there is no nested AuthorVM and no nested quote (recursion is bounded at one level by the seam).
// If the quoted author's identity was revoked, the body + name dim (D10). If the QuotedRef text is
// empty AND there is no resolvable author, we render the "unavailable" stub rather than a blank box.

import { useCallback } from "react";
import styles from "./QuotedPostEmbed.module.css";
import { Avatar } from "./Avatar";
import { DisplayName } from "./DisplayName";
import { Handle } from "./Handle";
import { PostBody } from "./PostBody";
import type { QuotedRef } from "./kit";

export interface QuotedPostEmbedProps {
  /** The quoted post reference (CognoPost.quote). */
  quoted: QuotedRef;
  /** Navigate to the quoted post's detail (/post/[id]/). The PostCard supplies this. */
  onOpen: (id: bigint) => void;
  /** Visual line-clamp on the quoted body. */
  maxLines?: number;
  /**
   * True when the quoted id could not be resolved (not yet indexed / pruned). Renders the muted
   * "This post is unavailable." stub instead of crashing. The surface sets this; we also fall back
   * to it when the ref carries no text AND no author.
   */
  unavailable?: boolean;
  /** The quoted post is itself a poll → show a small "Poll" chip (we never nest a live PollCard). */
  isPoll?: boolean;
}

export function QuotedPostEmbed({
  quoted,
  onOpen,
  maxLines = 6,
  unavailable,
  isPoll,
}: QuotedPostEmbedProps) {
  const missing = unavailable || (!quoted.text.trim() && !quoted.author);

  const open = useCallback(
    (e: React.MouseEvent) => {
      // Stop the parent PostCard row link from also firing.
      e.stopPropagation();
      if (!missing) onOpen(quoted.id);
    },
    [missing, onOpen, quoted.id],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return; // only when the box itself is focused
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        if (!missing) onOpen(quoted.id);
      }
    },
    [missing, onOpen, quoted.id],
  );

  if (missing) {
    return (
      <div className={styles.stub} aria-label="Quoted post unavailable">
        This post is unavailable.
      </div>
    );
  }

  const dim = quoted.authorRevoked;

  return (
    // A div role="link" (NOT a <button>) so the quoted body's image reveal-cover button and the
    // avatar cover are valid descendants — interactive content may not nest inside a <button>. Mirrors
    // PostCard's clickable-row pattern; every inner control stopPropagation()s.
    <div
      className={`${styles.box} ${dim ? styles.dim : ""}`}
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKeyDown}
      aria-label={`Quoted post by ${quoted.displayName?.trim() || quoted.author}`}
    >
      <div className={styles.header}>
        <Avatar address={quoted.author} src={quoted.avatar} size="sm" dim={dim} />
        <DisplayName
          address={quoted.author}
          displayName={quoted.displayName}
          authorRevoked={dim}
        />
        <Handle address={quoted.author} />
        {dim && <span className={styles.restricted}>This account has been restricted</span>}
        {isPoll && <span className={styles.pollChip}>Poll</span>}
      </div>

      <div className={styles.bodyClamp} style={{ ["--cg-clamp-lines" as string]: String(maxLines) }}>
        <PostBody text={quoted.text} dim={dim} />
      </div>
    </div>
  );
}
