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
import { ProposalPreview } from "./ProposalPreview";
import { GovernanceResult } from "./GovernanceResult";
import { classifyChoice, GOV_ACTION_LABEL } from "@/lib/cardano/governance";
import { weightPercent, formatWeight } from "@/lib/format";
import { sanitizeInline } from "@/lib/sanitize";
import {
  primaryLens,
  showsChamberBlock,
  lensWeight,
  lensCount,
  lensVoters,
} from "@/lib/poll";
import type { PollView, PollOptionView } from "./kit";

/** Does a poll kind surface the SPO / dRep chamber? (Mirrors the runtime — an Spo/Drep-only poll shows one.) */
const kindHasSpo = (k: PollView["kind"]) => k === "Governance" || k === "Spo";
const kindHasDrep = (k: PollView["kind"]) => k === "Governance" || k === "Drep";

/** A short pill label for a chamber poll (null for a plain Stake poll). */
function chamberPill(k: PollView["kind"]): string | null {
  return k === "Governance" ? "Governance" : k === "Spo" ? "SPO poll" : k === "Drep" ? "dRep poll" : null;
}

/** Only allow an http(s) proposal link — on-chain text is attacker-controlled, so never render `javascript:`. */
function safeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

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
  /**
   * A visible notice explaining why voting is blocked here — set by the surface for a single-chamber poll
   * (`Spo` / `Drep`) the viewer can't vote in because they don't hold that Cardano role. Distinct from
   * `disabledHint` (a per-option tooltip): a touch user gets no hover, so the reason must be on the page.
   * Only pass while the poll is OPEN — a closed poll is disabled for everyone and needs no such notice.
   */
  gateNotice?: string;
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
  gateNotice,
}: PollCardProps) {
  const voted = myChoice != null;
  const closed = closeState !== "open";
  // A closed poll accepts no votes and always shows results.
  const votingDisabled = disabled || closed;
  const results = showResults || voted || closed;
  // Governance-vote mode: an action-tagged poll whose options are the canonical Yes/No(/Abstain). Its
  // RESULTS read out per-chamber against the real CIP-1694 threshold (GovernanceResult) instead of plain
  // weighted bars; pre-vote it still shows the Yes/No/Abstain rows so a member can cast.
  const govMode =
    poll.action != null &&
    poll.options.some((o) => classifyChoice(o.label) === "yes") &&
    poll.options.some((o) => classifyChoice(o.label) === "no");
  // Keep the vote buttons whenever the viewer can still cast — even on the detail view, where `results` is
  // forced (a guest funnels to /welcome on click). In govMode the buttons stay plain radios (`rowResults`
  // suppresses the per-option bars) because the standings live in the GovernanceResult readout below.
  const castable = !votingDisabled;
  const rowResults = results && !govMode;
  // The poll renders interactive radio options (a real ARIA radiogroup) exactly when the viewer can cast —
  // for a govMode poll the readout can stand alone (closed / blocked non-member), and an empty radiogroup
  // is an invalid relationship, so the container is a plain group then.
  const hasVotingRows = !govMode || castable;
  // The lens the headline bars read: a single-chamber (`Spo`/`Drep`) poll reads out THAT chamber directly
  // (delegated stake, distinct pools/dReps); `Stake`/`Governance` keep the holder (own-stake) lens. All the
  // headline math — %, the totals line, the accessible counts — routes through this lens.
  const lens = primaryLens(poll.kind);
  const totalWeight =
    lens === "holder"
      ? poll.totalWeight
      : poll.options.reduce((s, o) => s + lensWeight(o, lens), 0n);
  const totalCount =
    lens === "holder"
      ? poll.totalCount
      : poll.options.reduce((s, o) => s + lensCount(o, lens), 0);
  const noWeight = totalWeight <= 0n;
  // A tagged governance poll (spec 209): a safe link to the off-chain proposal, or null if unsafe/absent.
  const proposalUrl = poll.action ? safeUrl(poll.action.anchorUrl) : null;

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
      role={hasVotingRows ? "radiogroup" : "group"}
      aria-label={hasVotingRows ? "Poll" : "Poll results"}
      onKeyDown={onKeyDown}
    >
      {poll.action && (
        <>
          <div className={styles.govAction}>
            <span className={styles.govActionType}>{GOV_ACTION_LABEL[poll.action.actionType]}</span>
            {proposalUrl && (
              <a
                className={styles.govLink}
                href={proposalUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                onClick={(e) => e.stopPropagation()}
              >
                View proposal ↗
              </a>
            )}
          </div>
          {/* Read the CIP-108 proposal contents IN the poll (on-demand), not just a link out. */}
          <ProposalPreview action={poll.action} />
        </>
      )}
      {hasVotingRows && (
      <div className={styles.options}>
        {poll.options.map((opt, i) => {
          const pct = noWeight ? 0 : weightPercent(lensWeight(opt, lens), totalWeight);
          const mine = opt.index === myChoice;
          // Option labels are attacker-controlled on-chain text → harden (bidi / invisible / Zalgo)
          // before they reach the DOM or the accessible name.
          const label = sanitizeInline(opt.label);
          // Accessible name carries the weighted % + the raw voter count in the headline lens (whale vs
          // many-small; distinct pools/dReps for a single-chamber poll).
          const ariaLabel = rowResults
            ? `${label}, ${pct} percent, ${lensVoters(lensCount(opt, lens), lens)}${
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
              className={`${styles.option} ${rowResults ? styles.resultRow : styles.voteRow} ${
                mine ? styles.mine : ""
              }`}
              disabled={votingDisabled}
              onClick={(e) => click(e, opt.index)}
            >
              {rowResults && (
                <span
                  className={`${styles.bar} ${mine ? styles.barMine : ""}`}
                  style={{ width: `${pct}%` }}
                  aria-hidden
                />
              )}
              <span className={styles.optLabel} dir="auto">
                {label}
              </span>
              {rowResults && (
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
      )}

      {gateNotice && (
        // aria-live: when the viewer's roles resolve to a confirmed non-member mid-view (options flip to
        // disabled and can steal focus), the reason is announced instead of silently appearing.
        <p className={styles.gateNotice} role="note" aria-live="polite">
          {gateNotice}
        </p>
      )}

      {/* Governance readout: per-chamber approval vs the real CIP-1694 bar. Shown WITH the vote buttons
          above (not instead), so a member can still cast on the detail view. */}
      {govMode && results && <GovernanceResult poll={poll} action={poll.action!} />}

      <div className={styles.totals}>
        <span className={styles.voters}>{lensVoters(totalCount, lens)}</span>
        <span className={styles.dot} aria-hidden>
          ·
        </span>
        {/* In governance-vote mode the holder "weighted" total is noise — GovernanceResult carries the
            real per-chamber stake — so drop it and go straight to the pill/state. */}
        {!govMode && (
          <>
            <span className={styles.weighted}>
              {noWeight ? "weighted —" : `${formatWeight(totalWeight)} weighted`}
            </span>
            <span className={styles.dot} aria-hidden>
              ·
            </span>
          </>
        )}
        {chamberPill(poll.kind) && (
          <>
            <span
              className={styles.govPill}
              title="A Cardano-community temperature check — chamber-weighted, display-only"
            >
              {chamberPill(poll.kind)}
            </span>
            <span className={styles.dot} aria-hidden>
              ·
            </span>
          </>
        )}
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

      {showsChamberBlock(poll.kind) && results && !govMode && (
        <div className={styles.chambers}>
          {(
            [
              { key: "spo", title: "SPO chamber", unit: "pool", show: kindHasSpo(poll.kind), w: (o: PollOptionView) => o.spoWeight, c: (o: PollOptionView) => o.spoCount },
              { key: "drep", title: "dRep chamber", unit: "dRep", show: kindHasDrep(poll.kind), w: (o: PollOptionView) => o.drepWeight, c: (o: PollOptionView) => o.drepCount },
            ] as const
          )
            .filter((ch) => ch.show)
            .map((ch) => {
            const total = poll.options.reduce((s, o) => s + ch.w(o), 0n);
            const voters = poll.options.reduce((s, o) => s + ch.c(o), 0);
            return (
              <div key={ch.key} className={styles.chamber}>
                <div className={styles.chamberHead}>
                  <span className={styles.chamberTitle}>{ch.title}</span>
                  <span className={styles.chamberMeta}>
                    {total > 0n
                      ? `${formatWeight(total)} · ${voters} ${ch.unit}${voters === 1 ? "" : "s"}`
                      : `no ${ch.unit}s voted`}
                  </span>
                </div>
                {total > 0n && (
                  <div className={styles.chamberBars}>
                    {poll.options.map((o) => {
                      const pct = weightPercent(ch.w(o), total);
                      return (
                        <div key={o.index} className={styles.chamberRow}>
                          <span className={styles.chamberLabel} dir="auto">
                            {sanitizeInline(o.label)}
                          </span>
                          <span className={styles.chamberBarTrack} aria-hidden>
                            <span className={styles.chamberBar} style={{ width: `${pct}%` }} />
                          </span>
                          <span className={styles.chamberPct}>{pct}%</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
