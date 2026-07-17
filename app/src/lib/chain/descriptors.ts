// The raw wire shapes, DERIVED from the generated PAPI descriptors rather than hand-mirrored.
//
// Every type here is a projection of `CognoApi` (= `TypedApi<typeof cogno>`), which papi generates
// from the node's own metadata. Nothing in this file is written by hand, so nothing in it can drift
// from the chain: a runtime change that moves a field moves these types with it, and the decode sites
// stop compiling.
//
// That is not a hypothetical, and spec 205 flipped it BOTH ways — which is exactly why deriving these
// from the descriptor rather than hand-mirroring is load-bearing. PAPI unwraps a SINGLE-field struct to
// its inner type and leaves a multi-field struct as a wrapper:
//   • `Poll` GAINED `close_at`, so it is now a two-field struct — `Polls.getValue` returns a
//     `{ options, close_at }` WRAPPER (pre-205 it was single-field and unwrapped to a bare `Binary[]`,
//     the decode that once made every poll render as a plain, unvotable post).
//   • `VoteRecord`/`PollVoteRecord` LOST their `weight`, so each is now single-field and unwraps to the
//     bare `VoteDir` enum / `u8` option index (pre-205 they were `{ dir, weight }` / `{ option, weight }`
//     wrappers).
// Every consumer reads these through the descriptor-derived types below, so a future field add/remove
// moves the type and breaks the decode site at compile time rather than at runtime.
//
// Naming: these are the RAW (snake_case, on-the-wire) shapes. The client-facing camelCase shapes
// (`CognoPost`, `PollView`, …) live in lib/types.ts; the decoders in reads/node-reads/social-reads are
// the seam between them.

import type { CognoApi } from "@/lib/types";

type Query = CognoApi["query"];
type Apis = CognoApi["apis"];
type Txs = CognoApi["tx"];

// ── storage values ───────────────────────────────────────────────────────────────────────────────

/** `Microblog.Posts` — an OptionQuery, so this includes `| undefined`. Use {@link RawPostValue} for a known-present post. */
export type RawPost = Awaited<ReturnType<Query["Microblog"]["Posts"]["getValue"]>>;

/** A `Microblog.Posts` value known to exist (the unit the decoders consume). */
export type RawPostValue = NonNullable<RawPost>;

/** `Profile.Profiles` — display name / bio / avatar / banner / location / website, all `BoundedVec<u8>`. */
export type RawProfile = NonNullable<Awaited<ReturnType<Query["Profile"]["Profiles"]["getValue"]>>>;

/** `Microblog.VoteTally` / `AccountVoteTally` — the count-only `VoteCounts { up_count, down_count }` (spec
 *  205 dropped the stored weight; weighted numbers are node-derived). ValueQuery ⇒ always present. */
export type RawTally = Awaited<ReturnType<Query["Microblog"]["VoteTally"]["getValue"]>>;

/** `Microblog.Votes` / `AccountVotes` — the viewer's own vote (OptionQuery). Single-field `VoteRecord { dir }`,
 *  so PAPI UNWRAPS it to the bare `VoteDir` enum (spec 205 dropped `weight`; see the header). */
export type RawVoteRecord = Awaited<ReturnType<Query["Microblog"]["Votes"]["getValue"]>>;

/** `Microblog.Polls` — the two-field `{ options, close_at }` WRAPPER (spec 205 added `close_at`, so it is
 *  no longer unwrapped; see the header). OptionQuery. */
export type RawPolls = Awaited<ReturnType<Query["Microblog"]["Polls"]["getValue"]>>;

/** `Microblog.PollTally` — the count-only `OptionTally { count }` per option (spec 205 dropped the weight;
 *  ValueQuery, DoubleMap). */
export type RawPollTally = Awaited<ReturnType<Query["Microblog"]["PollTally"]["getValue"]>>;

/** `Microblog.PollVotes` — the viewer's chosen option (OptionQuery). Single-field `PollVoteRecord { option }`,
 *  so PAPI UNWRAPS it to the bare `u8` index (spec 205 dropped `weight`). */
export type RawPollVote = Awaited<ReturnType<Query["Microblog"]["PollVotes"]["getValue"]>>;

// ── the MicroblogApi runtime API (spec-120 node-served reads) ────────────────────────────────────

/** One enriched, viewer-aware feed page as `MicroblogApi.feed_page` decodes it. */
export type FeedPageRaw = Awaited<ReturnType<Apis["MicroblogApi"]["feed_page"]>>;

/** One `EnrichedPost` — everything a card renders, atomic at one block. */
export type EnrichedPost = FeedPageRaw["posts"][number];

/** A reconstructed thread: focal + ancestors + direct replies. */
export type ThreadRaw = Awaited<ReturnType<Apis["MicroblogApi"]["thread"]>>;

/** One `PersonSummary` as `search_people` / `who_to_follow` decode it. */
export type PersonSummaryRaw = Awaited<ReturnType<Apis["MicroblogApi"]["search_people"]>>[number];

// ── the tx seam ──────────────────────────────────────────────────────────────────────────────────

/**
 * A signable, submittable transaction.
 *
 * PAPI's `Transaction<Asset, Ext>` is parameterized by the chain's asset + signed extensions — NEVER
 * by the call's own arguments — so the type of `api.tx.Microblog.follow(...)` is the type of EVERY
 * `api.tx.*` result. One derivation therefore types all of them, which is why the 13 hand-written
 * `as unknown as Signable` casts in mutations.ts could go. `follow` is an arbitrary representative.
 */
export type Tx = ReturnType<Txs["Microblog"]["follow"]>;
