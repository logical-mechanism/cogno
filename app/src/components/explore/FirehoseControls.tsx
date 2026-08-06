"use client";

// FirehoseControls — the DEFAULT-mode controls for /explore: the post ORDER and the verified-role LENS.
//
// Two independent axes, deliberately kept as separate rows rather than one multiplied strip:
//   - ORDER (Latest / Hot / Most replies / Top by stake) — how the window is sorted.
//   - LENS  (Everyone / SPOs / dReps) — which authors are in it.
//
// `role="radiogroup"`, NOT the shared <Tabs> (`role="tablist"`): these pick an ORDERING and a FILTER of
// one panel, not which panel is shown. A tablist would tell a screen-reader user there are four panels.
// A radiogroup carries a real keyboard contract, so `RadioRow` implements it: ONE tab stop per row
// (roving tabindex) with ←/→/↑/↓ moving AND selecting, plus Home/End. Without that the bar would be seven
// separate tab stops and arrow keys would do nothing.
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
import { RadioRow } from "@/components/ui/RadioRow";
import type { RadioOption } from "@/components/ui/RadioRow";

/** The lenses offered. Committee is DELIBERATELY absent. The observer's CC branch is wired now, but every
 *  live preprod CC hot key is a script that cannot CIP-8-sign, so nobody there can hold the badge and the
 *  lens would be permanently empty. Matches CLAIMABLE_ROLES; both flip together when a key-based member
 *  is seated. */
export const LENSES: readonly RoleKindType[] = ["Spo", "DRep"];

const SORT_LABEL: Record<Sort, string> = {
  latest: "Latest",
  hot: "Hot",
  replies: "Most replies",
  stake: "Top by stake",
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
  const noteId = useId();
  const ranked = sort !== "latest";

  const sortOptions = SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] }));
  const lensOptions: RadioOption<RoleKindType | null>[] = [
    { value: null, label: "Everyone" },
    ...LENSES.map((r) => ({ value: r as RoleKindType | null, label: LENS_LABEL[r] })),
  ];

  return (
    <div className={styles.bar}>
      <RadioRow label="Order" options={sortOptions} value={sort} onChange={onSortChange} describedById={noteId} />
      <RadioRow label="Show" options={lensOptions} value={lens} onChange={onLensChange} describedById={noteId} />

      {/* A plain paragraph, NOT a role="status" live region. It is the aria-describedby target of every
          radio, so it is already announced when an option takes focus; making it a live region too would
          announce the same sentence twice on every change. */}
      <p className={styles.disclosure} id={noteId}>
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
  const badge = lens === "Spo" ? "SPO" : "dRep";
  const from = lens === null ? "" : ` from accounts with a verified ${badge} badge`;

  if (!ranked) {
    return lens === null
      ? "Newest posts first."
      : `Newest first${from}. Only recent posts were checked.`;
  }

  const count = `the ${windowSize} most recent post${windowSize === 1 ? "" : "s"}${from}`;
  const basis =
    sort === "hot"
      ? "votes, replies and how recent they are"
      : sort === "replies"
        ? "how many replies they have"
        : "stake-weighted votes, up-votes minus down-votes";

  // When nothing distinguishes the window, say so. The alternative is a ranking label over recency.
  //
  // The zero case is reachable and needs its own sentence: the controls have no size gate (removing one
  // fixed three worse bugs), and `isUndifferentiated` is true below two posts, so a deep-linked `?s=hot`
  // or a lens that found nobody would otherwise read "Sorting the 0 most recent posts. They are all
  // tied...". The tied sentence states the OUTCOME rather than claiming they tie on `basis`, which would
  // be false for `hot`: its key is engagement alone, so equal engagement still orders by age.
  if (undifferentiated) {
    if (windowSize === 0) return `No posts${from} in the stretch that was checked.`;
    return `Sorting ${count} by ${basis}. For now that gives the same order as newest first.`;
  }
  return `Sorting ${count} by ${basis}. Older posts are not included, so this is not a ranking of the whole chain.`;
}
