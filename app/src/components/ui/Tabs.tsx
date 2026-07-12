"use client";

// Tabs — the one horizontal tab strip.
//
// There were five, and TimelineTabs.module.css and ProfileTabs.module.css were byte-identical apart from
// their leading comment. The TSX had already diverged where it mattered: two strips handled Home/End and
// three did not, so the keyboard contract for the same widget depended on which page you were on. This
// takes the SUPERSET (see tabKeys.ts).
//
// `idPrefix` and `panelId` are REQUIRED and are not decoration. Every strip uses a different DOM id
// prefix, and four of them are referenced from a tabpanel in ANOTHER FILE via aria-labelledby (the
// profile's panel points at `cg-ptab-*`, Explore's at `cg-explore-tab-*`, and so on). Merging them onto
// one hardcoded prefix silently breaks the accessible name of four panels — and nothing in CI would
// catch it, because there are no DOM tests. Making both ids mandatory parameters means a caller cannot
// forget.
//
// Not merged: SettingsShell's tablist. It shares role="tablist" and nothing else — vertical orientation,
// ArrowUp/Down, container-level keydown, DOM-query focus, conditional aria-controls, no underline
// indicator, and a 290px sticky master/detail pane with drill-down breakpoints. Leave it alone.

import { useCallback, useRef, type ReactNode } from "react";
import styles from "./Tabs.module.css";
import { nextTabIndex } from "./tabKeys";

export interface TabDef<Id extends string> {
  id: Id;
  /**
   * A ReactNode, not a string — FollowsPanel renders a nested count span inside its label. The strip
   * wraps whatever it is given in `.label`, which is a baseline-aligned flex row: for a bare text label
   * that is indistinguishable from centred, and for a label-plus-count it is the alignment that was
   * hand-written in FollowsPanel's own module.
   */
  label: ReactNode;
}

export interface TabsProps<Id extends string> {
  tabs: TabDef<Id>[];
  active: Id;
  onChange: (id: Id) => void;
  /** DOM id prefix for each tab: `${idPrefix}-${tab.id}`. Referenced by the panel's aria-labelledby. */
  idPrefix: string;
  /** DOM id of the tabpanel this strip controls (aria-controls). */
  panelId: string;
  /** Accessible name for the tablist itself. */
  ariaLabel: string;
  /** "sticky" adds the blurred, scrollable header chrome the Explore results strip needs. */
  variant?: "plain" | "sticky";
}

export function Tabs<Id extends string>({
  tabs,
  active,
  onChange,
  idPrefix,
  panelId,
  ariaLabel,
  variant = "plain",
}: TabsProps<Id>) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const idx = tabs.findIndex((t) => t.id === active);
      const nextIdx = nextTabIndex(e.key, idx, tabs.length);
      if (nextIdx === null) return; // not ours — let Tab/Enter/typing through
      e.preventDefault();
      const next = tabs[nextIdx];
      onChange(next.id);
      refs.current[next.id]?.focus();
    },
    [tabs, active, onChange],
  );

  return (
    <div
      className={`${styles.tablist} ${variant === "sticky" ? styles.sticky : ""}`}
      role="tablist"
      aria-label={ariaLabel}
    >
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
            id={`${idPrefix}-${t.id}`}
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            // `data-active` exists so a CALLER can still style inside its own label. FollowsPanel wrote
            // `.tab.active .count`, a cross-class descendant selector — once `.tab`/`.active` live in
            // THIS module, CSS Modules hashes them into a different scope and that rule becomes
            // unwritable. An attribute selector is not hashed, so FollowsPanel writes `[data-active]
            // .count` against its own `.count` and keeps working.
            data-active={selected || undefined}
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
