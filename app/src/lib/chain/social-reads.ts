// PAPI-direct social reads: per-post tallies + the viewer's own vote/repost/poll state, read
// straight from `Microblog` storage — the vote/poll tallies the feed reader stamps onto each card
// (the node serves the aggregate maps cheaply). Follow edges / display names / who-to-follow are ALSO
// node-served now, via the reverse maps + MicroblogApi — the claim that they needed an indexer has been
// false since spec 118.
//
// ⛔ NEVER iterate all `Votes` entries to sum a tally — the chain maintains the denormalized
// aggregate maps (`VoteTally`, `RepostCount`, `PollTally`) exactly so the client doesn't have to.
// All weight/score values are u128 ⇒ bigint; counts are u32 ⇒ number.
//
// Storage shapes (verified against pallets/microblog/src/lib.rs):
//   VoteTally(u64) -> Tally { up_weight:u128, down_weight:u128, up_count:u32, down_count:u32 }  (ValueQuery)
//   RepostCount(u64) -> u32                                                                       (ValueQuery)
//   Votes(u64, who) -> VoteRecord { dir: VoteDir, weight:u128 } | None                            (OptionQuery)
//   Reposts(u64, who) -> () | None                                                                (OptionQuery, UNIT value)
//   Polls(u64) -> Poll { options: Vec<Vec<u8>> } | None  ⚠ PAPI UNWRAPS the single field → Binary[] (OptionQuery)
//   PollTally(u64, u8) -> OptionTally { weight:u128, count:u32 }                                  (ValueQuery, DoubleMap)
//   PollVotes(u64, who) -> PollVoteRecord { option:u8, weight:u128 } | None                       (OptionQuery)

import { Binary } from "polkadot-api";
import type { RawTally } from "./descriptors";
import type { CognoApi, Ss58, PollView, ViewerPostState } from "@/lib/types";

// Read at the BEST block, not the default (finalized). Writes confirm at `inBestBlock` — several blocks
// before finalization — so a finalized read of a just-cast vote/poll is STALE, and the optimistic UI
// can't reconcile until finalization (a vote appears to "revert" then re-appear on refresh). On this
// single-producer chain best never reorgs, so best is both fresh and safe. Applies to every read that
// a read-after-write reconciliation depends on (tallies + the viewer's own vote/repost/poll choice).
const BEST = { at: "best" } as const;

/** A decoded tally, client-side (camelCase + the derived `score`). */
export interface Tally {
  upWeight: bigint;
  downWeight: bigint;
  upCount: number;
  downCount: number;
  score: bigint;
}

/**
 * Decode a raw `Tally` (post-keyed or account-keyed — the chain uses the same struct for both).
 * `score = up − down`, and it MAY be negative. The `?? 0n` / `?? 0` guards are belt-and-braces: both
 * maps are ValueQuery so the value is always present, but a zero default costs nothing to assert.
 */
function toTally(t: RawTally): Tally {
  const upWeight = BigInt(t.up_weight ?? 0n);
  const downWeight = BigInt(t.down_weight ?? 0n);
  return {
    upWeight,
    downWeight,
    upCount: t.up_count ?? 0,
    downCount: t.down_count ?? 0,
    score: upWeight - downWeight,
  };
}

/** The denormalized stake-weighted up/down tally for a post (default all-zero, ValueQuery). */
export async function readPostTally(api: CognoApi, id: bigint): Promise<Tally> {
  return toTally(await api.query.Microblog.VoteTally.getValue(id, BEST));
}

/**
 * The denormalized stake-weighted REPUTATION tally for an account (`AccountVoteTally`, ValueQuery ⇒
 * default all-zero). The account analog of {@link readPostTally}.
 */
export async function readAccountVoteTally(api: CognoApi, target: Ss58): Promise<Tally> {
  return toTally(await api.query.Microblog.AccountVoteTally.getValue(target, BEST));
}

