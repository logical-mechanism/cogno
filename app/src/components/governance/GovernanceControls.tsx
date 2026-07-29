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
  type GovAxes,
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
}

export function GovernanceControls({ axes, onChange, shown, total }: GovernanceControlsProps) {
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
      <RadioRow
        label="Type"
        options={ACTION_OPTIONS}
        value={axes.action === null ? "" : GOV_ACTION_SLUG[axes.action]}
        onChange={(slug) =>
          onChange({
            ...axes,
            action:
              slug === ""
                ? null
                : ((Object.keys(GOV_ACTION_LABEL) as GovActionType[]).find(
                    (t) => GOV_ACTION_SLUG[t] === slug,
                  ) ?? null),
          })
        }
        describedById={noteId}
      />
      <RadioRow
        label="Decided by"
        options={CHAMBER_OPTIONS}
        value={axes.chamber}
        onChange={(chamber) => onChange({ ...axes, chamber })}
        describedById={noteId}
      />
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
      <p className={styles.note} id={noteId}>
        {shown === total
          ? `${total} ${total === 1 ? "poll" : "polls"}.`
          : `${shown} of ${total} polls.`}{" "}
        Most discussed counts direct replies to the opening post.
      </p>
    </div>
  );
}

export default GovernanceControls;
