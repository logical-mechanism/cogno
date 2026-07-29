"use client";

// GovernanceControls — the filter + order axes for /governance, as chip radiogroups.
//
// Lives in StickyHeader's `tabs` slot, so it carries NO chrome of its own: StickyHeader already sets the
// translucent background, the blur and the bottom rule. /explore's FirehoseControls does carry that
// chrome, because /explore builds its own sticky header instead of using StickyHeader. Copying the .bar
// recipe here would stack two translucent layers and nest a backdrop-filter inside a backdrop-filter.

import { useId } from "react";
import { RadioRow } from "@/components/ui/RadioRow";
import type { RadioOption } from "@/components/ui/RadioRow";
import { GOV_ACTION_LABEL } from "@/lib/cardano/governance";
import type { GovActionType } from "@/lib/types";
import {
  GOV_ACTION_SLUG,
  parseGovAction,
  type GovAxes,
  type GovLens,
  type GovChamber,
  type GovSort,
  type GovStatus,
} from "@/lib/governanceFilters";
import styles from "./GovernanceControls.module.css";

const STATUS_OPTIONS: RadioOption<GovStatus>[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "final", label: "Final" },
];

// "Actions dReps vote on", never "dRep polls". The axis filters by which body DECIDES an action under
// CIP-1694; it says nothing about who voted in the cogno poll, and the shorter phrasing would be an
// affirmatively false claim about a tally.
const CHAMBER_OPTIONS: RadioOption<GovChamber>[] = [
  { value: "all", label: "Any chamber" },
  { value: "spo", label: "SPOs vote on" },
  { value: "drep", label: "dReps vote on" },
];

// Only rendered for a viewer whose roles are known. Signed out, "you can vote" has no referent, and a
// chip that always resolves to the whole list is worse than an absent one.
const LENS_OPTIONS: RadioOption<GovLens>[] = [
  { value: "all", label: "Anyone" },
  { value: "eligible", label: "You can vote" },
  { value: "unvoted", label: "You have not voted" },
];

const SORT_OPTIONS: RadioOption<GovSort>[] = [
  { value: "latest", label: "Newest" },
  { value: "closing", label: "Closing soon" },
  { value: "discussed", label: "Most discussed" },
];

const ACTION_OPTIONS: RadioOption<string>[] = [
  { value: "", label: "Any type" },
  ...(Object.keys(GOV_ACTION_LABEL) as GovActionType[]).map((t) => ({
    value: GOV_ACTION_SLUG[t],
    label: GOV_ACTION_LABEL[t],
  })),
];

export interface GovernanceControlsProps {
  axes: GovAxes;
  onChange: (next: GovAxes) => void;
  /** How many polls survive the filters, and how many were read. Renders the scope disclosure. */
  shown: number;
  total: number;
  /**
   * False while the read is in flight, held for the chain head, or failed. `shown`/`total` are then not
   * facts about the list, and the disclosure omits the count rather than asserting one.
   */
  counted: boolean;
  /** Whether the viewer's roles are known. Gates the personal lens row. */
  hasViewer: boolean;
}

export function GovernanceControls({
  axes,
  onChange,
  shown,
  total,
  counted,
  hasViewer,
}: GovernanceControlsProps) {
  const noteId = useId();

  return (
    <div className={styles.controls}>
      <RadioRow
        label="Show"
        options={STATUS_OPTIONS}
        value={axes.status}
        onChange={(status) => onChange({ ...axes, status })}
        describedById={noteId}
      />
      {/* The ONE axis that is not a chip row, and it cannot be. Eight options whose labels run to 25
          characters ("Protocol-parameter change") measure 1257px of chips against the 568px the feed
          column leaves: 2.2x over at the widest layout the app has, and 3.7x on a phone. As a row it
          overflowed and, with the scrollbar hidden on both engines, simply looked cut off, so most of
          the eight types were unreachable without knowing to drag sideways.

          A select shows its current value, opens to the full list, and costs one line at every
          viewport. The same labels already render in a select in PollComposer, so this is the shape
          they are known to work in. */}
      <div className={styles.selectRow}>
        <label className={styles.selectLabel} htmlFor="cg-gov-type">
          Type
        </label>
        <select
          id="cg-gov-type"
          className={styles.select}
          value={axes.action === null ? "" : GOV_ACTION_SLUG[axes.action]}
          aria-describedby={noteId}
          // Parity with the chip rows beside it, which fill the selected chip with the accent. Without
          // it this axis would be the only one giving no at-a-glance cue that it is narrowing the list.
          data-active={axes.action !== null || undefined}
          // Through the shared parser, not a second slug→type lookup. `parseGovAction` already owns
          // that map and answers null for both "" and an unknown slug, which is the same "every type"
          // this axis means.
          onChange={(e) => onChange({ ...axes, action: parseGovAction(e.target.value) })}
        >
          {ACTION_OPTIONS.map((a) => (
            <option key={a.value || "any"} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <RadioRow
        label="Decided by"
        options={CHAMBER_OPTIONS}
        value={axes.chamber}
        onChange={(chamber) => onChange({ ...axes, chamber })}
        describedById={noteId}
      />
      {hasViewer && (
        <RadioRow
          label="For you"
          options={LENS_OPTIONS}
          value={axes.lens}
          onChange={(lens) => onChange({ ...axes, lens })}
          describedById={noteId}
        />
      )}
      <RadioRow
        label="Order"
        options={SORT_OPTIONS}
        value={axes.sort}
        onChange={(sort) => onChange({ ...axes, sort })}
        describedById={noteId}
      />
      {/* The disclosure is not decoration: "Most discussed" counts direct replies to the opening post,
          not the size of the whole thread, and the list is a bounded scan. Saying so is what keeps the
          order's claim true. Always rendered alongside the controls, never hidden to save space. */}
      {/* The COUNT is gated, the paragraph is not. This is the aria-describedby target of every row
          above, so hiding the whole thing while the read lands would silently strip the description off
          five radiogroups. And the count is a claim: the page holds the list at [] until the chain head
          is known (a shared ?t=closed link would otherwise resolve every poll to "open" and paint a
          false empty), so rendering "0 of 21 polls." from the first paint made in words exactly the
          assertion the hold exists to avoid. */}
      <p className={styles.note} id={noteId}>
        {counted && (
          <>
            {shown === total
              ? `${total} ${total === 1 ? "poll" : "polls"}.`
              : `${shown} of ${total} polls.`}{" "}
          </>
        )}
        Most discussed counts direct replies to the opening post.
      </p>
    </div>
  );
}

export default GovernanceControls;
