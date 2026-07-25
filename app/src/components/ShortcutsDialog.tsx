"use client";

// ShortcutsDialog — the "?" keyboard-shortcuts sheet.
//
// Every shortcut below already worked; only this list is new. They were documented in a source comment
// (Timeline's header calls them "the documented compose/flush keys"), which is documentation for whoever
// edits Timeline, not for whoever uses the app.
//
// THE GROUPING IS THE HONESTY, and it is not cosmetic. These keys are NOT uniformly available, because
// they are wired per surface rather than globally:
//   - j k o Enter l r come from `Timeline`'s own onKeyDown, so they work on any surface that renders a
//     Timeline (Home, Explore, a profile, Bookmarks, Lists) — but NOT in a thread, which renders bare
//     PostCards instead of a Timeline.
//   - n calls Timeline's `onCompose`, which only Home and a profile pass.
//   - . calls `onFlush`, which ONLY Home passes.
//   - / is genuinely app-wide (useSearchHotkey, mounted in AppShell).
// A flat list would tell a reader that `.` works on Explore. It does not. If the wiring is ever made
// uniform, collapse the groups then — not before.
//
// Deliberately NOT a `ModalKind`: the modal router feeds an exhaustive TITLES record and pushes a URL per
// kind, so routing a help sheet through it would put a compose URL in the address bar. Local state,
// mounted once in AppShell.

import { useCallback, useEffect, useRef } from "react";
import styles from "./ShortcutsDialog.module.css";

interface Shortcut {
  keys: string[];
  label: string;
}

interface Group {
  heading: string;
  items: Shortcut[];
}

const GROUPS: Group[] = [
  {
    heading: "Anywhere",
    items: [
      { keys: ["/"], label: "Search" },
      { keys: ["?"], label: "Show this list" },
    ],
  },
  {
    heading: "In a timeline (Home, Explore, a profile, Bookmarks, Lists)",
    items: [
      { keys: ["j"], label: "Next post" },
      { keys: ["k"], label: "Previous post" },
      { keys: ["Enter"], label: "Open the focused post" },
      { keys: ["o"], label: "Open the focused post" },
      { keys: ["l"], label: "Up-vote the focused post" },
      { keys: ["r"], label: "Reply to the focused post" },
    ],
  },
  {
    heading: "On Home and your profile",
    items: [{ keys: ["n"], label: "Start a new post" }],
  },
  {
    heading: "On Home",
    items: [{ keys: ["."], label: "Load the posts waiting above" }],
  },
  {
    heading: "While writing",
    items: [{ keys: ["⌘", "Enter"], label: "Post (Ctrl+Enter on Windows and Linux)" }],
  },
];

export interface ShortcutsDialogProps {
  onClose: () => void;
}

export function ShortcutsDialog({ onClose }: ShortcutsDialogProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Esc closes; Tab is trapped inside the card. Same contract as ConfirmDialog — a Tab off the last
  // control would otherwise wrap to the top of the document and land on the page behind the scrim,
  // defeating `aria-modal`.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const focusables = cardRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose],
  );

  return (
    <div
      className={styles.scrim}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cg-shortcuts-title"
        onKeyDown={onKeyDown}
      >
        <div className={styles.head}>
          <h2 className={styles.title} id="cg-shortcuts-title">
            Keyboard shortcuts
          </h2>
        </div>

        {GROUPS.map((g) => (
          <section className={styles.group} key={g.heading}>
            <h3 className={styles.groupHead}>{g.heading}</h3>
            <ul className={styles.rows}>
              {g.items.map((s) => (
                <li className={styles.row} key={`${g.heading}-${s.keys.join("+")}-${s.label}`}>
                  <span>{s.label}</span>
                  <span className={styles.keys}>
                    {s.keys.map((k) => (
                      <kbd className={styles.key} key={k}>
                        {k}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <button ref={closeRef} type="button" className={styles.close} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
