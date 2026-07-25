"use client";

// FirehoseControls — the DEFAULT-mode controls for /explore: the post ORDER and the verified-role LENS.
//
// Two independent axes, deliberately kept as separate rows rather than one multiplied strip:
//   - ORDER (Latest / Hot / Most replies / Highest stake score) — how the window is sorted.
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

import { useCallback, useId, useRef } from "react";
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

/** One option in a {@link RadioRow}. */
interface RadioOption<T> {
  value: T;
  label: string;
}

/**
 * An ARIA radiogroup over a row of chips: one tab stop, arrows move + select, Home/End jump.
 *
 * `describedById` points every radio at the shared disclosure so focusing an option announces the scope
 * it applies — a bare "Hot" with no window would be the misleading case.
 */
function RadioRow<T extends string | null>({
  label,
  options,
  value,
  onChange,
  describedById,
}: {
  label: string;
  options: readonly RadioOption<T>[];
  value: T;
  onChange: (next: T) => void;
  describedById: string;
}) {
  const labelId = useId();
  const rowRef = useRef<HTMLDivElement | null>(null);

  // Move selection by `delta` (wrapping) and put DOM focus on the newly selected radio, which is what
  // makes a roving-tabindex group navigable: the old radio leaves the tab order as the new one enters it.
  const move = useCallback(
    (delta: number) => {
      const i = options.findIndex((o) => o.value === value);
      const next = options[(((i < 0 ? 0 : i) + delta + options.length) % options.length)!];
      onChange(next.value);
      const btns = rowRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
      btns?.[options.indexOf(next)]?.focus();
    },
    [options, value, onChange],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault();
          move(1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          break;
        case "Home":
          e.preventDefault();
          move(-options.findIndex((o) => o.value === value));
          break;
        case "End":
          e.preventDefault();
          move(options.length - 1 - options.findIndex((o) => o.value === value));
          break;
      }
    },
    [move, options, value],
  );

  return (
    <div
      ref={rowRef}
      className={styles.row}
      role="radiogroup"
      aria-labelledby={labelId}
      onKeyDown={onKeyDown}
    >
      <span className={styles.label} id={labelId}>
        {label}
      </span>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value ?? "__none__"}
            type="button"
            role="radio"
            aria-checked={active}
            aria-describedby={describedById}
            // Roving tabindex: only the selected radio is reachable by Tab; arrows move within the group.
            tabIndex={active ? 0 : -1}
            className={`${styles.chip} ${active ? styles.chipActive : ""}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

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
  const who =
    lens === null ? "" : ` by accounts whose ${lens === "Spo" ? "SPO" : "dRep"} badge is live right now`;

  if (!ranked) {
    return lens === null
      ? "Newest posts first."
      : `Newest first, showing only posts${who} that turned up in the recent posts we scanned.`;
  }

  const scope = `the newest ${windowSize} post${windowSize === 1 ? "" : "s"}${who} we scanned`;
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
