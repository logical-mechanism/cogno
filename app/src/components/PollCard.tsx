"use client";

// PollCard — an on-chain poll rendered inside its host PostCard (D4).
//
// 2–4 options as WEIGHTED percentage bars (option.weight / poll.totalWeight, via weightPercent), the
// viewer's choice marked with a ✓, and a totals line. Weighted results are derived LIVE (they re-price as
// stake moves) while the poll is OPEN. A poll MAY carry a block-number deadline (spec 205): once past it
// voting stops and the chip shows "Closed" (the result reads live until someone finalizes it) → "Final
// results" once frozen. An open poll's chip is "Open" (pre-vote) / "Live results" (post-vote).
//
// Results (bars + %) show once the viewer has voted (myChoice != null), when `showResults` is set (the
// detail variant), OR whenever the poll is closed. Pre-vote in an open timeline card the options are
// clickable radio rows with no bars.
//
// Re-cast REPLACES (chain semantics): a voter may switch options but there is no clear-poll-vote
// extrinsic, so we never offer "remove vote" — only switching. Zero voting power still votes (a
// zero-weight cast is valid and bumps `count` not `weight`); the surface owns that nudge.
//
// Presentational only: it takes a PollView + myChoice + onVote (+ optional close state / onFinalize) and
// NEVER builds an extrinsic.

import { useCallback, useRef } from "react";
import styles from "./PollCard.module.css";
import { Spinner, IconCheck } from "./icons";
import { weightPercent, formatWeight } from "@/lib/format";
import { sanitizeInline } from "@/lib/sanitize";
import type { PollView } from "./kit";

export interface PollCardProps {
  /** The poll: options/weights/counts + totals (poll.hostId == the host post id). */
  poll: PollView;
  /** The option index the viewer has cast, or null if they haven't voted. */
  myChoice: number | null;
  /** Optimistic cast → cast_poll_vote(hostId, option). The surface owns the extrinsic. */
  onVote: (option: number) => void;
  /** Force results visible (detail variant); otherwise results show once myChoice != null. */
  showResults?: boolean;
  /** Disable voting (e.g. not-identity-bound). The surface still renders the gate copy elsewhere. */
  disabled?: boolean;
  /**
   * Tooltip explaining WHY voting is disabled (e.g. "Finish setup to vote") — shown on each option only
   * for the `disabled` gate, never for a closed poll (which is self-explanatory). Mirrors PostCardActions,
   * which keeps the same not-bound copy on its vote controls, so the two controls on one card agree.
   */
  disabledHint?: string;
  /** Tighter bars inside a dense timeline card. */
  compact?: boolean;
  /**
   * Poll close state (spec 205): `"open"` (or omitted) = still votable; `"provisional"` = past its
   * deadline, result reads live and can be finalized; `"final"` = frozen. Non-open states disable voting
   * and always reveal results.
   */
  closeState?: "open" | "provisional" | "final";
  /** Permissionlessly finalize a provisional poll (freezes the weighted result). Shown only when provisional. */
  onFinalize?: () => void;
  /** A finalize (`close_poll`) is in flight → spinner on the Finalize control. */
  finalizing?: boolean;
}

