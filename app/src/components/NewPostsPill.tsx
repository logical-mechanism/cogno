"use client";

// NewPostsPill — the Twitter-style "Show N posts" affordance.
//
// When the live watch() snapshot gains fresh top-of-feed items from OTHER accounts (the viewer's own
// optimistic post injects directly, NOT here), Home buffers them behind this pill rather than jumping
// the scroll. It renders sticky just under the tabs. Click → flush the buffer + scroll to top. It is a
// real <button> (aria-label "Show N posts"), never a focus trap, and does not steal focus when it
// appears. The pill is a primary CTA, so it carries the accent fill (the one sanctioned accent use
// alongside the Post CTA + focus ring).

import styles from "./NewPostsPill.module.css";

export interface NewPostsPillProps {
  /** Number of buffered fresh items (other authors'). Hidden when 0. */
  count: number;
  /** Flush the buffer into the visible list + scroll to top. */
  onClick: () => void;
  /** Singular noun for the label (default "post"). */
  noun?: string;
  /** Plural noun for the label (default "posts") — spelled out so irregulars like "replies" read right. */
  nounPlural?: string;
  /** "sticky" floats under the Home tabs (default); "inline" sits in normal flow (e.g. a thread). */
  variant?: "sticky" | "inline";
}

export function NewPostsPill({
  count,
  onClick,
  noun = "post",
  nounPlural = "posts",
  variant = "sticky",
}: NewPostsPillProps) {
  if (count <= 0) return null;
  const word = count === 1 ? noun : nounPlural;
  const label = `Show ${count} ${word}`;
  return (
    <div className={variant === "inline" ? styles.wrapInline : styles.wrap}>
      <button
        type="button"
        className={styles.pill}
        onClick={onClick}
        aria-label={label}
      >
        {label}
      </button>
    </div>
  );
}
