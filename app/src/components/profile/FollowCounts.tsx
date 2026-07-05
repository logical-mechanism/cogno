"use client";

// FollowCounts — the X-exact "N Following · M Followers" inline figures (doc 07 §4.5).
//
// Two modes. Without the onOpen* handlers the figures are non-interactive <span>s (the original
// display-only shape). WITH them, each figure becomes a <button> that opens the Following / Followers
// list (the FollowsPanel sub-view); the profile surface wires them and owns the ?follows= sync. Counts
// come from the node's denormalised follower/following counters; on PAPI-direct (caps.follows === false)
// the SURFACE omits this component entirely (renders nothing) — never "0 Followers". Numbers are plain
// JS `number` (node Int), grouped with Intl.NumberFormat.

import styles from "./FollowCounts.module.css";

const GROUP = new Intl.NumberFormat("en-US");

export interface FollowCountsProps {
  following: number;
  followers: number;
  /** Open the Following list. When omitted the figure is a static <span> (display-only). */
  onOpenFollowing?: () => void;
  /** Open the Followers list. When omitted the figure is a static <span> (display-only). */
  onOpenFollowers?: () => void;
}

export function FollowCounts({
  following,
  followers,
  onOpenFollowing,
  onOpenFollowers,
}: FollowCountsProps) {
  return (
    <div className={styles.counts}>
      <Count value={following} label="Following" onOpen={onOpenFollowing} />
      <span className={styles.dot} aria-hidden>
        ·
      </span>
      <Count value={followers} label="Followers" onOpen={onOpenFollowers} />
    </div>
  );
}

function Count({ value, label, onOpen }: { value: number; label: string; onOpen?: () => void }) {
  const ariaLabel = `${GROUP.format(value)} ${label}`;
  const inner = (
    <>
      <strong className={styles.value}>{GROUP.format(value)}</strong>{" "}
      <span className={styles.label}>{label}</span>
    </>
  );

  if (onOpen) {
    return (
      <button
        type="button"
        className={`${styles.count} ${styles.tappable}`}
        onClick={onOpen}
        aria-label={`${ariaLabel}, view list`}
      >
        {inner}
      </button>
    );
  }

  return (
    <span className={styles.count} aria-label={ariaLabel}>
      {inner}
    </span>
  );
}
