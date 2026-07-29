"use client";

// voteWeightNotice — the disclosure that a vote just cast carries NO WEIGHT.
//
// WHY THIS EXISTS. The chain accepts a zero-weight vote: `vote` / `vote_account` / `cast_poll_vote`
// record the voter and bump the COUNT, and the weighted score is derived at read time from the voter's
// `TalkStake::VotingPower`. An account that never bound its stake key has `VotingPower == 0`, so its
// vote is real, permanent, and worth nothing. That was always true, and it was always SILENT.
//
// It became worth saying out loud when the stake bind stopped being a write gate. Before, the frontend
// simply refused to let such an account write at all, so the case was unreachable through the UI (at
// the cost of blocking every wallet that cannot sign over a reward address from posting entirely). Now
// the account writes normally, which is correct, and the honest thing is to tell it what its vote is
// worth rather than to quietly discard the weight.
//
// KEYED ON `votingPower`, NOT ON `stakeBound`. lib/session.ts documents why at length: the two
// disagree for several blocks after every stake bind, because `VotingPower` is written asynchronously
// by the cardano-observer inherent. A freshly stake-bound account is `stakeBound: true` with
// `votingPower: 0n` for a while, and telling that user their stake "is not linked" would be wrong.
// `votingPower` is the value the chain actually tallies, so it is the one to key on.
//
// EVERY WEIGHTLESS VOTE, NOT ONCE PER ACCOUNT. This started as a one-shot flag, on the reasoning that
// a repeated toast is nagging rather than informing. That was the wrong call: each of those votes
// really did count for nothing, so saying it once and then falling silent leaves every later vote
// quietly worthless with no signal at all. The voting-power STEP in onboarding is what should keep an
// account out of this state; this is the disclosure for whoever skipped it, and it stops by itself the
// moment they bind. The toast carries a stable id so rapid voting refreshes one toast instead of
// stacking a pile of them.

export interface ZeroWeightInput {
  /** `TalkStake.VotingPower` for the voter. `null` while the read is in flight. */
  votingPower: bigint | null;
}

/**
 * Should we disclose that this account's vote carries no weight?
 *
 * Fails CLOSED on an unresolved read: `votingPower === null` returns false. A vote cast while the
 * power read is still in flight might well carry weight, and claiming otherwise would be a false
 * statement about the chain. Saying nothing is the safe direction.
 */
export function shouldWarnZeroWeight({ votingPower }: ZeroWeightInput): boolean {
  if (votingPower === null) return false;
  return votingPower === 0n;
}

/**
 * Stable toast id. Without it, voting several times in a row stacks one identical toast per vote; the
 * toaster dedupes by id, so a fixed one refreshes the existing toast instead.
 */
export const ZERO_WEIGHT_TOAST_ID = "zero-weight-vote";

/** The disclosure copy. Plain language, no em dashes (CLAUDE.md). */
export const ZERO_WEIGHT_MESSAGE =
  "Your vote counted. It carries no weight yet, because this wallet's stake is not linked.";

/** Label for the action that takes them to the stake bind. */
export const ZERO_WEIGHT_ACTION_LABEL = "Add voting power";
