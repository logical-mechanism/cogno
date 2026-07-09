// lib/stake — pure presentational logic for the stake-tier avatar ring (no React, no network).
//
// The ring is a quiet trust signal: it color-codes an author by their Cardano-sourced talk WEIGHT
// (`TalkStake.VotingPower`, lovelace — the account's total proven stake, which VARIES; NOT the flat
// 100-ADA `AllowedStake` posting deposit). More stake ⇒ a more prominent monochrome ring; a negative
// community-reputation score (`Microblog.AccountVoteTally` net, up − down) overrides everything with a
// RED ring — the same anti-Sybil / anti-impersonation signal `ReputationBadge` already surfaces, but
// carried on the avatar so it scales to every surface an author appears on.
//
// This module owns only the display DECISION (tier + danger). The reads + caches live in the
// `useAuthorWeight` / `useReputation` providers; `useStakeRing` composes them into this.

import { reputationBadge } from "./reputation";

const LOVELACE_PER_ADA = 1_000_000n;
/** Tier-2 floor: ≥ 10K ADA of proven stake. */
const TIER2_LOVELACE = 10_000n * LOVELACE_PER_ADA;
/** Tier-3 floor: ≥ 100K ADA of proven stake. */
const TIER3_LOVELACE = 100_000n * LOVELACE_PER_ADA;

/** 0 = no ring; 1/2/3 = rising monochrome prominence by stake magnitude. */
export type StakeTier = 0 | 1 | 2 | 3;

export interface AvatarRingView {
  /** Monochrome prominence tier from the stake weight. */
  tier: StakeTier;
  /** Net reputation is negative (community-disputed) → the ring renders RED, overriding the tier. */
  danger: boolean;
}

/**
 * Map a stake weight (lovelace) to a ring tier. `null`/`0n`/negative ⇒ tier 0 (no ring). Thresholds
 * are compared in bigint (weights are u128, lovelace-scale, may exceed 2^53).
 */
export function stakeTier(weight: bigint | null | undefined): StakeTier {
  if (weight == null || weight <= 0n) return 0;
  if (weight >= TIER3_LOVELACE) return 3;
  if (weight >= TIER2_LOVELACE) return 2;
  return 1;
}

/**
 * The avatar-ring view for an author, or `null` when there is nothing to draw. A community-disputed
 * reputation always shows the RED danger ring (even at tier 0 — a warning is worth drawing on a
 * zero-stake troll). Otherwise the ring appears only from tier 1 up; tier 0 with non-negative
 * reputation ⇒ `null` (self-hidden), the common case for fresh-chain accounts, so most rows stay clean.
 *
 * "Disputed" is decided by `reputationBadge`, NOT by a raw `< 0n` test, so the ring and the badge next
 * to the name can never disagree: a sub-0.1-ADA dust downvote rounds to "−0" and the badge hides it, so
 * the ring must stay neutral too rather than red-ringing an author app-wide over noise.
 */
export function avatarRing(
  weight: bigint | null | undefined,
  reputationScore: bigint | null | undefined,
): AvatarRingView | null {
  const danger = reputationBadge(reputationScore)?.tone === "down";
  const tier = stakeTier(weight);
  if (tier === 0 && !danger) return null;
  return { tier, danger };
}
