// PAPI-direct social reads: per-post tallies + the viewer's own vote/poll state, read straight from
// `Microblog` storage — the tallies the feed reader stamps onto each card (the node serves the
// aggregate maps cheaply). Follow edges / display names / who-to-follow are node-served too, via the
// reverse maps + MicroblogApi.
//
// ⛔ NEVER iterate all `Votes` entries to sum a tally — the chain maintains the denormalized
// aggregate maps (`VoteTally`, `PollTally`) exactly so the client doesn't have to.
// All weight/score values are u128 ⇒ bigint; counts are u32 ⇒ number.
//
// Storage shapes (spec 205 / storage v6 — the chain NO LONGER STORES a vote's weight; weighted scores
// are derived LIVE by the node and returned by the `MicroblogApi` reads. Only COUNTS live on-chain now):
//   VoteTally(u64) -> VoteCounts { up_count:u32, down_count:u32 }                                 (ValueQuery)
//   Votes(u64, who) -> VoteDir | None   ⚠ PAPI UNWRAPS the single-field `VoteRecord{dir}` → the enum   (OptionQuery)
//   Polls(u64) -> { options: Binary[], close_at: number | undefined } | None                      (OptionQuery)
//   PollTally(u64, u8) -> OptionTally { count:u32 }                                               (ValueQuery, DoubleMap)
//   PollVotes(u64, who) -> u8 | None    ⚠ PAPI UNWRAPS the single-field `PollVoteRecord{option}` → the index (OptionQuery)
//   PollResults(u64) -> { option_weights, option_counts, closed_at } | None                       (OptionQuery)
// The WEIGHTED tallies (post votes, account reputation, poll options) are read from the node MicroblogApi
// (`poll` / `profile`), which joins the bounded staker set against current `VotingPower`. See the
// dynamic-stake-voting plan; and NEVER iterate `Votes` client-side to sum a weight.

import { Binary } from "polkadot-api";
import type {
  CognoApi,
  Ss58,
  PollView,
  PollKindName,
  GovActionType,
  ViewerPostState,
} from "@/lib/types";

/** `PollView.kind` (a runtime `u8`, mirroring `PollKind`'s `#[codec(index)]`) → the app union. */
const POLL_KIND_BY_IX: PollKindName[] = ["Stake", "Governance", "Spo", "Drep"];
/** `GovActionView.action_type` (a runtime `u8`, mirroring `GovActionType`'s `#[codec(index)]`) → the app union. */
const GOV_ACTION_BY_IX: GovActionType[] = [
  "Info",
  "NoConfidence",
  "UpdateCommittee",
  "NewConstitution",
  "HardFork",
  "ParamChange",
  "TreasuryWithdrawal",
];

// Read at the BEST block, not the default (finalized). Writes confirm at `inBestBlock` — several blocks
// before finalization — so a finalized read of a just-cast vote/poll is STALE, and the optimistic UI
// can't reconcile until finalization (a vote appears to "revert" then re-appear on refresh). On this
// single-producer chain best never reorgs, so best is both fresh and safe. Applies to every read that
// a read-after-write reconciliation depends on (tallies + the viewer's own vote/poll choice).
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
 * Map the node-derived, 4-field weighted tally DTO (`up_weight`/`down_weight`/`up_count`/`down_count`,
 * the runtime `Tally` returned by `MicroblogApi.profile`) to the client `Tally`. `score = up − down`,
 * and MAY be negative.
 */
