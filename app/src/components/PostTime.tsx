"use client";

// PostTime — a relative "· 2h" age for a post, derived from its block height (CognoPost.at) and the
// live best block: age ≈ (best − at) × 6s (runtime MILLI_SECS_PER_BLOCK = 6000). There is no on-chain
// wall-clock, so this is approximate and relative-only (no absolute date). Reads the shared session
// bestBlock (one subscription for the whole app), so it's cheap to render per card.

import styles from "./PostTime.module.css";
import { useSession } from "./Providers";

const SECS_PER_BLOCK = 6;

function formatAgo(seconds: number): string {
  if (seconds < 45) return "now";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

export function PostTime({ at }: { at: number }) {
  const { bestBlock } = useSession();
  if (!at || bestBlock == null) return null; // optimistic (at=0) / heads not yet known → render nothing
  const label = formatAgo(Math.max(0, bestBlock - at) * SECS_PER_BLOCK);
  return (
    <span className={styles.time} title={`~${label} ago · block #${at}`}>
      <span className={styles.dot} aria-hidden>
        ·
      </span>
      {label}
    </span>
  );
}

export default PostTime;
