"use client";

// RevealVideo — click-to-reveal cover for a remote / IPFS video (image-reveal feature, video arm).
//
// Same never-auto-fetch posture as RevealImage: the <video> is NOT mounted (no network request) until
// the user taps the cover. HARD rules (see the workflow security notes):
//   - No poster, no <source> child, preload="metadata" (never "auto"), src set directly — so the FIRST
//     fetch coincides with the reveal tap.
//   - NO `eager` prop: a remote clip can never auto-fetch without an explicit reveal (eager stays
//     image-only, for the trusted own-banner case).
//   - No <a> wrap (an <a> hijacks the native controls); stopPropagation sits on the element so a
//     control/scrub tap doesn't bubble to an enclosing clickable PostCard row and navigate away.
//   - `alt` maps to aria-label (`alt` is invalid on <video>) so revealed media has an accessible name.
// The <video>'s Referer leak (it can't carry a per-element referrerPolicy) is closed app-wide by the
// page-level `referrer: "no-referrer"` policy in app/layout.tsx.

import { RevealGate } from "./RevealGate";
import { IconPlay } from "./icons";
import styles from "./RevealVideo.module.css";
import type { CSSProperties, ReactNode } from "react";

export interface RevealVideoProps {
  /** Already-resolved http(s) src (run an ipfs:// link through resolveMediaSrc first). */
  src: string;
  /** Accessible name (mapped to aria-label — `alt` is invalid on <video>). */
  alt: string;
  /** Reveal-memory key; defaults to `src` so the same clip stays revealed everywhere this session. */
  revealKey?: string;
  label?: string;
  hideLabel?: string;
  compact?: boolean;
  fallback?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function RevealVideo({
  src,
  alt,
  revealKey,
  label = "Show video",
  hideLabel = "Hide video",
  compact = false,
  fallback,
  className,
  style,
}: RevealVideoProps) {
  const key = revealKey ?? src;
  return (
    <RevealGate
      revealKey={key}
      label={label}
      hideLabel={hideLabel}
      compact={compact}
      coverIcon={<IconPlay size="var(--cg-icon-md)" />}
      fallback={fallback}
      brokenAlt={alt}
      resetKey={src}
      className={className}
      style={style}
    >
      {(onError) => (
        // No poster / no <source> / preload="metadata" — the first fetch coincides with this mount
        // (the reveal tap). No <a> wrap: it would hijack the native controls; stopPropagation on the
        // element keeps a control/scrub tap from triggering an enclosing clickable row.
        <video
          className={styles.video}
          src={src}
          controls
          preload="metadata"
          playsInline
          aria-label={alt}
          onError={onError}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}
    </RevealGate>
  );
}
