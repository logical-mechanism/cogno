// rank — pure comparators for the RANKED feed modes on /explore. React-free and unit-tested, sibling of
// live.ts, whose `byIdDesc` is reused here as the universal tiebreak.
//
// WHAT THESE MODES ARE, EXACTLY: a re-order of ONE bounded window (the newest `RANK_WINDOW` top-level
// posts, fetched in a single `state_call`). They are NOT corpus-wide rankings, and nothing here may be
// labelled as if it were. There is no score index, no reply index and no tally index in the runtime —
// the only ordered index is the recency spine (`TopLevelPosts`), which is what `Latest` pages on.
//
// This is the same honesty constraint that removed the old score-order "Top" toggle from /explore: that
// control claimed an ordering the node could not serve. A window ranking is different in kind — it
// claims only what it actually did, provided the UI discloses the window. The disclosure is not optional
// decoration; it is the thing that makes the mode true.
//
// A ranked list therefore CANNOT PAGINATE. A cursor is monotone in id; a rank is not, so "load more"
// over a re-ranked window would interleave and duplicate rows. Ranked modes render one window with
// `hasMore={false}`, and must never be handed `refresh()`/`loadMore()` — `mergeById` ends in
// `.sort(byIdDesc)` and would silently dissolve the ranking back into recency, which reads to the user
// as a broken control rather than as a design limit.

import type { CognoPost } from "@/lib/types";
import { byIdDesc } from "./live";
import { SECS_PER_BLOCK } from "@/lib/chain/capacity";

/**
 * The ranked window: the newest N top-level posts.
 *
 * 100 is the hard ceiling on BOTH sides — the client clamps (`node-reads` MAX_PAGE) and so does the
 * runtime (`clamp_limit`) — so a larger request is silently clamped rather than honoured. Asking for
 * more would mean several sequential pages, each a fresh read, so the window would stop being one
 * coherent snapshot.
 *
 * CAVEAT, so the comment does not overclaim: the UNFILTERED firehose fills this in one `state_call`
 * (the recency spine is dense). A ROLE-LENSED window does not — the reader chases its cursor up to
 * FILTERED_LENS_MAX_HOPS times, each hop a separate read at `{at:"best"}`, so a lensed window can span a
 * few blocks. The ranking is unaffected in practice (ages are relative to one frozen reference block and
 * a few blocks is seconds against an hours-scale decay), but it is not literally "one call, one block".
 */
export const RANK_WINDOW = 100;

/** The sort modes the ranked window supports. `latest` is the recency spine (not a ranking). */
export const SORTS = ["latest", "hot", "replies", "stake"] as const;
export type Sort = (typeof SORTS)[number];

/** Narrow an untrusted `?s=` value; anything unrecognized falls back to the default. */
export function parseSort(raw: string | null | undefined): Sort {
  return (SORTS as readonly string[]).includes(raw ?? "") ? (raw as Sort) : "latest";
}

/** True for the modes that re-order a window (everything but the recency spine). */
export function isRanked(sort: Sort): boolean {
  return sort !== "latest";
}

// ── engagement primitives ────────────────────────────────────────────────────────────────────────
//
// EVERY tally field on CognoPost is OPTIONAL (`score?`, `replyCount?`, `upCount?`, `downCount?`) — the
// keyed read path leaves them unset. Under `strict` a bare `b.replyCount - a.replyCount` does not even
// compile, and coercing `undefined` through arithmetic would produce NaN and a comparator that violates
// its own total-order contract (making the sort implementation-defined). Coalesce, always.

/** Net stake-weighted score (up − down), 0 when the post carries no tally. */
function scoreOf(p: CognoPost): bigint {
  return p.score ?? 0n;
}

/** Direct replies, 0 when unset. */
function repliesOf(p: CognoPost): number {
  return p.replyCount ?? 0;
}

