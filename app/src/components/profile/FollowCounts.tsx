"use client";

// FollowCounts — the X-exact "N Following · M Followers" inline figures (doc 07 §4.5).
//
// Display-only: the Lists surface is out of scope, so the counts are NON-interactive <span>s (no
// /u/<a>/followers route). They come from the indexer-denormalized Author counts; on PAPI-direct
// (caps.follows === false) the SURFACE omits this component entirely (renders nothing) — never "0
// Followers". Numbers are plain JS `number` (indexer Int), grouped with Intl.NumberFormat.

import styles from "./FollowCounts.module.css";

const GROUP = new Intl.NumberFormat("en-US");

export interface FollowCountsProps {
  following: number;
  followers: number;
}

export function FollowCounts({ following, followers }: FollowCountsProps) {
  return (
    <div className={styles.counts}>
      <span className={styles.count} aria-label={`${GROUP.format(following)} Following`}>
        <strong className={styles.value}>{GROUP.format(following)}</strong>{" "}
        <span className={styles.label}>Following</span>
      </span>
      <span className={styles.dot} aria-hidden>
        ·
      </span>
      <span className={styles.count} aria-label={`${GROUP.format(followers)} Followers`}>
        <strong className={styles.value}>{GROUP.format(followers)}</strong>{" "}
        <span className={styles.label}>Followers</span>
      </span>
    </div>
  );
}
