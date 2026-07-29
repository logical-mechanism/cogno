"use client";

// voteWeightNotice — the one-shot, per-account disclosure that a vote just cast carries NO WEIGHT.
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
// KEYED ON `votingPower > 0n`, NOT ON `stakeBound`. lib/session.ts:47-53 documents why at length: the
// two disagree for several blocks after every stake bind, because `VotingPower` is written
// asynchronously by the cardano-observer inherent. A freshly stake-bound account is `stakeBound: true`
// with `votingPower: 0n` for a while, and telling that user their stake "is not linked" would be
// wrong. `votingPower` is the value the chain actually tallies, so it is the one to key on.
//
// ONE SHOT PER ACCOUNT, not per vote. A voter with no stake bind is likely to vote repeatedly; a toast
// on every single one is nagging, not disclosure. The flag is device-local and per account (the shared
// `<prefix>:<ss58>` bucketing every other client store uses), so a shared browser never leaks one
// account's dismissals to the next.

import { createViewerScopedStringSetStore } from "./stringSetStore";

/**
 * The device-local record of one-shot notices this account has already been shown.
 *
 * No `claimLegacy`: this store is per-account from birth, so there is no bare pre-namespacing key to
 * adopt, and reading one we never wrote would pick up whatever else happens to live there.
 */
export const seenNoticeStore = createViewerScopedStringSetStore({
  prefix: "cg:seen-notices",
  // Members are our own fixed slugs, never user input. Bounded anyway so a hand-edited value cannot
  // grow this key without limit, mirroring every other store here.
  isValid: (v) => /^[a-z-]{1,40}$/.test(v),
  max: 32,
});

/** The notice slug. A named constant so the store key and the check cannot drift apart. */
export const ZERO_WEIGHT_VOTE = "zero-weight-vote";

export interface ZeroWeightInput {
  /** `TalkStake.VotingPower` for the voter. `null` while the read is in flight. */
  votingPower: bigint | null;
  /** Slugs this account has already been shown. */
  seen: ReadonlySet<string>;
}

/**
 * Should we disclose that this account's vote carries no weight?
 *
 * Fails CLOSED on an unresolved read: `votingPower === null` returns false. A vote cast while the
 * power read is still in flight might well carry weight, and claiming otherwise would be a false
 * statement about the chain. Saying nothing is the safe direction.
 */
export function shouldWarnZeroWeight({ votingPower, seen }: ZeroWeightInput): boolean {
  if (votingPower === null) return false;
  if (votingPower > 0n) return false;
  return !seen.has(ZERO_WEIGHT_VOTE);
}

/** The disclosure copy. Plain language, no em dashes (CLAUDE.md). */
export const ZERO_WEIGHT_MESSAGE =
  "Your vote counted. It carries no weight yet, because this wallet's stake is not linked.";

/** Label for the action that takes them to the optional stake bind. */
export const ZERO_WEIGHT_ACTION_LABEL = "Link stake";
