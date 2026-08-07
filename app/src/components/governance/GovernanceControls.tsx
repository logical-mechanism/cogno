"use client";

// GovernanceControls — the filter + order axes for /governance, as chip radiogroups behind a disclosure.
//
// Lives in StickyHeader's `tabs` slot, so it carries NO chrome of its own: StickyHeader already sets the
// translucent background, the blur and the bottom rule. /explore's FirehoseControls does carry that
// chrome, because /explore builds its own sticky header instead of using StickyHeader. Copying the .bar
// recipe here would stack two translucent layers and nest a backdrop-filter inside a backdrop-filter.
//
// The axes sit inside a FilterDisclosure rather than stacked open. Four labelled chip rows plus the type
// select plus the note measured 340px of chrome at 375px against an 812px viewport, and the three widest
// rows wrap to two lines there — so before a signed-in viewer's "For you" row it was already 42% of the
// screen, and 52% with it. The note stays OUTSIDE the collapse; see FilterDisclosure for why that is
// two separate non-negotiables rather than a style choice.

import { useId } from "react";
import { FilterDisclosure, type ActiveFilter } from "@/components/ui/FilterDisclosure";
import { RadioRow } from "@/components/ui/RadioRow";
import type { RadioOption } from "@/components/ui/RadioRow";
import { GOV_ACTION_LABEL } from "@/lib/cardano/governance";
import type { GovActionType } from "@/lib/types";
import {
  GOV_ACTION_SLUG,
  GOV_DEFAULT_AXES,
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

/** The label an option carries, for the summary row. Falls back to the raw value if an axis ever grows a
 *  value with no option, which is a bug rather than a display state, so it must not render blank. */
function labelOf<T>(options: readonly RadioOption<T>[], value: T): string {
  return options.find((o) => o.value === value)?.label ?? String(value);
}

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

  // Derived from the AXES against their defaults, never from which rows happen to be rendered: the "For
  // you" row is absent for a signed-out viewer, so reading the summary off the rendered controls would
  // under-report a shared link's filters.
  const active: ActiveFilter[] = [];
  if (axes.status !== GOV_DEFAULT_AXES.status) {
    active.push({
      label: labelOf(STATUS_OPTIONS, axes.status),
      onClear: () => onChange({ ...axes, status: GOV_DEFAULT_AXES.status }),
    });
  }
  if (axes.action !== null) {
    active.push({
      label: GOV_ACTION_LABEL[axes.action],
      onClear: () => onChange({ ...axes, action: null }),
    });
  }
  if (axes.chamber !== GOV_DEFAULT_AXES.chamber) {
    active.push({
      label: labelOf(CHAMBER_OPTIONS, axes.chamber),
      onClear: () => onChange({ ...axes, chamber: GOV_DEFAULT_AXES.chamber }),
    });
  }
  // Gated on `hasViewer` because the lens FAILS OPEN when roles are unknown: filterGovPolls skips it
  // entirely for a signed-out reader, so a chip here would claim a narrowing that is not being applied.
  if (hasViewer && axes.lens !== GOV_DEFAULT_AXES.lens) {
    active.push({
      label: labelOf(LENS_OPTIONS, axes.lens),
      onClear: () => onChange({ ...axes, lens: GOV_DEFAULT_AXES.lens }),
    });
  }
  if (axes.sort !== GOV_DEFAULT_AXES.sort) {
    active.push({
      label: labelOf(SORT_OPTIONS, axes.sort),
      onClear: () => onChange({ ...axes, sort: GOV_DEFAULT_AXES.sort }),
    });
  }

  return (
    <FilterDisclosure
      label="Governance filters"
      active={active}
      // Through the exported defaults, so clearing cannot drift from what the default axes actually are.
      onClearAll={() => onChange({ ...GOV_DEFAULT_AXES })}
      note={
        // The disclosure is not decoration: "Most discussed" counts direct replies to the opening post,
        // not the size of the whole thread, and the list is a bounded scan. Saying so is what keeps the
        // order's claim true. Rendered in every state, open or closed, never hidden to save space.
        //
        // The COUNT is gated, the paragraph is not. This is the aria-describedby target of every row
        // below, so hiding the whole thing while the read lands would silently strip the description off
        // five radiogroups. And the count is a claim: the page holds the list at [] until the chain head
        // is known (a shared ?t=closed link would otherwise resolve every poll to "open" and paint a
        // false empty), so rendering "0 of 21 polls." from the first paint made in words exactly the
        // assertion the hold exists to avoid.
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
      }
    >
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
    </FilterDisclosure>
  );
}

export default GovernanceControls;
