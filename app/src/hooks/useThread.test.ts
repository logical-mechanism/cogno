// Unit tests for `reanchorReplyWindow` — the half of useThread that keeps a paged conversation whole.
//
// This is deliberately a PURE-FUNCTION test rather than a hook test: vitest runs in a `node`
// environment here, so nothing can be rendered, and the behaviour under test only exists on a thread
// past `MAX_THREAD_REPLIES` (512 direct replies), which no rendered fixture in this repo could reach
// anyway. The arithmetic is the part that can be wrong, so the arithmetic is what is pinned.
//
// The invariant: the fetched older window covers reply seqs `[cursor, anchor)` and the thread's own
// newest page covers `[anchor, replyCount)`. Those two ranges must stay ADJACENT. The runtime computes
// the anchor as `replyCount - 512`, so it advances by ONE per new reply, and each advance pushes the
// oldest entries of the newest page out of it.

import { describe, it, expect } from "vitest";
import { reanchorReplyWindow, type OlderReplies } from "./useThread";
import type { CognoPost } from "@/lib/types";

/** A minimal post — only `id` matters to the window arithmetic. */
function post(id: bigint): CognoPost {
  return {
    id,
    author: "5Alice",
    text: `r${id}`,
    at: 1,
    upCount: 0,
    downCount: 0,
    upWeight: 0n,
    downWeight: 0n,
    score: 0n,
    replyCount: 0,
    isPoll: false,
  } as unknown as CognoPost;
}

/** `n` posts with ids `start .. start+n-1`, chronological — the shape a thread page comes back in. */
function page(start: number, n: number): CognoPost[] {
  return Array.from({ length: n }, (_, i) => post(BigInt(start + i)));
}

const ids = (w: OlderReplies) => w.posts.map((p) => Number(p.id));

describe("reanchorReplyWindow", () => {
  it("returns the SAME object when nothing slid, so a short thread never re-renders", () => {
    const win: OlderReplies = { posts: [], cursor: null, anchor: null };
    expect(reanchorReplyWindow(win, null, page(0, 10), page(0, 10))).toBe(win);

    const paged: OlderReplies = { posts: page(0, 5), cursor: 0n, anchor: 5n };
    expect(reanchorReplyWindow(paged, 5n, page(5, 512), page(5, 512))).toBe(paged);
  });

  it("carries the replies the newest page slid past, one per new reply", () => {
    // A 600-reply thread: the newest page covers seq 88..599, and the reader has walked back to seq 38.
    // `posts` are the replies at seq 38..87.
    const win: OlderReplies = { posts: page(38, 50), cursor: 38n, anchor: 88n };
    // One reply lands. The runtime's cursor moves 88 -> 89, so the reply at seq 88 falls out of the
    // newest page — it is that page's OLDEST entry, so it is carried rather than re-fetched.
    const prevPage = page(88, 512); // the page being replaced: seq 88..599
    const freshPage = page(89, 512); // the page replacing it: seq 89..600
    const next = reanchorReplyWindow(win, 89n, prevPage, freshPage);

    expect(next.anchor).toBe(89n);
    expect(next.cursor).toBe(38n); // the far end of the window does not move
    const got = ids(next);
    expect(got).toEqual(Array.from({ length: 51 }, (_, i) => 38 + i));
    // The carried one sits at the NEW end of the older half. (Indexed, not `.at(-1)`: tsconfig pins
    // `lib` at ES2020 for the Segmenter shim, so `Array.prototype.at` does not typecheck here.)
    expect(got[got.length - 1]).toBe(88);
  });

  it("stays adjacent across a burst of replies", () => {
    let win: OlderReplies = { posts: page(38, 50), cursor: 38n, anchor: 88n };
    // Ten replies land one at a time, each re-anchoring by one.
    for (let k = 0; k < 10; k++) {
      const anchor = 88 + k;
      win = reanchorReplyWindow(win, BigInt(anchor + 1), page(anchor, 512), page(anchor + 1, 512));
    }
    expect(win.anchor).toBe(98n);
    // Contiguous 38..97, no gap and no duplicate — which is the whole invariant.
    expect(ids(win)).toEqual(Array.from({ length: 60 }, (_, i) => 38 + i));
    expect(new Set(ids(win)).size).toBe(win.posts.length);
    expect(win.posts.length).toBe(Number(win.anchor) - Number(win.cursor));
  });

  it("carries nothing extra when the slid-past reply was filtered out of the page", () => {
    // A serve denylist shortens the thread page without shortening the cursor, which is a SPINE
    // position. So the page is no longer dense over its seq span, and the old index slice took the
    // reply one slot ABOVE the one that actually slid out — a reply the fresh page still holds, which
    // then rendered twice under the same React key and compounded on every later slide.
    //
    // 600 replies with the one at seq 88 denied: the previous page carries 89..599 (511 posts, not
    // 512) and the fresh page carries 89..600. Exactly one slot slid out and its reply is not in
    // either list, so the honest carry is EMPTY.
    const win: OlderReplies = { posts: [], cursor: 88n, anchor: 88n };
    const prevFiltered = page(89, 511); // runtime returned 88..599; seq 88 denied
    const freshFiltered = page(89, 512); // runtime returned 89..600; nothing denied in range
    const next = reanchorReplyWindow(win, 89n, prevFiltered, freshFiltered);

    expect(next.anchor).toBe(89n);
    expect(next.cursor).toBe(88n);
    expect(next.posts).toEqual([]); // NOT [seq 89], which the fresh page still holds
  });

  it("re-anchors EMPTY rather than splicing across a hole it cannot fill", () => {
    // The count moved by more than one page between two reads (a tab asleep through a burst), so the
    // page being replaced does not reach far enough back to cover the gap. Restarting the window is
    // visibly incomplete; splicing would read as a complete conversation and would not be one.
    const win: OlderReplies = { posts: page(38, 50), cursor: 38n, anchor: 88n };
    const next = reanchorReplyWindow(win, 700n, page(88, 512), page(700, 512));
    expect(next).toEqual({ posts: [], cursor: 700n, anchor: 700n });
  });

  it("adopts the anchor on a first load, with nothing to carry", () => {
    const win: OlderReplies = { posts: [], cursor: null, anchor: null };
    expect(reanchorReplyWindow(win, 88n, null, page(88, 512))).toEqual({
      posts: [],
      cursor: 88n,
      anchor: 88n,
    });
  });

  it("treats a null anchor as seq 0 when a thread first crosses the page size", () => {
    // The thread was under 512 (cursor null, so the page held everything) and has just crossed it: the
    // newest page now starts at seq 3, so replies 0..2 fell out of it and belong to the older half.
    const win: OlderReplies = { posts: [], cursor: null, anchor: null };
    const next = reanchorReplyWindow(win, 3n, page(0, 512), page(3, 512));
    expect(next.anchor).toBe(3n);
    expect(ids(next)).toEqual([0, 1, 2]);
    // `cursor` stays null: everything below the anchor IS loaded, so there is nothing left to fetch.
    expect(next.cursor).toBeNull();
  });

  it("never moves the anchor backwards", () => {
    // Content is append-only, so `replyCount` only grows and the cursor only advances. A cursor that
    // went backwards would mean a read from an older block; restarting is the safe answer, not
    // trimming a window against a position that no longer exists.
    const win: OlderReplies = { posts: page(38, 50), cursor: 38n, anchor: 88n };
    const next = reanchorReplyWindow(win, 80n, page(88, 512), page(80, 512));
    expect(next).toEqual({ posts: [], cursor: 80n, anchor: 80n });
  });
});
