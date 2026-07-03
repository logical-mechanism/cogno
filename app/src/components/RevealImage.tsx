"use client";

// RevealImage — click-to-reveal cover for any remote / IPFS image (image-reveal feature).
//
// The chain is text-only; an image URL in a post/bio (or a profile banner) points at an ARBITRARY
// host. To stop the browser auto-fetching from it, we render a neutral cover until the user taps —
// only THEN is the <img> mounted and the request made. The reveal is remembered per resolved src for
// the session (see lib/reveal). Like Avatar.tsx, the image is shown ONLY via a sandboxed <img> with
// referrerPolicy="no-referrer", never a CSS url().
//
// The caller's box sets the size/shape (post-media card, banner, …); RevealImage fills it.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { reveal, unreveal, useRevealed } from "@/lib/reveal";
import { IconEye, IconEyeOff } from "./icons";
import styles from "./RevealImage.module.css";

export interface RevealImageProps {
  /** Already-resolved http(s) src (run an ipfs:// link through resolveImageSrc first). */
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
   * Skip the click-to-reveal cover and load the image straight away — for a TRUSTED image (the
   * viewer's OWN banner on their own profile). The gate exists to not auto-fetch an ARBITRARY host's
   * image; your own image you chose is not that. No re-cover affordance when eager (nothing to restore).
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
  // A trusted (eager) image is always shown — no cover, and (below) no re-cover affordance.
  const shown = useRevealed(key) || eager;
  const [broken, setBroken] = useState(false);
  // A new src on the SAME instance (e.g. a banner edited to a valid URL after a prior load failure)
  // must retry — clear a stale broken state so a good image isn't masked by the fallback.
  useEffect(() => setBroken(false), [src]);

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
          reveal(key);
        }}
        aria-label={label}
        title={label}
      >
        <IconEye className={styles.coverIcon} aria-hidden />
        {!compact && <span className={styles.coverLabel}>{label}</span>}
      </button>
    );
  }

  if (broken) {
    return (
      <span className={[root, styles.broken].join(" ")} style={style} role="img" aria-label={alt}>
        {fallback ?? <span className={styles.brokenText}>Image unavailable</span>}
      </span>
    );
  }

  const img = (
    // Sandboxed <img>, never a CSS url(): src is arbitrary user input (same safety rule as Avatar).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={fit === "contain" ? styles.imgContain : styles.img}
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      draggable={false}
    />
  );

  // When href is set the image is a new-tab link; the hide button is a SIBLING of that link (never
  // nested inside the <a>, which would be invalid + un-clickable) so re-covering always works.
  const inner = href ? (
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

  return (
    <span className={root} style={style}>
      {inner}
      {/* Re-cover: undo an accidental / unwanted reveal, restoring the gate. Not for an eager
          (trusted) image — it has no cover to go back to. */}
      {!eager && (
        <button
          type="button"
          className={styles.hideBtn}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            unreveal(key);
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
