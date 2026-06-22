// lib/format — pure presentational formatters (no React, no network).
//
// Counts vocabulary (D12): compact count for the action row (1.2K etc.), and a signed bigint
// renderer for the weighted score / up-weight / down-weight that ONLY show on post-detail (the
// score may be NEGATIVE → render a leading sign). No time formatting lives here: CognoPost.at is a
// block height, NEVER rendered as a time (D11) — so there is deliberately no "relative time" helper.

/** Compact count for action-row pills: 0, 999, 1.2K, 34.5K, 1.2M. Twitter-style. */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${trim1(k)}K`;
  }
  const m = n / 1_000_000;
  return `${trim1(m)}M`;
}

function trim1(x: number): string {
  // one decimal, but drop a trailing ".0"
  const s = x.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * Render a weighted bigint (score / up-weight / down-weight) for post-DETAIL only. These are
 * lovelace-scale u128 differences and MAY be negative, so a leading sign is rendered for negatives.
 * Grouped with thin separators for readability.
 */
export function formatWeight(w: bigint | null | undefined): string {
  if (w == null) return "";
  const neg = w < 0n;
  const abs = neg ? -w : w;
  const grouped = groupDigits(abs.toString());
  return neg ? `-${grouped}` : grouped;
}

/**
 * Like formatWeight but always shows an explicit sign (+/-) — used for the standalone "score" chip on
 * detail where the direction is the point.
 */
export function formatSignedWeight(w: bigint | null | undefined): string {
  if (w == null) return "";
  if (w === 0n) return "0";
  const neg = w < 0n;
  const abs = neg ? -w : w;
  return `${neg ? "−" : "+"}${groupDigits(abs.toString())}`;
}

function groupDigits(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A poll option's share of the total weight as a rounded percent (D4: results are % BY WEIGHT). */
export function weightPercent(weight: bigint, totalWeight: bigint): number {
  if (totalWeight <= 0n) return 0;
  // bigint math then to number for the rounded display percent (0..100).
  const scaled = (weight * 10000n) / totalWeight; // basis points
  return Math.round(Number(scaled) / 100);
}