/**
 * An account's Cardano-sourced talk WEIGHT — `TalkStake.VotingPower` (lovelace; ValueQuery ⇒ default
 * 0n). This is the account's total proven Cardano stake (the observer-written epoch stake of its bound
 * stake credential), which VARIES per account — unlike `AllowedStake`, the flat posting deposit. It
 * drives the stake-tier avatar ring (`useAuthorWeight` / `useStakeRing`). 0n when the account has no
 * stake-credential bind (most accounts) → no ring.
 */
export async function readVotingPower(api: CognoApi, who: Ss58): Promise<bigint> {
  return await api.query.TalkStake.VotingPower.getValue(who, BEST);
}

/**
 * The viewer's own reputation vote on `target`. Unlike `Reposts`, `AccountVotes` carries a non-unit
 * `VoteRecord`, so `getValue` distinguishes Some/None cleanly — a plain point read (no getEntries hack).
 */
export async function readViewerAccountVote(
  api: CognoApi,
  target: Ss58,
  who: Ss58,
): Promise<"Up" | "Down" | null> {
  const vote = await api.query.Microblog.AccountVotes.getValue(target, who, BEST);
  return vote ? (vote.dir.type === "Down" ? "Down" : "Up") : null;
}


/**
 * The viewer's own vote on a post — ONE keyed point-read.
 *
 * This used to also compute `reposted`, and paid dearly for it: `Reposts` is a `()`-valued
 * `OptionQuery`, so PAPI decodes both `Some(())` and `None` as `undefined` and `getValue` cannot tell
 * them apart. The workaround was a `Reposts.getEntries(id)` PREFIX SCAN per card (its own comment
 * conceded it was "heavier than a point-read") to test membership. Repost was dropped as a feature and
 * nothing rendered the flag, so every card in every feed was paying for a scan whose result was thrown
 * away.
 */
export async function readViewerPostState(
  api: CognoApi,
  id: bigint,
  who: Ss58,
): Promise<ViewerPostState> {
  const vote = await api.query.Microblog.Votes.getValue(id, who, BEST);
  return { myVote: vote ? (vote.dir.type === "Down" ? "Down" : "Up") : null };
}

/**
 * A poll's options + per-option stake-weighted tally, assembled from `Polls` + `PollTally`.
 *
 * ⚠ Shape gotcha, now enforced by the compiler: `Poll` is a SINGLE-FIELD struct (`{ options }`), and
 * PAPI unwraps a single-field struct to its inner type — so `Polls.getValue` returns the options `Vec`
 * DIRECTLY (a `Binary[]`), NOT a `{ options }` wrapper. The hand-written type claimed the wrapper;
 * reading `.options` off an array yielded `undefined`, `labels.map` threw, `usePoll` swallowed it, and
 * EVERY poll rendered as a plain, unvotable post. `RawPolls` is derived from the descriptor, so the
 * wrapper is no longer expressible — this decode cannot regress the same way.
 */
export async function readPoll(api: CognoApi, hostId: bigint): Promise<PollView> {
  const labels = await api.query.Microblog.Polls.getValue(hostId, BEST);
  if (!labels) return { hostId, options: [], totalWeight: 0n, totalCount: 0 };
  const tallies = await Promise.all(
    labels.map((_, i) => api.query.Microblog.PollTally.getValue(hostId, i, BEST)),
  );
  const options = labels.map((b, i) => ({
    index: i,
    label: Binary.toText(b),
    weight: BigInt(tallies[i]?.weight ?? 0n),
    count: tallies[i]?.count ?? 0,
  }));
  const totalWeight = options.reduce((s, o) => s + o.weight, 0n);
  const totalCount = options.reduce((s, o) => s + o.count, 0);
  return { hostId, options, totalWeight, totalCount };
}

/** The viewer's chosen option index in a poll, or null if they have not cast. */
export async function readViewerPollChoice(
  api: CognoApi,
  hostId: bigint,
  who: Ss58,
): Promise<number | null> {
  const v = await api.query.Microblog.PollVotes.getValue(hostId, who, BEST);
  return v ? v.option : null;
}
