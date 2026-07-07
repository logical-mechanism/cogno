"use client";

// RevealImage — click-to-reveal cover for any remote / IPFS image (image-reveal feature, image arm).
//
// The gate logic (cover / broken / hide / session memory) lives in RevealGate; this component just wires
// an <img> (optionally a new-tab link) into it. Like Avatar.tsx, the image is shown ONLY via a sandboxed
// <img> with referrerPolicy="no-referrer", never a CSS url() — src is arbitrary user input. The <img> is
// mounted only inside the gate's revealed branch, so the fetch never happens before the reveal tap.
//
// The caller's box sets the size/shape (post-media card, banner, …); RevealImage fills it. Public props
// are unchanged from before the RevealGate extraction, so the profile-banner + avatar callers are stable.

import { RevealGate } from "./RevealGate";
import styles from "./RevealImage.module.css";
import type { CSSProperties, ReactNode } from "react";

export interface RevealImageProps {
  /** Already-resolved http(s) src (run an ipfs:// link through resolveMediaSrc first). */
  src: string;
  alt: string;
  /** Reveal-memory key; defaults to `src` so the same image stays revealed everywhere this session. */
  revealKey?: string;
  /** object-fit of the revealed image (default "cover"). */
  fit?: "cover" | "contain";
  /** Cover button label (a11y + visible unless `compact`). */
  label?: string;
  /** Re-cover ("hide") button label — the affordance to undo a reveal (a11y + tooltip). */
  hideLabel?: string;
  /** Icon-only cover (no visible label) — for tight boxes. */
  compact?: boolean;
  /**
   * Skip the click-to-reveal cover and load the image straight away — for a TRUSTED image (the viewer's
   * OWN banner on their own profile). The gate exists to not auto-fetch an ARBITRARY host's image; your
   * own image you chose is not that. No re-cover affordance when eager.
   */
  eager?: boolean;
  /** Rendered if the image fails to load. Defaults to a small "unavailable" note. */
  fallback?: ReactNode;
  /** When set + revealed, the image is a new-tab link to the source (so it stays inspectable). */
  href?: string;
  /** Extra class on the root box. */
  className?: string;
  style?: CSSProperties;
}

export function RevealImage({
  src,
  alt,
  revealKey,
  fit = "cover",
  label = "Show image",
  hideLabel = "Hide image",
  compact = false,
  eager = false,
  fallback,
  href,
  className,
  style,
}: RevealImageProps) {
  const key = revealKey ?? src;
  return (
    <RevealGate
      revealKey={key}
      label={label}
      hideLabel={hideLabel}
      compact={compact}
      eager={eager}
      fallback={fallback}
      brokenAlt={alt}
      resetKey={src}
      className={className}
      style={style}
    >
      {(onError) => {
        // Sandboxed <img>, never a CSS url(): src is arbitrary user input (same safety rule as Avatar).
        const img = (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={fit === "contain" ? styles.imgContain : styles.img}
            src={src}
            alt={alt}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={onError}
            draggable={false}
          />
        );
        // When href is set the image is a new-tab link (kept inspectable). The hide button stays a
        // SIBLING of the link (RevealGate renders it), never nested inside the <a>.
        return href ? (
          <a
            className={styles.link}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={(e) => e.stopPropagation()}
            title={alt}
          >
            {img}
          </a>
        ) : (
          img
        );
      }}
    </RevealGate>
  );
}
