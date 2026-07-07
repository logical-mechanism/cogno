"use client";

// RevealAudio — click-to-reveal cover for a remote / IPFS audio clip (image-reveal feature, audio arm).
//
// Same posture as RevealVideo: the <audio> is mounted only inside the gate's revealed branch (no fetch
// before the reveal tap), preload="metadata" (never "auto"), no <source> child, src set directly. NO
// `eager` path (a remote clip can never auto-fetch without a reveal). No <a> wrap — stopPropagation on
// the element keeps a control/scrub tap from bubbling to an enclosing clickable PostCard row. `alt` maps
// to aria-label (`alt` is invalid on <audio>). Rendered in a short bar (see PostBody .mediaAudio), not a
// 16/9 card. The Referer leak is closed app-wide by the page-level policy in app/layout.tsx.

import { RevealGate } from "./RevealGate";
import { IconSpeaker } from "./icons";
import styles from "./RevealAudio.module.css";
import type { CSSProperties, ReactNode } from "react";

export interface RevealAudioProps {
  /** Already-resolved http(s) src (run an ipfs:// link through resolveMediaSrc first). */
  src: string;
  /** Accessible name (mapped to aria-label — `alt` is invalid on <audio>). */
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

export function RevealAudio({
  src,
  alt,
  revealKey,
  label = "Show audio",
  hideLabel = "Hide audio",
  compact = false,
  fallback,
  className,
  style,
}: RevealAudioProps) {
  const key = revealKey ?? src;
  return (
    <RevealGate
      revealKey={key}
      label={label}
      hideLabel={hideLabel}
      compact={compact}
      coverIcon={<IconSpeaker />}
      fallback={fallback}
      brokenAlt={alt}
      resetKey={src}
      className={className}
      style={style}
    >
      {(onError) => (
        <audio
          className={styles.audio}
          src={src}
          controls
          preload="metadata"
          aria-label={alt}
          onError={onError}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}
    </RevealGate>
  );
}
