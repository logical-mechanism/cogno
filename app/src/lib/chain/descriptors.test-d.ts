// Type-level regression guards for the derived wire shapes.
//
// This file has no runtime assertions and no tests — it is checked by `tsc --noEmit` (which the gate
// runs). Each `@ts-expect-error` below is a bug that SHIPPED, and is now unrepresentable. If someone
// re-introduces the hand-written shape, the corresponding `@ts-expect-error` stops being an error, and
// TS fails the build with "Unused '@ts-expect-error' directive" — so these guards cannot silently rot.

import type { RawPolls, RawPostValue, EnrichedPost, FeedPageRaw } from "./descriptors";

// ── the poll bug ─────────────────────────────────────────────────────────────────────────────────
// `Poll` is a single-field struct and PAPI unwraps it, so `Polls.getValue` returns the options Vec
// DIRECTLY. The old hand-written type claimed a `{ options }` wrapper; `.options` was `undefined`,
// `labels.map` threw, `usePoll` swallowed it, and EVERY poll rendered as a plain, unvotable post.
declare const poll: NonNullable<RawPolls>;

// @ts-expect-error — there is no `{ options }` wrapper. Reading it is the bug that shipped.
void poll.options;

// The bare array IS the options list.
void poll.map((label: Uint8Array) => label);

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
