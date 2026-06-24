import { describe, it, expect } from "vitest";
import {
  voteDelta,
  applyCountPatch,
  applyViewerPatch,
  viewerPatchSettled,
  mergeFeed,
  EMPTY_OVERLAY,
  type Overlay,
} from "./optimistic";
import type { CognoPost, ViewerPostState } from "./types";

function post(id: bigint, over: Partial<CognoPost> = {}): CognoPost {
  return {
    id,
    author: "5A",
    text: `p${id}`,
    at: 1,
    upWeight: 0n,
    downWeight: 0n,
    upCount: 0,
    downCount: 0,
    score: 0n,
    repostCount: 0,
    ...over,
  };
}

describe("voteDelta — re-vote weight reversal (drift-free)", () => {
  it("fresh up-vote: +1 up count, +weight", () => {
    const d = voteDelta(null, "Up", 100n);
    expect(d.upCountDelta).toBe(1);
    expect(d.upWeightDelta).toBe(100n);
    expect(d.downCountDelta).toBe(0);
    expect(d.downWeightDelta).toBe(0n);
  });

  it("re-vote Up→Down reverses the up and applies the down", () => {
    const d = voteDelta("Up", "Down", 100n);
    expect(d.upCountDelta).toBe(-1);
    expect(d.upWeightDelta).toBe(-100n);
    expect(d.downCountDelta).toBe(1);
    expect(d.downWeightDelta).toBe(100n);
  });

  it("clearing an up-vote removes it", () => {
    const d = voteDelta("Up", null, 100n);
    expect(d.upCountDelta).toBe(-1);
    expect(d.upWeightDelta).toBe(-100n);
  });

  it("zero-stake voter still counts but adds 0 weight", () => {
    const d = voteDelta(null, "Up", 0n);
    expect(d.upCountDelta).toBe(1);
    expect(d.upWeightDelta).toBe(0n);
  });
});

describe("applyCountPatch", () => {
  it("applies deltas and recomputes score from weights", () => {
    const p = post(1n, { upWeight: 50n, downWeight: 10n, upCount: 2, score: 40n });
    const out = applyCountPatch(p, { upCountDelta: 1, upWeightDelta: 100n });
    expect(out.upCount).toBe(3);
    expect(out.upWeight).toBe(150n);
    expect(out.score).toBe(140n); // 150 - 10
  });

  it("clamps counts at 0 and never throws on undefined patch", () => {
    const p = post(1n, { upCount: 0 });
    expect(applyCountPatch(p, { upCountDelta: -1 }).upCount).toBe(0);
    expect(applyCountPatch(p, undefined)).toBe(p);
  });
});

describe("applyViewerPatch", () => {
  it("overrides only the patched fields", () => {
    const base: ViewerPostState = { myVote: null, reposted: false };
    expect(applyViewerPatch(base, { myVote: "Up" })).toEqual({ myVote: "Up", reposted: false });
    expect(applyViewerPatch(base, { reposted: true })).toEqual({ myVote: null, reposted: true });
    expect(applyViewerPatch(base, undefined)).toBe(base);
  });
});

describe("viewerPatchSettled — reconcile a confirmed vote by fresh read", () => {
  const up: ViewerPostState = { myVote: "Up", reposted: false };
  const none: ViewerPostState = { myVote: null, reposted: false };

  it("never settles an unconfirmed (not-expected) patch, even when the read agrees", () => {
    expect(viewerPatchSettled(up, { myVote: "Up" })).toBe(false);
  });

  it("settles once a confirmed patch matches the fresh read", () => {
    expect(viewerPatchSettled(up, { myVote: "Up", expected: true })).toBe(true);
  });

  it("keeps a confirmed patch while the read is still stale (gap not yet closed)", () => {
    // Vote confirmed Up, but the re-read hasn't observed it yet → keep the optimistic colour.
    expect(viewerPatchSettled(none, { myVote: "Up", expected: true })).toBe(false);
  });

  it("settles a clear (Up→null) only once the read shows the vote actually gone", () => {
    expect(viewerPatchSettled(up, { myVote: null, expected: true })).toBe(false); // still shows Up
    expect(viewerPatchSettled(none, { myVote: null, expected: true })).toBe(true); // now cleared
  });

  it("treats an undefined patch as not settled", () => {
    expect(viewerPatchSettled(none, undefined)).toBe(false);
  });
});

describe("mergeFeed", () => {
  it("prepends pending top-level cards and patches existing rows", () => {
    const overlay: Overlay = {
      pending: [
        { clientId: "c1", post: post(99n, { text: "pending" }), status: "pending" },
        { clientId: "c2", post: post(98n), parentId: 1n, status: "pending" }, // a reply — NOT in the feed
      ],
      counts: { "1": { upCountDelta: 1, upWeightDelta: 5n } },
      viewer: {},
    };
    const merged = mergeFeed([post(1n), post(2n)], overlay);
    expect(merged.map((p) => p.id)).toEqual([99n, 1n, 2n]); // pending top-level first; reply excluded
    expect(merged[1].upCount).toBe(1); // post 1 patched
  });

  it("EMPTY_OVERLAY is a no-op passthrough", () => {
    const posts = [post(1n), post(2n)];
    expect(mergeFeed(posts, EMPTY_OVERLAY).map((p) => p.id)).toEqual([1n, 2n]);
  });
});
