"use client";

// AccountVoteControl — the stake-weighted up/down REPUTATION vote ON an account, shown in the profile
// header next to FollowCounts. The community endorses (up) or disputes (down) whether this account is
// who it claims to be — the anti-Sybil / anti-impersonation signal. Mirrors the post ▲ score ▼ group
// (PostCardActions), re-keyed to an account target. Presentational + optimistic: the surface owns the
// tally + the viewer's own vote + the optimistic override; this control NEVER builds an extrinsic.
//
// Self-view: the arrows are hidden (you cannot vote your own account) but the score stays visible so you
// can see your own standing. not-identity-bound: the arrows are disabled with a setup tooltip.
// not-connected: the click is routed to /welcome/ by the surface callback (the buttons stay enabled).

import styles from "./AccountVoteControl.module.css";
import { IconDownvote } from "@/components/icons";
import { formatSignedWeight } from "@/lib/format";
import type { Viewer } from "@/components/kit";

/** The merged (base + optimistic) reputation view the control renders. */
export interface AccountVoteView {
  myVote: "Up" | "Down" | null;
  /** Net stake-weighted score (up_weight − down_weight); may be negative. */
  score: bigint;
  upCount: number;
  downCount: number;
}

export interface AccountVoteControlProps {
  vote: AccountVoteView;
  /** Gate state (not-connected → welcome via the callback; not-identity-bound → disabled tooltip). */
  gate: Viewer;
  /** The viewer's own profile — hide the arrows (can't vote yourself), keep the score visible. */
  isSelf: boolean;
  /** The target is a votable identity. False for a revoked/unbound account (the chain rejects the vote
   * `TargetNotAllowed`), so hide the arrows but keep the historical score visible. */
  votable?: boolean;
  pending?: boolean;
  onUp: () => void;
  onDown: () => void;
}

export function AccountVoteControl({
  vote,
  gate,
  isSelf,
  votable = true,
  pending,
  onUp,
  onDown,
}: AccountVoteControlProps) {
  const up = vote.myVote === "Up";
  const down = vote.myVote === "Down";
  const notBound = gate.status === "not-identity-bound";
  const score = formatSignedWeight(vote.score ?? 0n);
  // Show the arrows only when the viewer may act on a votable OTHER account; otherwise score-only.
  const showArrows = votable && !isSelf;

  return (
    <div className={styles.wrap} aria-label="Community reputation (stake-weighted)">
      <span className={styles.label}>Reputation</span>
      <div className={styles.voteGroup}>
        {showArrows && (
          <button
            type="button"
            className={`${styles.action} ${styles.up} ${up ? styles.upOn : ""}`}
            aria-label={`Endorse this account${vote.upCount ? `, ${vote.upCount} up` : ""}`}
            aria-pressed={up}
            disabled={notBound || pending}
            title={notBound ? "Finish setup to vote." : "Endorse (stake-weighted)"}
            onClick={onUp}
          >
            <span className={`${styles.iconWrap} ${up ? styles.pop : ""}`}>
              <IconDownvote
                style={{
                  width: "var(--cg-icon-sm)",
                  height: "var(--cg-icon-sm)",
                  transform: "rotate(180deg)",
                }}
              />
            </span>
          </button>
        )}
        <span
          className={`${styles.score} ${up ? styles.scoreUp : ""} ${down ? styles.scoreDown : ""}`}
          title="Net stake-weighted reputation score"
        >
          {score}
        </span>
        {showArrows && (
          <button
            type="button"
            className={`${styles.action} ${styles.down} ${down ? styles.downOn : ""}`}
            aria-label={`Dispute this account${vote.downCount ? `, ${vote.downCount} down` : ""}`}
            aria-pressed={down}
            disabled={notBound || pending}
            title={notBound ? "Finish setup to vote." : "Dispute (stake-weighted)"}
            onClick={onDown}
          >
            <span className={styles.iconWrap}>
              <IconDownvote
                style={{ width: "var(--cg-icon-sm)", height: "var(--cg-icon-sm)" }}
              />
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
