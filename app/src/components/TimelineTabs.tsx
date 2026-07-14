"use client";

// TimelineTabs — the Home "For you / Following" tab strip.
//
// Composes the tab LIST (which is surface-specific — Following disappears when the reader can't serve
// follows) and hands it to the shared <Tabs> strip. The strip itself — markup, keyboard, indicator — was
// duplicated five times; see components/ui/Tabs.tsx.
//
// The active tab carries the NEUTRAL underline indicator (the locked monochrome direction — the accent
// is the Post CTA + focus ring ONLY, never a coloured link/nav). The Following tab is HIDDEN
// entirely when it can't be served, never greyed or disabled. Presentational: client tab
// state lives in HomePage; this only renders + reports `onChange`.

import { useMemo } from "react";
import { Tabs, type TabDef } from "./ui/Tabs";

export type TimelineTab = "for-you" | "following";

export interface TimelineTabsProps {
  /** The active tab (client state in HomePage). */
  active: TimelineTab;
  onChange: (tab: TimelineTab) => void;
  /** Render the Following tab. False when the reader cannot serve follows → For-you only. */
  showFollowing: boolean;
}

export function TimelineTabs({ active, onChange, showFollowing }: TimelineTabsProps) {
  const tabs = useMemo<TabDef<TimelineTab>[]>(
    () =>
      showFollowing
        ? [
            { id: "for-you", label: "For you" },
            { id: "following", label: "Following" },
          ]
        : [{ id: "for-you", label: "For you" }],
    [showFollowing],
  );

  return (
    <Tabs
      tabs={tabs}
      active={active}
      onChange={onChange}
      idPrefix="cg-tab"
      panelId="cg-timeline-panel"
      ariaLabel="Timeline"
    />
  );
}