export function PollCard({
  poll,
  myChoice,
  onVote,
  showResults,
  disabled,
  disabledHint,
  compact,
  closeState = "open",
  onFinalize,
  finalizing,
}: PollCardProps) {
  const voted = myChoice != null;
  const closed = closeState !== "open";
  // A closed poll accepts no votes and always shows results.
  const votingDisabled = disabled || closed;
  const results = showResults || voted || closed;
  const noWeight = poll.totalWeight <= 0n;

  // WAI-ARIA radiogroup: a single tab stop (the checked option, else the first) + arrow-key roving.
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const rovingPos = myChoice != null ? Math.max(0, poll.options.findIndex((o) => o.index === myChoice)) : 0;

  const click = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.stopPropagation();
      if (votingDisabled || index === myChoice) return;
      onVote(index);
    },
    [votingDisabled, myChoice, onVote],
  );

  // Arrow keys MOVE FOCUS ONLY between options — they never cast (a poll vote is an irreversible
  // on-chain action, so casting stays on click / Enter / Space per the D4 comment above).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (votingDisabled) return; // disabled buttons aren't focusable, so nothing to rove
      const dir =
        e.key === "ArrowDown" || e.key === "ArrowRight"
          ? 1
          : e.key === "ArrowUp" || e.key === "ArrowLeft"
            ? -1
            : 0;
      if (dir === 0) return;
      e.preventDefault();
      const btns = optionRefs.current;
      const count = poll.options.length;
      let cur = btns.findIndex((b) => b === document.activeElement);
      if (cur < 0) cur = rovingPos;
      btns[(cur + dir + count) % count]?.focus();
    },
    [votingDisabled, poll.options.length, rovingPos],
  );

  return (
    <div
      className={`${styles.poll} ${compact ? styles.compact : ""}`}
      role="radiogroup"
      aria-label="Poll"
      onKeyDown={onKeyDown}
    >
      <div className={styles.options}>
        {poll.options.map((opt, i) => {
          const pct = noWeight ? 0 : weightPercent(opt.weight, poll.totalWeight);
          const mine = opt.index === myChoice;
          // Option labels are attacker-controlled on-chain text → harden (bidi / invisible / Zalgo)
          // before they reach the DOM or the accessible name.
          const label = sanitizeInline(opt.label);
          // Accessible name carries the weighted % + the raw voter count (whale vs many-small).
          const ariaLabel = results
            ? `${label}, ${pct} percent, ${opt.count} ${opt.count === 1 ? "vote" : "votes"}${
                mine ? ", your choice" : ""
              }`
            : label;

          return (
            <button
              key={opt.index}
              type="button"
              role="radio"
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              aria-checked={mine}
              aria-label={ariaLabel}
              // Explain the gate on hover for the disabled (not-bound) case — a closed poll needs no such
              // hint, so scope the title to the `disabled` prop, not the derived `votingDisabled`.
              title={disabled && !closed ? disabledHint : undefined}
              tabIndex={i === rovingPos ? 0 : -1}
              className={`${styles.option} ${results ? styles.resultRow : styles.voteRow} ${
                mine ? styles.mine : ""
              }`}
              disabled={votingDisabled}
              onClick={(e) => click(e, opt.index)}
            >
              {results && (
                <span
                  className={`${styles.bar} ${mine ? styles.barMine : ""}`}
                  style={{ width: `${pct}%` }}
                  aria-hidden
                />
              )}
              <span className={styles.optLabel} dir="auto">
                {label}
              </span>
              {results && (
                <span className={styles.optMeta}>
                  {mine && (
                    <IconCheck className={styles.check} style={{ width: "1em", height: "1em" }} />
                  )}
                  <span className={styles.pct}>{noWeight ? "—" : `${pct}%`}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className={styles.totals}>
        <span className={styles.voters}>
          {poll.totalCount} {poll.totalCount === 1 ? "voter" : "voters"}
        </span>
        <span className={styles.dot} aria-hidden>
          ·
        </span>
        <span className={styles.weighted}>
          {noWeight ? "weighted —" : `${formatWeight(poll.totalWeight)} weighted`}
        </span>
        <span className={styles.dot} aria-hidden>
          ·
        </span>
        {closeState === "final" ? (
          <span className={styles.open}>Final results</span>
        ) : closeState === "provisional" ? (
          <>
            <span className={styles.open}>Closed</span>
            {onFinalize && (
              <button
                type="button"
                className={styles.finalize}
                disabled={finalizing}
                onClick={(e) => {
                  e.stopPropagation();
                  onFinalize();
                }}
              >
                {finalizing ? <Spinner size="sm" /> : "Finalize"}
              </button>
            )}
          </>
        ) : (
          <span className={styles.open}>{voted ? "Live results" : "Open"}</span>
        )}
      </div>
    </div>
  );
}
