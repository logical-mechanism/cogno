"use client";

// PollCard — an on-chain poll rendered inside its host PostCard (D4).
//
// 2–4 options as WEIGHTED percentage bars (option.weight / poll.totalWeight, via weightPercent), the
// viewer's choice marked with a ✓, and a totals line. Polls NEVER expire on-chain, so the chip is a
// STATIC "Open" (pre-vote) / "Live results" (post-vote) — NEVER a countdown/timer.
//
// Results (bars + %) show once the viewer has voted (myChoice != null), OR always when `showResults`
// is set (the detail variant reveals results regardless so the data is inspectable). Pre-vote in a
// timeline card the options are clickable radio rows with no bars.
//
// Re-cast REPLACES (chain semantics): a voter may switch options but there is no clear-poll-vote
// extrinsic, so we never offer "remove vote" — only switching. Zero voting power still votes (a
// zero-weight cast is valid and bumps `count` not `weight`); the surface owns that nudge.
//
// Presentational only: it takes a PollView + myChoice + onVote and NEVER builds an extrinsic.

import { useCallback, useRef } from "react";
import styles from "./PollCard.module.css";
import { Spinner, IconCheck } from "./icons";
import { weightPercent, formatWeight } from "@/lib/format";
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
  /** The option index currently in flight (optimistic) → shows a spinner on that row. */
  pendingChoice?: number | null;
  /** Tighter bars inside a dense timeline card. */
  compact?: boolean;
}

export function PollCard({
  poll,
  myChoice,
  onVote,
  showResults,
  disabled,
  pendingChoice,
  compact,
}: PollCardProps) {
  const voted = myChoice != null;
  const results = showResults || voted;
  const noWeight = poll.totalWeight <= 0n;

  // WAI-ARIA radiogroup: a single tab stop (the checked option, else the first) + arrow-key roving.
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const rovingPos = myChoice != null ? Math.max(0, poll.options.findIndex((o) => o.index === myChoice)) : 0;

  const click = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.stopPropagation();
      if (disabled || index === myChoice) return;
      onVote(index);
    },
    [disabled, myChoice, onVote],
  );

  // Arrow keys MOVE FOCUS ONLY between options — they never cast (a poll vote is an irreversible
  // on-chain action, so casting stays on click / Enter / Space per the D4 comment above).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return; // disabled buttons aren't focusable, so nothing to rove
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
    [disabled, poll.options.length, rovingPos],
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
          const pending = pendingChoice === opt.index;
          // Accessible name carries the weighted % + the raw voter count (whale vs many-small).
          const ariaLabel = results
            ? `${opt.label}, ${pct} percent, ${opt.count} ${opt.count === 1 ? "vote" : "votes"}${
                mine ? ", your choice" : ""
              }`
            : opt.label;

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
              tabIndex={i === rovingPos ? 0 : -1}
              className={`${styles.option} ${results ? styles.resultRow : styles.voteRow} ${
                mine ? styles.mine : ""
              }`}
              disabled={disabled}
              onClick={(e) => click(e, opt.index)}
            >
              {results && (
                <span
                  className={`${styles.bar} ${mine ? styles.barMine : ""}`}
                  style={{ width: `${pct}%` }}
                  aria-hidden
                />
              )}
              <span className={styles.optLabel}>{opt.label}</span>
              {results && (
                <span className={styles.optMeta}>
                  {pending && <Spinner size="sm" />}
                  {mine && (
                    <IconCheck className={styles.check} style={{ width: "1em", height: "1em" }} />
                  )}
                  <span className={styles.pct}>{noWeight ? "—" : `${pct}%`}</span>
                </span>
              )}
              {!results && pending && (
                <span className={styles.optMeta}>
                  <Spinner size="sm" />
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
        {/* NEVER a countdown — polls do not expire on-chain (D4). */}
        <span className={styles.open}>{voted ? "Live results" : "Open"}</span>
      </div>
    </div>
  );
}
