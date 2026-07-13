// The stake-weighted REPUTATION vote ON an account (spec-202), as pure math.
//
// The viewer's unconfirmed vote is held as a DECLARED INTENT — "this is what I last clicked" — and the
// optimistic view is REBASED from it against whatever the chain currently says. It is NOT an accumulated
// delta, and that distinction is the whole design:
//
//   A composed delta is only valid against the exact base it was composed from. The moment the base moves
//   underneath it (a fresh read lands, someone else votes, the surface remounts against a different
//   cache entry) the delta is arithmetic applied to the wrong operand, and the score renders wrong. That
//   is why the delta version needed a bespoke "settle-on-agreement" rule and a TTL to dig itself out.
//
//   An intent is base-independent: the delta is re-derived, per render, from the base actually being
//   shown. Settling then stops being a rule and becomes an identity — once the chain carries your vote,
//   `voteDelta(x, x, w)` is all-zero and the rebase returns the base verbatim. An intent cannot render
//   wrong, whether the base catches up or never does.
//
// Kept React-free so the math is unit-testable (see accountVote.test.ts) — the hook wires it to state.

import { voteDelta } from "./optimistic";

/** What the chain says about an account's reputation, plus the viewer's own vote on it. */
export interface AccountVoteBase {
  myVote: "Up" | "Down" | null;
  upWeight: bigint;
  downWeight: bigint;
  upCount: number;
  downCount: number;
}

/** The viewer's declared (possibly still in-flight) vote. See the module comment for why this is not a delta. */
export interface AccountVoteIntent {
  myVote: "Up" | "Down" | null;
  /** The viewer's VotingPower at click time — the magnitude the chain will record for this vote. */
  weight: bigint;
  /** Unsettled txs outstanding for this target. Scopes the pending/disabled UI, per target. */
  inFlight: number;
}

/** The merged view a vote control renders. */
export interface AccountVoteMerged {
  myVote: "Up" | "Down" | null;
  /** Net stake-weighted score (up − down); may be negative. */
  score: bigint;
  upCount: number;
  downCount: number;
}

/** An account nobody has voted on (also the base while the reads are still in flight). */
export const ZERO_BASE: AccountVoteBase = {
  myVote: null,
  upWeight: 0n,
  downWeight: 0n,
  upCount: 0,
  downCount: 0,
};

const baseView = (b: AccountVoteBase): AccountVoteMerged => ({
  myVote: b.myVote,
  score: b.upWeight - b.downWeight,
  upCount: b.upCount,
  downCount: b.downCount,
});

/**
 * Layer the viewer's declared intent over what the chain says, by re-deriving the delta against THIS
 * base. No intent → the base, untouched.
 *
 * Weights and counts floor at 0, mirroring the chain's `saturating_sub`: a vote cast while VotingPower
 * was still loading carries weight 0, so reversing it later at the real weight could otherwise drive the
 * shown tally negative until the read reconciles.
 */
export function rebaseAccountVote(
  base: AccountVoteBase,
  intent: AccountVoteIntent | undefined,
): AccountVoteMerged {
  if (!intent) return baseView(base);
  // The identity that replaces "settle-on-agreement": once base.myVote === intent.myVote this is all
  // zeroes, so the result IS the base. No rule, no TTL, no chance of double-counting.
  const d = voteDelta(base.myVote, intent.myVote, intent.weight);
  const up = base.upWeight + (d.upWeightDelta ?? 0n);
  const down = base.downWeight + (d.downWeightDelta ?? 0n);
  return {
    myVote: intent.myVote,
    score: (up < 0n ? 0n : up) - (down < 0n ? 0n : down),
    upCount: Math.max(0, base.upCount + (d.upCountDelta ?? 0)),
    downCount: Math.max(0, base.downCount + (d.downCountDelta ?? 0)),
  };
}
