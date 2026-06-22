"use client";

// NewPostsPill — the Twitter-style "Show N posts" affordance (doc 06 §6.5).
//
// When the live watch() snapshot gains fresh top-of-feed items from OTHER accounts (the viewer's own
// optimistic post injects directly, NOT here), Home buffers them behind this pill rather than jumping
// the scroll. It renders sticky just under the tabs. Click → flush the buffer + scroll to top. It is a
// real <button> (aria-label "Show N new posts"), never a focus trap, and does not steal focus when it
// appears. The pill is a primary CTA, so it carries the accent fill (the one sanctioned accent use
// alongside the Post CTA + focus ring).

import styles from "./NewPostsPill.module.css";

export interface NewPostsPillProps {
  /** Number of buffered fresh items (other authors'). Hidden when 0. */
  count: number;
  /** Flush the buffer into the visible list + scroll to top. */
  onClick: () => void;
}

export function NewPostsPill({ count, onClick }: NewPostsPillProps) {
  if (count <= 0) return null;
  const label = `Show ${count} ${count === 1 ? "post" : "posts"}`;
  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.pill}
        onClick={onClick}
        aria-label={`Show ${count} new ${count === 1 ? "post" : "posts"}`}
      >
        {label}
      </button>
    </div>
  );
}