/** Accounts that voted either way, 0 when unset — the ENGAGEMENT term in the hot score. */
function interactionsOf(p: CognoPost): number {
  return (p.upCount ?? 0) + (p.downCount ?? 0) + repliesOf(p);
}

/** Three-way compare of two bigints, descending. Never subtract bigints into a Number. */
function cmpBigDesc(a: bigint, b: bigint): number {
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}

/**
 * Time-decayed engagement — the `hot` key. Higher is hotter.
 *
 * `post.at` is a BLOCK NUMBER, not a timestamp, so age is derived via `SECS_PER_BLOCK` (the runtime's
 * `MILLI_SECS_PER_BLOCK` is 6000 and the whole app already assumes it). Treating `at` as seconds would
 * silently scale every age by 6× — the decay would still be monotone, so the bug would not show up as a
 * crash, only as a wrong ordering.
 *
 * `GRAVITY` and `AGE_OFFSET_SECS` are the classic shape: engagement over a super-linear age penalty, with
 * an offset so a brand-new post is not dividing by ~0. The RANKING IS INVARIANT under the exact value of
 * `SECS_PER_BLOCK` (it scales every age identically), so a future block-time change cannot reorder rows.
 */
const GRAVITY = 1.5;
const AGE_OFFSET_SECS = 2 * 3600;

export function hotScore(p: CognoPost, headBlock: number): number {
  // A post at or ahead of the reference block reads as age 0 rather than negative (a best-block read can
  // legitimately return a post from the very block we resolved).
  const ageBlocks = Math.max(0, headBlock - p.at);
  const ageSecs = ageBlocks * SECS_PER_BLOCK;
  return interactionsOf(p) / Math.pow(ageSecs + AGE_OFFSET_SECS, GRAVITY);
}

// ── comparators ──────────────────────────────────────────────────────────────────────────────────
//
// Every comparator falls back to `byIdDesc`. That tiebreak is load-bearing, not cosmetic: most posts on
// a small corpus tie on engagement, and without a deterministic final key the order would depend on the
// sort implementation and could differ between renders of the same data.

/** The comparator for `sort`, at a fixed reference block (so the ranking cannot drift mid-render). */
export function comparatorFor(sort: Sort, headBlock: number): (a: CognoPost, b: CognoPost) => number {
  switch (sort) {
    case "hot":
      return (a, b) => {
        const d = hotScore(b, headBlock) - hotScore(a, headBlock);
        return d !== 0 ? d : byIdDesc(a, b);
      };
    case "replies":
      return (a, b) => {
        const d = repliesOf(b) - repliesOf(a);
        return d !== 0 ? d : byIdDesc(a, b);
      };
    case "stake":
      return (a, b) => {
        const d = cmpBigDesc(scoreOf(a), scoreOf(b));
        return d !== 0 ? d : byIdDesc(a, b);
      };
    case "latest":
    default:
      return byIdDesc;
  }
}

/**
 * Re-order a window. Pure — returns a new array, never mutates the input (the caller's array is React
 * state).
 */
export function rankWindow(posts: readonly CognoPost[], sort: Sort, headBlock: number): CognoPost[] {
  return [...posts].sort(comparatorFor(sort, headBlock));
}

/**
 * True when a ranked mode has NOTHING to distinguish — every post in the window has identical
 * engagement on this mode's key, so the output is just the recency order wearing a ranking's label.
 *
 * The UI uses this to say so, rather than presenting Latest under the word "Hot". An empty or
 * single-post window is trivially undifferentiated.
 */
export function isUndifferentiated(posts: readonly CognoPost[], sort: Sort): boolean {
  if (!isRanked(sort) || posts.length < 2) return true;
  const key = (p: CognoPost): string => {
    switch (sort) {
      case "replies":
        return String(repliesOf(p));
      case "stake":
        return String(scoreOf(p));
      case "hot":
        return String(interactionsOf(p));
      default:
        return "";
    }
  };
  const first = key(posts[0]);
  return posts.every((p) => key(p) === first);
}
