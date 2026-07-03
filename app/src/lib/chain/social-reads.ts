// PAPI-direct social reads: per-post tallies + the viewer's own vote/repost/poll state, read
// straight from `Microblog` storage. These let the PAPI-direct FeedSource set `caps.tallies:true`
// (the node serves the aggregate maps cheaply); follow edges / display names / who-to-follow stay
// indexer-only because they need reverse-index aggregation the node can't serve.
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

import type { CognoApi, Ss58, PollView, ViewerPostState } from "@/lib/types";

// Read at the BEST block, not the default (finalized). Writes confirm at `inBestBlock` — several blocks
// before finalization — so a finalized read of a just-cast vote/poll is STALE, and the optimistic UI
// can't reconcile until finalization (a vote appears to "revert" then re-appear on refresh). On this
// single-producer chain best never reorgs, so best is both fresh and safe. Applies to every read that
// a read-after-write reconciliation depends on (tallies + the viewer's own vote/repost/poll choice).
const BEST = { at: "best" } as const;

/** A storage entry as PAPI returns it from `getEntries` (full key tuple + decoded value). */
interface StorageEntry {
  keyArgs: unknown[];
  value: unknown;
}

/** The denormalized stake-weighted up/down tally for a post (default all-zero, ValueQuery). */
export async function readPostTally(
  api: CognoApi,
  id: bigint,
): Promise<{ upWeight: bigint; downWeight: bigint; upCount: number; downCount: number; score: bigint }> {
  const t = (await api.query.Microblog.VoteTally.getValue(id, BEST)) as unknown as {
    up_weight: bigint;
    down_weight: bigint;
    up_count: number;
    down_count: number;
  };
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

/** The permanent repost count for a post (ValueQuery ⇒ default 0). */
export async function readRepostCount(api: CognoApi, id: bigint): Promise<number> {
  const n = (await api.query.Microblog.RepostCount.getValue(id, BEST)) as unknown as number;
  return n ?? 0;
}

/**
 * The viewer's own vote + repost on a post.
 *
 * `Votes` carries a non-unit `VoteRecord`, so `getValue` distinguishes Some/None cleanly. But
 * `Reposts` is a `()`-valued `OptionQuery`: PAPI decodes both `Some(())` and `None` as `undefined`,
 * so `getValue` CANNOT tell them apart. We instead read the post's repost entries and test
 * membership (correct; heavier than a point-read — the indexer path is the efficient one).
 */
export async function readViewerPostState(
  api: CognoApi,
  id: bigint,
  who: Ss58,
): Promise<ViewerPostState> {
  const [vote, repostEntries] = await Promise.all([
    api.query.Microblog.Votes.getValue(id, who, BEST) as Promise<
      { dir: { type: "Up" | "Down" }; weight: bigint } | undefined
    >,
    api.query.Microblog.Reposts.getEntries(id, BEST) as unknown as Promise<StorageEntry[]>,
  ]);
  const reposted = repostEntries.some(
    (e) => e.keyArgs[e.keyArgs.length - 1] === who,
  );
  const myVote = vote ? (vote.dir.type === "Down" ? "Down" : "Up") : null;
  return { myVote, reposted };
}

/**
 * A poll's options + per-option stake-weighted tally, assembled from `Polls` + `PollTally`.
 *
 * ⚠ Shape gotcha: `Poll` is a SINGLE-FIELD struct (`{ options }`), and PAPI unwraps a single-field
 * struct to its inner type — so `Polls.getValue` returns the options `Vec` DIRECTLY (a `Binary[]`),
 * NOT a `{ options }` wrapper. Reading `.options` off the array yielded `undefined`, so `labels.map`
 * threw, `usePoll` swallowed it, and EVERY poll rendered as a plain, unvotable post. Accept the bare
 * array (and still tolerate a wrapper, in case the struct ever gains a second field).
 */
export async function readPoll(api: CognoApi, hostId: bigint): Promise<PollView> {
  const poll = (await api.query.Microblog.Polls.getValue(hostId, BEST)) as unknown as
    | Array<{ asText: () => string }>
    | { options: Array<{ asText: () => string }> }
    | undefined;
  if (!poll) return { hostId, options: [], totalWeight: 0n, totalCount: 0 };
  const labels = Array.isArray(poll) ? poll : poll.options;
  const tallies = await Promise.all(
    labels.map(
      (_, i) =>
        api.query.Microblog.PollTally.getValue(hostId, i, BEST) as Promise<{
          weight: bigint;
          count: number;
        }>,
    ),
  );
  const options = labels.map((b, i) => ({
    index: i,
    label: b.asText(),
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
  const v = (await api.query.Microblog.PollVotes.getValue(hostId, who, BEST)) as unknown as
    | { option: number }
    | undefined;
  return v ? v.option : null;
}
