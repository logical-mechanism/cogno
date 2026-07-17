// Type-level regression guards for the derived wire shapes.
//
// This file has no runtime assertions and no tests — it is checked by `tsc --noEmit` (which the gate
// runs). Each `@ts-expect-error` below is a bug that SHIPPED, and is now unrepresentable. If someone
// re-introduces the hand-written shape, the corresponding `@ts-expect-error` stops being an error, and
// TS fails the build with "Unused '@ts-expect-error' directive" — so these guards cannot silently rot.

import type {
  RawPolls,
  RawPostValue,
  RawVoteRecord,
  RawPollVote,
  EnrichedPost,
  FeedPageRaw,
} from "./descriptors";

// ── the poll shape (spec 205) ────────────────────────────────────────────────────────────────────
// `Poll` gained a `close_at` field, so it is now a TWO-field struct — PAPI no longer unwraps it, and
// `Polls.getValue` returns a `{ options, close_at }` WRAPPER (the reverse of the single-field-unwrap
// gotcha the pre-205 shape hit). `.options` is the labels Vec; `.close_at` is the optional deadline.
declare const poll: NonNullable<RawPolls>;

// The wrapper is real now — both fields are readable.
void poll.options.map((label: Uint8Array) => label);
void poll.close_at;

// @ts-expect-error — a two-field struct is NOT unwrapped, so the value is not itself the options array.
void poll.map;

// ── the single-field vote records DO unwrap (spec 205 dropped their `weight`) ──────────────────────
// `VoteRecord { dir }` and `PollVoteRecord { option }` are now single-field, so PAPI unwraps them to the
// bare `VoteDir` enum / `u8` index. Reading `.dir` / `.option` off the unwrapped value is the new bug to
// guard against.
declare const voteRecord: NonNullable<RawVoteRecord>;
void voteRecord.type; // the bare VoteDir enum

// @ts-expect-error — there is no `{ dir }` wrapper any more; the value IS the enum.
void voteRecord.dir;

declare const pollVote: NonNullable<RawPollVote>;

// @ts-expect-error — there is no `{ option }` wrapper; the value IS the `u8` index (a number).
void pollVote.option;

// ── snake_case is the wire, camelCase is the client ──────────────────────────────────────────────
// The raw shapes are on-the-wire (snake_case). Mixing them up with the client `CognoPost` (camelCase)
// silently yields `undefined` rather than a type error when the shape is hand-written.
declare const post: RawPostValue;
void post.author;

// @ts-expect-error — the wire has no `upWeight`; that is the CLIENT shape (see lib/types.ts CognoPost).
void (null as unknown as EnrichedPost).upWeight;

// The wire spells it `up_weight`.
void (null as unknown as EnrichedPost).up_weight;

// ── the page cursor is snake_case too ────────────────────────────────────────────────────────────
declare const page: FeedPageRaw;
void page.next_cursor;

// @ts-expect-error — `nextCursor` is the CLIENT `IdPage` field, not the wire's.
void page.nextCursor;
