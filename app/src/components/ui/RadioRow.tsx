"use client";

// RadioRow — an ARIA radiogroup rendered as a row of chips: one tab stop, arrows move + select,
// Home/End jump to the ends.
//
// Lifted verbatim out of components/explore/FirehoseControls.tsx when /governance grew its own filter
// axes. The extraction is deliberately mechanical: the roving tabindex, the Arrow/Home/End handling and
// the aria-describedby wiring are /explore's keyboard contract, and re-implementing them per surface is
// how two rows of chips end up behaving differently.

import { useCallback, useId, useRef } from "react";
import styles from "./RadioRow.module.css";

/** One option in a {@link RadioRow}. */
export interface RadioOption<T> {
  value: T;
  label: string;
}

/**
 * An ARIA radiogroup over a row of chips: one tab stop, arrows move + select, Home/End jump.
 *
 * `describedById` points every radio at the shared disclosure so focusing an option announces the scope
 * it applies — a bare "Hot" with no window would be the misleading case.
 */
export function RadioRow<T extends string | null>({
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

  // Select the option AT an index and put DOM focus on it, which is what makes a roving-tabindex group
  // navigable: the old radio leaves the tab order as the new one enters it.
  const select = useCallback(
    (index: number) => {
      const next = options[index]!;
      onChange(next.value);
      rowRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus();
    },
    [options, onChange],
  );

  // Move selection by `delta` from the current option, wrapping. `findIndex` is -1 when `value` is not
  // one of the options, which the clamp reads as "start from the first" — a relative move has to start
  // somewhere.
  const move = useCallback(
    (delta: number) => {
      const i = options.findIndex((o) => o.value === value);
      select((((i < 0 ? 0 : i) + delta) % options.length + options.length) % options.length);
    },
    [options, value, select],
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
        // ABSOLUTE, not a delta off the current index. Expressed as a delta they were wrong for a value
        // that is not in `options`: `findIndex` returns -1, so Home became `move(1)` and landed on the
        // SECOND chip while End became `move(length)` and landed on the first. Nothing today passes such
        // a value (both call sites parse through an allowlist built from the same constants as the
        // options), but this is a shared primitive and the delta form only reads as correct.
        case "Home":
          e.preventDefault();
          select(0);
          break;
        case "End":
          e.preventDefault();
          select(options.length - 1);
          break;
      }
    },
    [move, select, options.length],
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
