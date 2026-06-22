"use client";

// ResultTabStrip — the QUERY-mode result-scope tabs for /explore (surface 10 §2.1): People | Latest.
// Default Latest. Same visual family + sticky-under-header treatment as TimelineTabs (neutral active
// underline, never a coloured accent). A real role="tablist" with Left/Right (+ Home/End) arrow nav;
// each tab carries role="tab" + aria-selected and points at the shared result tabpanel via
// aria-controls. Presentational: the active tab lives in ExplorePage; this only renders + reports
// onChange. Hidden entirely in DEFAULT mode (the page swaps in FirehoseOrderToggle instead).

import { useCallback, useMemo, useRef } from "react";
import styles from "./ResultTabStrip.module.css";

export type ResultTab = "people" | "latest";

export interface ResultTabStripProps {
  active: ResultTab;
  onChange: (tab: ResultTab) => void;
}

interface TabDef {
  id: ResultTab;
  label: string;
}

export const RESULT_PANEL_ID = "cg-explore-result-panel";

export function ResultTabStrip({ active, onChange }: ResultTabStripProps) {
  // X order: People then Latest; Latest is the default scope.
  const tabs = useMemo<TabDef[]>(
    () => [
      { id: "people", label: "People" },
      { id: "latest", label: "Latest" },
    ],
    [],
  );

  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const idx = tabs.findIndex((t) => t.id === active);
      if (idx < 0) return;
      let nextIdx = idx;
      if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
      else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") nextIdx = 0;
      else if (e.key === "End") nextIdx = tabs.length - 1;
      else return;
      e.preventDefault();
      const next = tabs[nextIdx];
      onChange(next.id);
      refs.current[next.id]?.focus();
    },
    [tabs, active, onChange],
  );

  return (
    <div className={styles.tablist} role="tablist" aria-label="Search results">
      {tabs.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`cg-explore-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={RESULT_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            className={`${styles.tab} ${selected ? styles.active : ""}`}
            onClick={() => onChange(t.id)}
            onKeyDown={onKeyDown}
          >
            <span className={styles.label}>{t.label}</span>
            {selected && <span className={styles.indicator} aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
