"use client";

// FirehoseOrderToggle — the DEFAULT-mode order toggle for /explore (surface 10 §5.1). A labeled
// segmented `radiogroup` (NOT a tablist — it's a SORT over the firehose, not a content scope):
//   • Top         → order:"score"   (the default explore ordering; SCORE_DESC)
//   • Most recent → order:"recency" (ID_DESC)
// "Top" is DISABLED on PAPI-direct (no score order without the indexer) — only "Most recent" stays.
// Monochrome per the locked direction: the selected pill is the neutral text-on-subtle treatment, no
// coloured accent. Arrow keys move the selection (standard radiogroup pattern).

import { useCallback, useMemo, useRef } from "react";
import styles from "./FirehoseOrderToggle.module.css";

export type FirehoseOrder = "score" | "recency";

export interface FirehoseOrderToggleProps {
  value: FirehoseOrder;
  onChange: (order: FirehoseOrder) => void;
  /** false on PAPI-direct → "Top" (score) is disabled; only "Most recent" remains selectable. */
  scoreEnabled: boolean;
}

interface OptDef {
  id: FirehoseOrder;
  label: string;
  disabled: boolean;
}

export function FirehoseOrderToggle({ value, onChange, scoreEnabled }: FirehoseOrderToggleProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const options = useMemo<OptDef[]>(
    () => [
      { id: "score", label: "Top", disabled: !scoreEnabled },
      { id: "recency", label: "Most recent", disabled: false },
    ],
    [scoreEnabled],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const selectable = options.filter((o) => !o.disabled);
      if (selectable.length < 2) return;
      const idx = selectable.findIndex((o) => o.id === value);
      const safeIdx = idx < 0 ? 0 : idx;
      const nextIdx =
        e.key === "ArrowRight"
          ? (safeIdx + 1) % selectable.length
          : (safeIdx - 1 + selectable.length) % selectable.length;
      const next = selectable[nextIdx];
      onChange(next.id);
      refs.current[next.id]?.focus();
    },
    [options, value, onChange],
  );

  return (
    <div className={styles.row}>
      <span className={styles.scopeLabel}>Latest</span>
      <div className={styles.group} role="radiogroup" aria-label="Sort posts">
        {options.map((o) => {
          const selected = o.id === value;
          return (
            <button
              key={o.id}
              ref={(el) => {
                refs.current[o.id] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={o.label}
              tabIndex={selected ? 0 : -1}
              disabled={o.disabled}
              className={`${styles.opt} ${selected ? styles.selected : ""}`}
              onClick={() => !o.disabled && onChange(o.id)}
              onKeyDown={onKeyDown}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
