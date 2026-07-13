"use client";

// Loading — the ONE blocking-wait indicator. A centered spinner with a caption under it, in the middle
// of whatever surface is waiting.
//
// "Blocking" is the whole distinction: this is for a surface that has NOTHING else to show yet. It is
// deliberately NOT for:
//   • <Skeleton> — a skeleton is a shape PREDICTION, not a progress report. It mimics the rows that
//     will replace it precisely so the layout doesn't jump; centering one would reintroduce the jump it
//     exists to prevent. Feeds, threads, people lists and profiles keep their skeletons.
//   • an in-button spinner (the Post CTA, Follow, the wallet connect button) — that pending state
//     belongs to the control, and pulling it into a centered block would tear it out of the button.
//   • the sticky "Posting…" toast, the infinite-scroll tail spinner, the per-value placeholders in
//     Settings. Content is already on screen; those are ambient, not blocking.
//
// Before this, every blocking wait was hand-rolled in its own CSS module — nine of them, agreeing on
// nothing: different padding, different min-heights, some md and some sm, some captioned and some bare,
// one not centered at all, and four surfaces (including the whole app on a cold load) that showed a
// BLANK SCREEN. The `variant` is the only knob: it says how much room the wait owns.

import { Spinner } from "./icons";
import styles from "./Loading.module.css";

export interface LoadingProps {
  /**
   * What we are waiting for, in the user's words ("Loading notifications"). Shown under the spinner and
   * announced to a screen reader. Keep it a real answer to "what is happening?", never just "Loading".
   */
  label?: string;
  /**
   * How much room the wait owns — i.e. what "centered" is measured against:
   *   • "screen"  — the whole viewport (a cold load, a route-level Suspense gate).
   *   • "surface" — the routed column (Notifications' first read, /explore + /compose hydrating).
   *   • "panel"   — a bounded box: a modal body, a dropdown, a popover.
   *   • "fit"     — NO room of its own: the caller already centers it (the welcome shell's column).
   *                 Claiming a min-height there would push the caller's own content off-centre.
   */
  variant?: "screen" | "surface" | "panel" | "fit";
  /** Spinner only, no visible caption — for a panel too tight to carry one (the emoji picker). */
  quiet?: boolean;
}

export function Loading({ label = "Loading…", variant = "surface", quiet = false }: LoadingProps) {
  return (
    <div className={`${styles.root} ${styles[variant]}`} aria-busy="true">
      {/* Spinner owns the live region (role="status" + an sr-only label), so the visible caption below
          is a decorative duplicate — announcing it twice is worse than not announcing it at all. */}
      <Spinner size={variant === "panel" ? "sm" : "md"} label={label} />
      {!quiet && (
        <p className={styles.label} aria-hidden>
          {label}
        </p>
      )}
    </div>
  );
}
