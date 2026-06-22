"use client";

// TimelineTabs — the Home "For you / Following" tab strip (doc 06 §4, doc 03 §22.1).
//
// A real `role="tablist"` with arrow-key navigation; the active tab carries the NEUTRAL underline
// indicator (the locked monochrome direction — the accent is the Post CTA + focus ring ONLY, never a
// coloured link/nav; doc 00). The Following tab is HIDDEN entirely when the active reader cannot serve
// follows (`showFollowing === false`, i.e. PAPI-direct `caps.follows === false`) — never a greyed /
// disabled tab (doc 06 §5.5). Presentational: client tab state lives in HomePage; this only renders +
// reports `onChange`.

import { useCallback, useMemo, useRef } from "react";
import styles from "./TimelineTabs.module.css";

export type TimelineTab = "for-you" | "following";

export interface TimelineTabsProps {
  /** The active tab (client state in HomePage). */
  active: TimelineTab;
  onChange: (tab: TimelineTab) => void;
  /** Render the Following tab. False on PAPI-direct (caps.follows === false) → For-you only. */
  showFollowing: boolean;
}

interface TabDef {
  id: TimelineTab;
  label: string;
}

export function TimelineTabs({ active, onChange, showFollowing }: TimelineTabsProps) {
  const tabs = useMemo<TabDef[]>(
    () =>
      showFollowing
        ? [
            { id: "for-you", label: "For you" },
            { id: "following", label: "Following" },
          ]
        : [{ id: "for-you", label: "For you" }],
    [showFollowing],
  );

  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Arrow-key roving across the tablist (WAI-ARIA tabs pattern).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const idx = tabs.findIndex((t) => t.id === active);
      if (idx < 0) return;
      let nextIdx = idx;
      if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
      else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
      else return;
      e.preventDefault();
      const next = tabs[nextIdx];
      onChange(next.id);
      refs.current[next.id]?.focus();
    },
    [tabs, active, onChange],
  );

  return (
    <div className={styles.tablist} role="tablist" aria-label="Timeline">
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
            id={`cg-tab-${t.id}`}
            aria-selected={selected}
            aria-controls="cg-timeline-panel"
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