function fromRuntimeTally(t: {
  up_weight: bigint;
  down_weight: bigint;
  up_count: number;
  down_count: number;
}): Tally {
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

/**
 * The COUNT-only vote tally for a post, read straight from storage (`VoteTally`, ValueQuery). Spec 205
 * dropped the stored weight, so this carries `upWeight = downWeight = score = 0n` — the WEIGHTED score is
 * node-derived (feed/thread reads carry it). Only the (dead-except-in-tests) keyed feed fallback uses this.
 */
export async function readPostTally(api: CognoApi, id: bigint): Promise<Tally> {
  const t = await api.query.Microblog.VoteTally.getValue(id, BEST);
  return {
    upWeight: 0n,
    downWeight: 0n,
    upCount: t.up_count ?? 0,
    downCount: t.down_count ?? 0,
    score: 0n,
  };
}

/**
 * The stake-weighted REPUTATION tally for an account, derived LIVE by the node. Reads
 * `MicroblogApi.profile(target).account_tally` (counts from `AccountVoteTally`, weights joined from the
 * staker set's current `VotingPower`) — so it re-prices as stake moves. One node `state_call`.
 */
export async function readAccountVoteTally(api: CognoApi, target: Ss58): Promise<Tally> {
  const p = await api.apis.MicroblogApi.profile(target, BEST);
  return fromRuntimeTally(p.account_tally);
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
 * The viewer's own reputation vote on `target`. `AccountVotes` carries a non-unit `VoteRecord`, so
 * `getValue` distinguishes Some/None cleanly — a plain point read (no getEntries hack, which a unit-valued
 * map would have forced).
 */
export async function readViewerAccountVote(
  api: CognoApi,
  target: Ss58,
  who: Ss58,
): Promise<"Up" | "Down" | null> {
  // `AccountVotes` is now the single-field `VoteRecord { dir }`, which PAPI unwraps to the bare `VoteDir`.
  const dir = await api.query.Microblog.AccountVotes.getValue(target, who, BEST);
  return dir ? (dir.type === "Down" ? "Down" : "Up") : null;
}


/** The viewer's own vote on a post — ONE keyed point-read. */
export async function readViewerPostState(
  api: CognoApi,
  id: bigint,
  who: Ss58,
): Promise<ViewerPostState> {
  // `Votes` is now the single-field `VoteRecord { dir }`, which PAPI unwraps to the bare `VoteDir`.
  const dir = await api.query.Microblog.Votes.getValue(id, who, BEST);
  return { myVote: dir ? (dir.type === "Down" ? "Down" : "Up") : null };
}

/**
 * A poll's options + per-option WEIGHTED tally + close state.
 *
 * The per-option weight is derived LIVE by the node (`MicroblogApi.poll`), which joins the bounded staker
 * set against current `VotingPower` — or returns the FROZEN result once the poll is closed. `close_at`
 * (the block-number deadline) and `finalized` (a `PollResults` row exists) come from storage PAPI-direct;
 * the frontend derives `closed`/`provisional` from `close_at` + the current best block. Counts are exact.
 *
 * ⚠ Shape note: `Poll` is now a FOUR-field struct (`{ options, close_at, kind, action }` — spec 209 added
 * the optional governance-action `action`), so PAPI keeps it wrapped. The `MicroblogApi.poll` view is the
 * read of record for the tally; its `kind` is a plain `u8` (0 = Stake, 1 = Governance, 2 = Spo, 3 = Drep),
 * each option carries the SPO + dRep chamber lenses alongside the holder weight/count, and `action` is the
 * optional CIP-1694 tag (`{ action_type: u8, anchor_url, anchor_hash? }`).
 */
export async function readPoll(api: CognoApi, hostId: bigint): Promise<PollView> {
  const [view, meta, result] = await Promise.all([
    api.apis.MicroblogApi.poll(hostId, BEST),
    api.query.Microblog.Polls.getValue(hostId, BEST),
    api.query.Microblog.PollResults.getValue(hostId, BEST),
  ]);
  if (!view)
    return {
      hostId,
      options: [],
      totalWeight: 0n,
      totalCount: 0,
      finalized: false,
      kind: "Stake",
    };
  const options = view.options.map((o) => ({
    index: o.index,
    label: Binary.toText(o.label),
    weight: BigInt(o.weight),
    count: o.count,
    spoWeight: BigInt(o.spo_weight),
    spoCount: o.spo_count,
    drepWeight: BigInt(o.drep_weight),
    drepCount: o.drep_count,
  }));
  const totalWeight = options.reduce((s, o) => s + o.weight, 0n);
  return {
    hostId,
    options,
    totalWeight,
    totalCount: view.total_votes,
    closeAt: meta?.close_at ?? undefined,
    finalized: result !== undefined,
    kind: POLL_KIND_BY_IX[view.kind] ?? "Stake",
    // spec 209: the optional governance-action tag — CIP-1694 type + a link to the off-chain proposal.
    action: view.action
      ? {
          actionType: GOV_ACTION_BY_IX[view.action.action_type] ?? "Info",
          anchorUrl: Binary.toText(view.action.anchor_url),
          // `anchor_hash: Option<[u8;32]>` decodes as `SizedHex<32>` (a `0x…` hex string) or undefined.
          anchorHash: view.action.anchor_hash ?? undefined,
        }
      : undefined,
  };
}

/** The viewer's chosen option index in a poll, or null if they have not cast. */
export async function readViewerPollChoice(
  api: CognoApi,
  hostId: bigint,
  who: Ss58,
): Promise<number | null> {
  // `PollVotes` is now the single-field `PollVoteRecord { option }`, which PAPI unwraps to the bare index.
  // `?? null` keeps option 0 (nullish coalescing only catches None → undefined).
  const option = await api.query.Microblog.PollVotes.getValue(hostId, who, BEST);
  return option ?? null;
}
