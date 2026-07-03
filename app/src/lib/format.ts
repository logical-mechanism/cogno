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

/** Suffixes for compact magnitude notation, each ×1000 (ADA stakes get large). */
const WEIGHT_UNITS = ["", "K", "M", "B", "T", "P"] as const;
const LOVELACE_PER_ADA = 1_000_000n;

/**
 * Compact a NON-NEGATIVE lovelace amount to a 1-decimal ADA magnitude: lovelace is divided to ADA
 * FIRST (÷1e6), then reduced — so 32_000_000 lovelace (= 32 ADA) → "32", and 32e12 lovelace
 * (= 32M ADA) → "32M". Stake weights are lovelace-scale u128, so the math stays in bigint. Drops a
 * trailing ".0". Sub-0.1-ADA amounts round to "0".
 */
function compactAda(lovelace: bigint): string {
  let unit = 0;
  let divisor = LOVELACE_PER_ADA; // lovelace per one displayed unit (starts at 1 ADA)
  while (unit < WEIGHT_UNITS.length - 1 && lovelace / (divisor * 1000n) > 0n) {
    divisor *= 1000n;
    unit += 1;
  }
  const tenths = (lovelace * 10n) / divisor; // value in the chosen unit, scaled ×10 for one decimal
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  const mantissa = frac === 0n ? whole.toString() : `${whole}.${frac}`;
  return `${mantissa}${WEIGHT_UNITS[unit]}`;
}

/**
 * Render a weighted bigint (score / up-weight / down-weight). These are lovelace-scale u128
 * differences and MAY be negative, so a leading sign is rendered for negatives. Shown in ADA,
 * compacted (32M, 1.5K) so a large stake stays readable.
 */
export function formatWeight(w: bigint | null | undefined): string {
  if (w == null) return "";
  const neg = w < 0n;
  const abs = neg ? -w : w;
  return neg ? `-${compactAda(abs)}` : compactAda(abs);
}

/**
 * Like formatWeight but always shows an explicit sign (+/-) — used for the standalone "score" chip
 * where the direction is the point. Shown in ADA, compacted (e.g. +32M, −1.5K).
 */
export function formatSignedWeight(w: bigint | null | undefined): string {
  if (w == null) return "";
  if (w === 0n) return "0";
  const neg = w < 0n;
  const abs = neg ? -w : w;
  return `${neg ? "−" : "+"}${compactAda(abs)}`;
}

/**
 * lovelace → "N.N ADA" with a thousands-separated whole part and one decimal place; "—" for 0/null.
 * Used by the Settings vault / voting-power displays (shared so the two never drift).
 */
export function formatAda(lovelace: bigint | null): string {
  if (lovelace == null || lovelace === 0n) return "—";
  const whole = lovelace / 1_000_000n;
  const frac = (lovelace % 1_000_000n) / 100_000n; // one decimal place
  return `${whole.toLocaleString()}.${frac} ADA`;
}

/** A poll option's share of the total weight as a rounded percent (D4: results are % BY WEIGHT). */
export function weightPercent(weight: bigint, totalWeight: bigint): number {
  if (totalWeight <= 0n) return 0;
  // bigint math then to number for the rounded display percent (0..100).
  const scaled = (weight * 10000n) / totalWeight; // basis points
  return Math.round(Number(scaled) / 100);
}
