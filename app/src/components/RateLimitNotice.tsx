"use client";

// RateLimitNotice — the ONE capacity reality we surface (D5). Twitter-style, NO battery.
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

/**
 * Round a wait to a unit a person reads at a glance.
 *
 * This used to be a bare `~${n}s`, which was fine while the capacity constants were dev-tuned: a
 * floor-lock account regained a post in one block, so the number was always a handful of seconds.
 * Spec 212 retuned the refill to a real ~5 hour window, and the same wait is now up to ~276 seconds
 * for a full-length post. "Try again in ~276s" makes the reader do the division.
 */
export function formatRetry(seconds: number): string {
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}s`;
  const minutes = Math.ceil(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil((minutes / 60) * 10) / 10;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

function copy(retryInSeconds?: number | null): string {
  if (retryInSeconds != null && retryInSeconds > 0) {
    // "in about", not "again in about": a first-touch account has never posted, and this line is the
    // one it sees while its bucket charges from zero. See errorCopy's rate-limit arm.
    return `Your posting power is still charging. You can post in about ${formatRetry(retryInSeconds)}.`;
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
