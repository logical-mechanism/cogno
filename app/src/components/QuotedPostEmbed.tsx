"use client";

// QuotedPostEmbed — the shallow, one-level quoted-post card nested inside a PostCard when
// `post.quote` is set. Mirrors X's quoted-tweet embed: a bordered, rounded
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
import { RoleBadge } from "./RoleBadge";
import { PostBody } from "./PostBody";
import { useNestedQuote } from "@/hooks/useNestedQuote";
import { useBlocked } from "@/lib/blockStore";
import { useHidden } from "@/lib/hiddenStore";
import { sanitizeInline } from "@/lib/sanitize";
import type { QuotedRef, Ss58 } from "./kit";

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
  /** The viewer's ss58, so a quoted BLOCKED author is suppressed here too (block is a hard removal;
   *  without this a blocked account's content leaks through the quote embed of a non-blocked post). */
  viewerId?: Ss58 | null;
}

export function QuotedPostEmbed({
  quoted,
  onOpen,
  maxLines = 6,
  unavailable,
  isPoll,
  viewerId,
}: QuotedPostEmbedProps) {
  const missing = unavailable || (!quoted.text.trim() && !quoted.author);
  const blocked = useBlocked(quoted.author, viewerId ?? null);
  // A post the viewer HID must not resurface through a quote embed either (hide = "never show this one").
  const hidden = useHidden(quoted.id, viewerId ?? null);

  // Does the quoted post ITSELF quote another post? The one-level seam can't carry that, so a shared
  // cache does one cheap keyed read (null until known / when it quotes nothing). We surface a subtle
  // "Quoted post →" pill that jumps straight to that inner post — one level, never a nested embed.
  const innerQuoteId = useNestedQuote(missing ? undefined : quoted.id);

  const open = useCallback(
    (e: React.MouseEvent) => {
      // Stop the parent PostCard row link from also firing.
      e.stopPropagation();
      if (!missing) onOpen(quoted.id);
    },
    [missing, onOpen, quoted.id],
  );

  const openInner = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (innerQuoteId != null) onOpen(innerQuoteId);
    },
    [innerQuoteId, onOpen],
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

  // A quoted post by a blocked author is suppressed like everywhere else (hard removal, no reveal).
  if (blocked) {
    return (
      <div className={styles.stub} aria-label="Quoted a blocked account">
        You&apos;ve blocked this account.
      </div>
    );
  }

  // A quoted post the viewer hid is suppressed too — hide is reversible only via Unhide (no inline reveal).
  if (hidden) {
    return (
      <div className={styles.stub} aria-label="Quoted a hidden post">
        You&apos;ve hidden this post.
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
      aria-label={`Quoted post by ${sanitizeInline(quoted.displayName ?? "") || quoted.author}`}
    >
      <div className={styles.header}>
        <Avatar address={quoted.author} src={quoted.avatar} size="sm" dim={dim} />
        <DisplayName
          address={quoted.author}
          displayName={quoted.displayName}
          authorRevoked={dim}
        />
        <RoleBadge roles={quoted.authorRoles} />
        <Handle address={quoted.author} />
        {dim && <span className={styles.restricted}>This account has been restricted</span>}
        {isPoll && <span className={styles.pollChip}>Poll</span>}
      </div>

      <div className={styles.bodyClamp} style={{ ["--cg-clamp-lines" as string]: String(maxLines) }}>
        <PostBody text={quoted.text} dim={dim} />
      </div>

      {/* This quoted post itself quotes another — a subtle, non-recursive reference that jumps to that
          inner post (we deliberately never render a second embed level; the seam is one-level). */}
      {innerQuoteId != null && (
        <button
          type="button"
          className={styles.quotePill}
          onClick={openInner}
          aria-label="This post also quotes another post; open it"
        >
          Quoted post →
        </button>
      )}
    </div>
  );
}
