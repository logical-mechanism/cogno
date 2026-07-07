"use client";

// RevealGate — the shared click-to-reveal cover primitive (image-reveal feature).
//
// The chain is text-only; a media URL in a post/bio (or a profile banner) points at an ARBITRARY host.
// To stop the browser auto-fetching from it, we render a neutral cover until the user taps — only THEN
// are the `children` (the <img>/<video>/<audio>) mounted and the request made. The reveal is remembered
// per resolved key for the session (see lib/reveal).
//
// This is the SINGLE enforcement point of the never-auto-fetch invariant, shared by RevealImage /
// RevealVideo / RevealAudio: the `children` render-prop is invoked ONLY in the revealed branch, so no
// media element (and no src/preload/poster attribute) ever reaches the DOM before the tap. Any future
// caller inherits that guarantee for free — and a caller that mounts a network-triggering element
// OUTSIDE this gate silently breaks it (there is no CSP backstop under output:'export').
//
// The caller's box sets the size/shape (post-media card, banner, …); RevealGate fills it.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { reveal, unreveal, useRevealed } from "@/lib/reveal";
import { IconEye, IconEyeOff } from "./icons";
import styles from "./RevealGate.module.css";

export interface RevealGateProps {
  /** Reveal-memory key — pass the RESOLVED src so the same asset stays revealed everywhere this session. */
  revealKey: string;
  /** Cover button label (a11y + visible unless `compact`). */
  label: string;
  /** Re-cover ("hide") button label — the affordance to undo a reveal (a11y + tooltip). */
  hideLabel?: string;
  /** Icon-only cover (no visible label) — for tight boxes. */
  compact?: boolean;
  /**
   * Skip the click-to-reveal cover and mount the children straight away — for TRUSTED content (the
   * viewer's OWN banner on their own profile). Only the image path sets this; remote video/audio never
   * do, so a remote clip can never auto-fetch without a reveal. No re-cover affordance when eager.
   */
  eager?: boolean;
  /** Cover glyph (default: eye). Video/audio pass a play / speaker icon. Sized by the gate. */
  coverIcon?: ReactNode;
  /** Rendered when the children signal a load error (via the `onError` handed to them). */
  fallback?: ReactNode;
  /** ARIA role for the broken-media placeholder. Images pass "img"; video/audio omit it (so the
   *  fallback isn't announced as an image) and let the visible fallback text be read. */
  brokenRole?: string;
  /** Accessible label announced for the broken-media state (only used when `brokenRole` is set). */
  brokenAlt?: string;
  /** Clear a stale broken state when this changes (usually the src) so a good asset isn't masked. */
  resetKey?: string;
  /** Extra class on the root box. */
  className?: string;
  style?: CSSProperties;
  /**
   * The media element(s). Receives an `onError` to wire into the broken-media fallback. Invoked ONLY
   * once revealed — the never-auto-fetch guarantee rests on this not running before the tap.
   */
  children: (onError: () => void) => ReactNode;
}

export function RevealGate({
  revealKey,
  label,
  hideLabel = "Hide",
  compact = false,
  eager = false,
  coverIcon,
  fallback,
  brokenRole,
  brokenAlt,
  resetKey,
  className,
  style,
  children,
}: RevealGateProps) {
  // A trusted (eager) asset is always shown — no cover, and (below) no re-cover affordance.
  const shown = useRevealed(revealKey) || eager;
  const [broken, setBroken] = useState(false);
  // A new resetKey (e.g. a banner edited to a valid URL after a prior load failure) must retry — clear
  // a stale broken state so a good asset isn't masked by the fallback.
  useEffect(() => setBroken(false), [resetKey]);

  const root = [styles.root, className].filter(Boolean).join(" ");

  if (!shown) {
    return (
      <button
        type="button"
        className={[root, styles.cover].join(" ")}
        style={style}
        // Don't let the reveal tap also trigger an enclosing clickable row/card.
        onClick={(e) => {
          e.stopPropagation();
          reveal(revealKey);
        }}
        aria-label={label}
        title={label}
      >
        <span className={styles.coverIcon} aria-hidden>
          {coverIcon ?? <IconEye size="var(--cg-icon-md)" />}
        </span>
        {!compact && <span className={styles.coverLabel}>{label}</span>}
      </button>
    );
  }

  if (broken) {
    return (
      <span
        className={[root, styles.broken].join(" ")}
        style={style}
        role={brokenRole}
        // aria-label overrides the child text, so only apply it when a role is set (images). Without a
        // role (video/audio) the visible "Media unavailable" text is what assistive tech reads.
        aria-label={brokenRole ? brokenAlt : undefined}
      >
        {fallback ?? <span className={styles.brokenText}>Media unavailable</span>}
      </span>
    );
  }

  return (
    <span className={root} style={style}>
      {children(() => setBroken(true))}
      {/* Re-cover: undo an accidental / unwanted reveal, restoring the gate. Not for an eager
          (trusted) asset — it has no cover to go back to. */}
      {!eager && (
        <button
          type="button"
          className={styles.hideBtn}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            unreveal(revealKey);
          }}
          aria-label={hideLabel}
          title={hideLabel}
        >
          <IconEyeOff className={styles.hideIcon} aria-hidden />
        </button>
      )}
    </span>
  );
}
