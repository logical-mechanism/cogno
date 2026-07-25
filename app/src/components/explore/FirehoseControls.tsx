"use client";

// FirehoseControls — the DEFAULT-mode controls for /explore: the post ORDER and the verified-role LENS.
//
// Two independent axes, deliberately kept as separate rows rather than one multiplied strip:
//   - ORDER (Latest / Hot / Most replies / Highest stake score) — how the window is sorted.
//   - LENS  (Everyone / SPOs / dReps) — which authors are in it.
//
// `role="radiogroup"`, NOT the shared <Tabs> (`role="tablist"`): these pick an ORDERING and a FILTER of
// one panel, not which panel is shown. A tablist would tell a screen-reader user there are four panels.
//
// HONESTY IS THE POINT OF THE `disclosure` LINE, and it is not optional chrome. A ranked order sorts only
// the newest RANK_WINDOW posts — there is no score, reply or tally index in the runtime, so a
// corpus-wide ranking is not something this app can serve. The caption states the window; without it the
// control would be claiming an ordering of the whole chain, which is the reason /explore's earlier
// score-order toggle was removed rather than shipped. Same for the lens: it reports what it found in the
// window it scanned, and says so.
//
// HIDE, never disable — the standing rule for a control that can't be served (see TimelineTabs).

import { useId } from "react";
import { SORTS, type Sort } from "@/lib/feed/rank";
import type { RoleKindType } from "@/lib/chain/roles";
import styles from "./FirehoseControls.module.css";

/** The lenses offered. Committee is DELIBERATELY absent — the observer's CC liveness branch is unwired
 *  (every live preprod CC hot key is a script that cannot CIP-8-sign), so the lens would be permanently
 *  empty. Matches CLAIMABLE_ROLES. */
export const LENSES: readonly RoleKindType[] = ["Spo", "DRep"];

const SORT_LABEL: Record<Sort, string> = {
  latest: "Latest",
  hot: "Hot",
  replies: "Most replies",
  stake: "Highest stake score",
};

const LENS_LABEL: Record<RoleKindType, string> = {
  Spo: "SPOs",
  DRep: "dReps",
  Committee: "Committee",
};

export interface FirehoseControlsProps {
  sort: Sort;
  onSortChange: (sort: Sort) => void;
  lens: RoleKindType | null;
  onLensChange: (lens: RoleKindType | null) => void;
  /**
   * How many posts are in the window being ordered. Drives the disclosure copy — so the caption states a
   * real number rather than the ceiling we asked for.
   */
  windowSize: number;
  /**
   * True when every post in the window ties on the active order's key, so the ranking reproduces the
   * recency order. Say that, rather than presenting Latest under the word "Hot".
   */
  undifferentiated: boolean;
}

export function FirehoseControls({
  sort,
  onSortChange,
  lens,
  onLensChange,
  windowSize,
  undifferentiated,
}: FirehoseControlsProps) {
  const sortLabelId = useId();
  const lensLabelId = useId();
  const noteId = useId();

  const ranked = sort !== "latest";

  return (
    <div className={styles.bar}>
      <div className={styles.row} role="radiogroup" aria-labelledby={sortLabelId} aria-describedby={noteId}>
        <span className={styles.label} id={sortLabelId}>
          Order
        </span>
        {SORTS.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={s === sort}
            className={`${styles.chip} ${s === sort ? styles.chipActive : ""}`}
            onClick={() => onSortChange(s)}
          >
            {SORT_LABEL[s]}
          </button>
        ))}
      </div>

      <div className={styles.row} role="radiogroup" aria-labelledby={lensLabelId} aria-describedby={noteId}>
        <span className={styles.label} id={lensLabelId}>
          Show
        </span>
        <button
          type="button"
          role="radio"
          aria-checked={lens === null}
          className={`${styles.chip} ${lens === null ? styles.chipActive : ""}`}
          onClick={() => onLensChange(null)}
        >
          Everyone
        </button>
        {LENSES.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={lens === r}
            className={`${styles.chip} ${lens === r ? styles.chipActive : ""}`}
            onClick={() => onLensChange(r)}
          >
            {LENS_LABEL[r]}
          </button>
        ))}
      </div>

      {/* role="status" (its OWN region — not folded into the QUERY-mode result-count live region) so a
          screen-reader user never gets a bare "Hot" with no scope. */}
      <p className={styles.disclosure} id={noteId} role="status">
        {describe(sort, lens, windowSize, ranked, undifferentiated)}
      </p>
    </div>
  );
}

/**
 * The disclosure sentence. Every branch must be literally true of what was computed — this copy is the
 * feature's honesty guarantee, so treat a change here as a behaviour change.
 */
function describe(
  sort: Sort,
  lens: RoleKindType | null,
  windowSize: number,
  ranked: boolean,
  undifferentiated: boolean,
): string {
  const who =
    lens === null
      ? ""
      : ` by accounts whose ${lens === "Spo" ? "SPO" : "dRep"} badge is live right now`;

  if (!ranked) {
    return lens === null
      ? "Newest posts first."
      : `Newest posts first, from the posts${who} found while scanning recent posts.`;
  }

  const scope = `the newest ${windowSize} post${windowSize === 1 ? "" : "s"}${who}`;
  const basis =
    sort === "hot"
      ? "ranked by up and down votes, replies, and age"
      : sort === "replies"
        ? "ranked by number of direct replies"
        : "ranked by net stake-weighted score (up-votes minus down-votes)";

  // When nothing distinguishes the window, say so — the alternative is a ranking label over recency.
  if (undifferentiated) {
    return `Showing ${scope}. Nothing separates them on this measure yet, so they stay newest-first.`;
  }
  return `Showing ${scope}, ${basis}. Not a chain-wide ranking — there is no score index to page.`;
}
