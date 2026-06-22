"use client";

// RateLimitNotice — the ONE capacity reality we surface (doc 03 §17, D5). Twitter-style, NO battery,
// NO capacity numbers/jargon. Raised when a feeless extrinsic is rejected at the pool by CheckCapacity
// (or pre-emptively when a capacity hint says it won't fit). Slim inline banner sitting inside the
// Composer (variant 'inline'); the 'toast' variant defers to the rate-limit Toast (same copy) so the
// message is consistent everywhere.

import styles from "./RateLimitNotice.module.css";
import { RATE_LIMIT_COPY } from "./toast/ToasterProvider";
import type { RateLimitVariant } from "./kit";

export interface RateLimitNoticeProps {
  variant?: RateLimitVariant;
  /** Optional soft countdown ("…again in ~Ns") when cheaply known; never exposes capacity units. */
  retryInSeconds?: number | null;
  onRetry?: () => void;
}

function copy(retryInSeconds?: number | null): string {
  if (retryInSeconds != null && retryInSeconds > 0) {
    const n = Math.ceil(retryInSeconds);
    return `You're over the rate limit. You can post again in ~${n}s.`;
  }
  return RATE_LIMIT_COPY;
}

export function RateLimitNotice({ variant = "inline", retryInSeconds, onRetry }: RateLimitNoticeProps) {
  // The 'toast' variant is surfaced by the mutation layer via the Toaster; this component renders the
  // inline banner. (Kept as one component so the copy is identical in both paths.)
  if (variant === "toast") return null;

  return (
    <div className={styles.notice} role="status">
      <span className={styles.glyph} aria-hidden>⏳</span>
      <span className={styles.text}>{copy(retryInSeconds)}</span>
      {onRetry && (
        <button type="button" className={styles.retry} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
