"use client";

// HonestyBadge — a quiet bordered mono badge stating a trust limit plainly.
// Not alarming, not hidden. The label is the on-screen claim; `detail` is the
// accessible / hover explanation of exactly what the limit is.

import styles from "./HonestyBadge.module.css";

export interface HonestyBadgeProps {
  /** Short mono label, e.g. "chain: operator-run (v1)". */
  label: string;
  /** Plain-language trust-limit detail for tooltip + screen readers. */
  detail?: string;
}

export function HonestyBadge({ label, detail }: HonestyBadgeProps) {
  return (
    <span
      className={styles.badge}
      title={detail ?? label}
      aria-label={detail ? `${label} — ${detail}` : label}
    >
      <span className={styles.dot} aria-hidden="true" />
      {label}
    </span>
  );
}

export default HonestyBadge;
