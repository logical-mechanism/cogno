// lib/reputation — pure presentational logic for the community-reputation badge shown next to an
// author's name on a post header (a quick "good actor vs troll / shitpost" signal, so you don't have
// to open the profile to gauge who you're reading).
//
// The score is the account's NET stake-weighted reputation (`Microblog.AccountVoteTally`:
// up_weight − down_weight; may be negative) — the same anti-Sybil / anti-impersonation value the
// profile header and People rows already render via `formatSignedWeight`. This module owns only the
// display DECISION (show / hide, positive / negative tone); the read + cache live in the
// `useReputation` provider, and the number formatting in `formatSignedWeight`.

import { formatSignedWeight } from "./format";

export type ReputationTone = "up" | "down";

export interface ReputationBadgeView {
  /** Compacted, signed ADA magnitude, e.g. "+32M" / "−1.5K". */
  label: string;
  /** "down" when the net score is negative (community-disputed); "up" otherwise (endorsed). */
  tone: ReputationTone;
}

/**
 * Map a net stake-weighted reputation score to the badge view, or `null` when there is nothing to
 * show. Hidden for an unknown / still-loading score (`null` / `undefined`) AND for a neutral net-zero
 * score (`0`): the badge is a SIGNAL, and "no reputation votes yet" — the default for most accounts on
 * a fresh chain — would be pure noise on every row. Mirrors the People-row rule (shown only when
 * non-zero, red when net-negative).
 */
export function reputationBadge(score: bigint | null | undefined): ReputationBadgeView | null {
  if (score == null || score === 0n) return null;
  const label = formatSignedWeight(score);
  // A genuinely nonzero score below the 0.1-ADA display floor rounds to "+0"/"−0" (formatSignedWeight
  // divides lovelace→ADA before compacting). That reads as the exact zero-noise this badge suppresses,
  // so hide it too — the chip appears only once the magnitude is displayable.
  if (label === "+0" || label === "−0") return null;
  return { label, tone: score < 0n ? "down" : "up" };
}
