"use client";

// ResultTabStrip — the QUERY-mode result-scope tabs for /explore (surface 10 §2.1): People | Latest.
// Default Latest. The shared <Tabs> strip in its "sticky" variant, which carries the blurred header
// chrome + horizontal overflow this surface needs (see components/ui/Tabs.tsx). Presentational: the
// active tab lives in ExplorePage; this only renders + reports onChange. Hidden entirely in DEFAULT
// mode.

import { useMemo } from "react";
import { Tabs, type TabDef } from "@/components/ui/Tabs";

export type ResultTab = "people" | "latest";

export interface ResultTabStripProps {
  active: ResultTab;
  onChange: (tab: ResultTab) => void;
}

/** The tabpanel these tabs control. Imported by explore/page.tsx, which renders the panel. */
export const RESULT_PANEL_ID = "cg-explore-result-panel";

export function ResultTabStrip({ active, onChange }: ResultTabStripProps) {
  // X order: People then Latest; Latest is the default scope.
  const tabs = useMemo<TabDef<ResultTab>[]>(
    () => [
      { id: "people", label: "People" },
      { id: "latest", label: "Latest" },
    ],
    [],
  );

  return (
    <Tabs
      tabs={tabs}
      active={active}
      onChange={onChange}
      idPrefix="cg-explore-tab"
      panelId={RESULT_PANEL_ID}
      ariaLabel="Search results"
      variant="sticky"
    />
  );
}
