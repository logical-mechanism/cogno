"use client";

// FilterDisclosure — the compact shell a filter surface wears, shared by /governance and /explore.
//
// It renders three things, in this order and always in this order:
//   1. a SUMMARY row that is always visible: the trigger, the axes actually narrowing the list (as
//      removable chips), and a clear-all once more than one is applied;
//   2. the axis controls, mounted ONLY while the panel is open;
//   3. the surface's note, rendered in EVERY state.
//
// Why the axes stack collapses at all: /governance stacked four labelled chip rows plus a select plus a
// note, and at 375px the three widest wrap to two lines each. Measured against the built export that is
// 340px of chrome before the first poll on a 812px-tall viewport, 424px once a signed-in viewer adds the
// "For you" row, against 105px for Home. The filters were bigger than the thing they filter.
//
// THE PANEL UNMOUNTS WHEN CLOSED. It is not clipped, not `height: 0`, not `visibility: hidden` with the
// buttons left in the tree. RadioRow's `select()` calls .focus() on the node it just selected, so chips
// that are invisible-but-focusable are a keyboard trap (Tab lands on nothing the reader can see), and
// chips that still receive keydown but cannot take focus are worse (selection moves while .focus()
// no-ops, focus falls to <body>, and the next arrow key does nothing). Unmounting has neither failure.
//
// THE `note` SLOT IS NOT PART OF THE COLLAPSE, and that is load-bearing twice over. It is the
// aria-describedby target of every radio in the panel, and an IDREF resolving to nothing yields no
// description at all — silently, on five radiogroups at once, where no gate here can see it (vitest runs
// in a `node` environment and renders nothing). It is also the honesty copy on both surfaces: closing the
// panel does not un-apply the ordering, because the axes live in the URL, so "Sorting the 20 most recent
// posts…" and "Most discussed counts direct replies…" have to stay on screen with the list they describe.
// Hiding it to save space is the one saving this component may not make.
//
// CARRIES NO SURFACE CHROME. /governance hands this to StickyHeader, which already supplies the
// translucent background, the blur and the bottom rule; /explore wraps it in its own `.bar`. Painting a
// background here would draw a doubled rule on the first and nest a backdrop-filter inside a
// backdrop-filter on the second.

import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { IconChevronDown, IconClose, IconFilter } from "@/components/icons";
import styles from "./FilterDisclosure.module.css";

/** One axis that is away from its default, as shown on the summary row. */
export interface ActiveFilter {
  /** The applied value's own plain-language label, e.g. "Closing soon". Not the axis name. */
  label: string;
  /** Reset this one axis to its default. */
  onClear: () => void;
}

export interface FilterDisclosureProps {
  /**
   * Accessible name for the panel, e.g. "Governance filters". Names the region the trigger opens; the
   * trigger's own name is built from the fixed word "Filters" so the accessible name always contains
   * the visible one.
   */
  label: string;
  /**
   * The axes currently away from their default. Derive this from the axes themselves, never from which
   * control rows happen to be rendered: a shared link has to explain its own shortened list, and the
   * rows are not all present for every viewer.
   */
  active: readonly ActiveFilter[];
  /** Reset every axis at once. Offered once more than one is applied. */
  onClearAll: () => void;
  /** The axis controls. Mounted only while the panel is open. */
  children: ReactNode;
  /** The surface's note. Rendered in every state, open or closed. See the header comment. */
  note: ReactNode;
}

export function FilterDisclosure({
  label,
  active,
  onClearAll,
  children,
  note,
}: FilterDisclosureProps) {
  // Component state, deliberately not the URL. /explore's `buildExploreUrl` rebuilds the query from
  // scratch on every write, and a write is any keystroke of the 300ms search debounce — a panel flag
  // parked there would be erased, so the panel would snap shut mid-typing. It is not a per-account
  // preference either: an axis preference is explicitly not persisted here, and the open state is UI.
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const n = active.length;

  // Escape closes and returns focus to the trigger. Without the second half, collapsing from a chip
  // inside the panel unmounts the focused element and drops focus to <body>, which strands a keyboard
  // reader at the top of the document. RadioRow handles arrows and lets everything else bubble here.
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setOpen((wasOpen) => {
      if (wasOpen) triggerRef.current?.focus();
      return false;
    });
  }, []);

  return (
    <div className={styles.root} onKeyDown={onKeyDown}>
      <div className={styles.summary}>
        <button
          ref={triggerRef}
          type="button"
          className={styles.trigger}
          aria-expanded={open}
          // Set ONLY while the panel is in the tree: aria-controls pointing at an id that is not in the
          // DOM is invalid and gets dropped.
          aria-controls={open ? panelId : undefined}
          // Omitted at zero so the visible text is the accessible name. When it is set it still opens
          // with "Filters", which is what keeps the accessible name a superset of the visible label.
          aria-label={n > 0 ? `Filters, ${n} applied` : undefined}
          data-active={n > 0 || undefined}
          onClick={() => setOpen((v) => !v)}
        >
          <IconFilter size="var(--cg-icon-sm)" />
          <span>Filters</span>
          {n > 0 && <span className={styles.count}>{n}</span>}
          <IconChevronDown
            className={styles.caret}
            size="var(--cg-icon-sm)"
            data-open={open || undefined}
          />
        </button>

        {/* The applied axes, on the row itself. Someone arriving on /governance/?t=closed&c=drep sees a
            short list; without these it reads as "the chain has nothing" rather than "you are looking
            through a filter". They are removable so an applied axis is always one tap from cleared —
            the standing rule is that a control which is currently applied stays reachable. */}
        {active.map((f) => (
          <button
            key={f.label}
            type="button"
            className={styles.applied}
            aria-label={`Remove filter ${f.label}`}
            onClick={f.onClear}
          >
            <span>{f.label}</span>
            <IconClose size="var(--cg-icon-sm)" />
          </button>
        ))}

        {n > 1 && (
          <button type="button" className={styles.clearAll} onClick={onClearAll}>
            Clear all
          </button>
        )}
      </div>

      {open && (
        <div className={styles.panel} id={panelId} role="group" aria-label={label}>
          {children}
        </div>
      )}

      {note}
    </div>
  );
}

export default FilterDisclosure;
