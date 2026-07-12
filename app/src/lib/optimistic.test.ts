import { describe, it, expect } from "vitest";
import {
  voteDelta,
  applyCountPatch,
  applyViewerPatch,
  viewerPatchSettled,
  applyProfilePatch,
  profilePatchSettled,
  mergeFeed,
  pendingKey,
  nextPendingId,
  EMPTY_OVERLAY,
  type Overlay,
  type ProfilePatch,
} from "./optimistic";
import type { CognoPost, ProfileView, ViewerPostState } from "./types";

describe("nextPendingId", () => {
  it("mints strictly-negative, unique ids (never 0, never colliding within a tick)", () => {
    const ids = Array.from({ length: 100 }, () => nextPendingId());
    // Every id is a load-bearing negative sentinel (Timeline / poll gate branch on post.id < 0n).
    for (const id of ids) expect(id < 0n).toBe(true);
    // No collisions even when many are minted in the same millisecond (the old Date.now scheme could).
    expect(new Set(ids.map(String)).size).toBe(ids.length);
  });
});

describe("pendingKey", () => {
  it("keys an optimistic card to its chain twin by author + text (the only stable identity)", () => {
    expect(pendingKey({ author: "alice", text: "gm" })).toBe("alice\ngm");
    // Same author+text → same key (so mergeFeed dedup and the presence-reconcile agree).
    expect(pendingKey({ author: "alice", text: "gm" })).toBe(pendingKey({ author: "alice", text: "gm" }));
    // Different author OR text → different key.
    expect(pendingKey({ author: "alice", text: "gm" })).not.toBe(pendingKey({ author: "bob", text: "gm" }));
    expect(pendingKey({ author: "alice", text: "gm" })).not.toBe(pendingKey({ author: "alice", text: "yo" }));
  });
});

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

  // The real sequence this guards, which shipped a NEGATIVE score to the UI: every surface passes
  // `votingPower ?? 0n`, so a vote cast before VotingPower resolves applies +0n weight. Reversing it
  // AFTER the power loads applies the full -N against a base that never gained it.
  it("clamps weights at 0 when a reversal over-subtracts (vote cast at 0 power, reversed at 100)", () => {
    const cast = voteDelta(null, "Up", 0n); // liked while VotingPower was still null
    expect(cast.upWeightDelta).toBe(0n);

    const reverse = voteDelta("Up", null, 100n); // unliked once VotingPower resolved to 100
    expect(reverse.upWeightDelta).toBe(-100n);

    const out = applyCountPatch(post(1n, { upWeight: 0n }), reverse);
    expect(out.upWeight).toBe(0n); // was -100n
    expect(out.score).toBe(0n); // was -100n — a negative score rendered on the card
  });

  it("clamps downWeight at 0 on an over-subtracting reversal too", () => {
    const out = applyCountPatch(post(1n, { downWeight: 10n }), { downWeightDelta: -100n });
    expect(out.downWeight).toBe(0n);
    expect(out.score).toBe(0n);
  });

  // The floor must NOT swallow a legitimate negative score — that comes from down > up, not from a
  // sub-zero weight. Guards against "fixing" this by clamping `score` instead of the weights.
  it("still reports a genuinely negative score when downWeight exceeds upWeight", () => {
    const out = applyCountPatch(post(1n, { upWeight: 10n, downWeight: 50n }), {});
    expect(out.score).toBe(-40n);
  });
});

describe("applyViewerPatch", () => {
  it("overrides only the patched fields", () => {
    const base: ViewerPostState = { myVote: null };
    expect(applyViewerPatch(base, { myVote: "Up" })).toEqual({ myVote: "Up" });
    expect(applyViewerPatch(base, undefined)).toBe(base);
  });
});

describe("viewerPatchSettled — reconcile a confirmed vote by fresh read", () => {
  const up: ViewerPostState = { myVote: "Up" };
  const none: ViewerPostState = { myVote: null };

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
        { clientId: "c1", post: post(99n, { text: "pending" }) },
        { clientId: "c2", post: post(98n), parentId: 1n }, // a reply — NOT in the feed
      ],
      counts: { "1": { upCountDelta: 1, upWeightDelta: 5n } },
      viewer: {},
      profiles: {},
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

function pview(over: Partial<ProfileView> = {}): ProfileView {
  return {
    author: "5A",
    identityHash: null,
    postCount: 3,
    banned: false,
    page: { posts: [], endCursor: null, hasNextPage: false, asOf: null },
    ...over,
  };
}

function ppatch(over: Partial<ProfilePatch> = {}): ProfilePatch {
  return {
    displayName: "Alice",
    bio: "gm",
    avatar: "ipfs://a",
    banner: "",
    location: "",
    website: "",
    ...over,
  };
}

describe("applyProfilePatch", () => {
  it("returns the view untouched when there's no patch", () => {
    const v = pview({ displayName: "Old" });
    expect(applyProfilePatch(v, undefined)).toBe(v);
  });

  it("overwrites all six display fields (set_profile is a whole-record write); '' clears a field", () => {
    const v = pview({ displayName: "Old", bio: "old bio", avatar: "old", location: "NYC" });
    const merged = applyProfilePatch(v, ppatch({ displayName: "Alice", bio: "gm", avatar: "ipfs://a" }));
    expect(merged.displayName).toBe("Alice");
    expect(merged.bio).toBe("gm");
    expect(merged.avatar).toBe("ipfs://a");
    // empty patch fields clear the prior value (→ undefined), not keep it.
    expect(merged.banner).toBeUndefined();
    expect(merged.location).toBeUndefined();
    expect(merged.website).toBeUndefined();
  });

  it("leaves counts / postCount / pinned untouched (not set_profile's to change)", () => {
    const v = pview({ postCount: 7, pinnedPostId: 42n, followerCount: 9 });
    const merged = applyProfilePatch(v, ppatch());
    expect(merged.postCount).toBe(7);
    expect(merged.pinnedPostId).toBe(42n);
    expect(merged.followerCount).toBe(9);
  });
});

describe("profilePatchSettled", () => {
  it("never settles a still-pending (not-confirmed) patch", () => {
    const v = pview({ displayName: "Alice", bio: "gm", avatar: "ipfs://a" });
    expect(profilePatchSettled(v, ppatch({ expected: false }))).toBe(false);
    expect(profilePatchSettled(v, undefined)).toBe(false);
  });

  it("settles once confirmed AND a fresh read carries the same six fields (absent === '')", () => {
    const v = pview({ displayName: "Alice", bio: "gm", avatar: "ipfs://a" }); // banner/location/website undefined
    expect(profilePatchSettled(v, ppatch({ expected: true }))).toBe(true);
  });

  it("does not settle while a field still differs from the read", () => {
    const v = pview({ displayName: "Stale", bio: "gm", avatar: "ipfs://a" });
    expect(profilePatchSettled(v, ppatch({ expected: true }))).toBe(false);
  });
});
