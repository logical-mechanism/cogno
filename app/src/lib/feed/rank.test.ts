import { describe, it, expect } from "vitest";
import {
  parseSort,
  isRanked,
  comparatorFor,
  rankWindow,
  hotScore,
  isUndifferentiated,
  RANK_WINDOW,
  MIN_RANKABLE,
  SORTS,
} from "./rank";
import type { CognoPost, Ss58 } from "@/lib/types";

/** A post carrying only what the ranked modes read. Tally fields are DELIBERATELY omittable. */
function post(
  id: bigint,
  at: number,
  extra: Partial<Pick<CognoPost, "score" | "replyCount" | "upCount" | "downCount">> = {},
): CognoPost {
  return {
    id,
    author: "5A" as Ss58,
    text: `p${id}`,
    at,
    ...extra,
  } as CognoPost;
}

const HEAD = 10_000;

describe("parseSort", () => {
  it("accepts the known modes and rejects everything else", () => {
    for (const s of SORTS) expect(parseSort(s)).toBe(s);
    expect(parseSort("nonsense")).toBe("latest");
    expect(parseSort(null)).toBe("latest");
    expect(parseSort(undefined)).toBe("latest");
    expect(parseSort("")).toBe("latest");
    // A hostile value must not become a mode.
    expect(parseSort("__proto__")).toBe("latest");
  });
});

describe("isRanked", () => {
  it("treats latest as the recency spine, not a ranking", () => {
    expect(isRanked("latest")).toBe(false);
    expect(isRanked("hot")).toBe(true);
    expect(isRanked("replies")).toBe(true);
    expect(isRanked("stake")).toBe(true);
  });
});

describe("comparators tolerate MISSING tallies (the strict-mode trap)", () => {
  // Every tally field on CognoPost is optional. A naive `b.replyCount - a.replyCount` would be NaN here
  // and produce an implementation-defined order.
  const bare = [post(1n, 100), post(2n, 200), post(3n, 300)];

  it("never yields NaN from a comparator", () => {
    for (const sort of SORTS) {
      const cmp = comparatorFor(sort, HEAD);
      for (const a of bare) for (const b of bare) expect(Number.isNaN(cmp(a, b))).toBe(false);
    }
  });

  it("falls back to newest-first when nothing distinguishes the posts", () => {
    for (const sort of SORTS) {
      expect(rankWindow(bare, sort, HEAD).map((p) => p.id)).toEqual([3n, 2n, 1n]);
    }
  });
});

describe("stake ordering", () => {
  it("orders by net score, descending", () => {
    const posts = [
      post(1n, 100, { score: 5n }),
      post(2n, 100, { score: 50n }),
      post(3n, 100, { score: 0n }),
    ];
    expect(rankWindow(posts, "stake", HEAD).map((p) => p.id)).toEqual([2n, 1n, 3n]);
  });

  it("handles a NEGATIVE score without wrapping (bigint three-way compare)", () => {
    const posts = [post(1n, 100, { score: -7n }), post(2n, 100, { score: 1n }), post(3n, 100, { score: 0n })];
    expect(rankWindow(posts, "stake", HEAD).map((p) => p.id)).toEqual([2n, 3n, 1n]);
  });

  it("handles scores beyond Number.MAX_SAFE_INTEGER exactly", () => {
    // Lovelace-scale weights exceed 2^53; a Number coercion would collapse these two into a tie.
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const posts = [post(1n, 100, { score: big }), post(2n, 100, { score: big + 1n })];
    expect(rankWindow(posts, "stake", HEAD).map((p) => p.id)).toEqual([2n, 1n]);
  });

  it("breaks a score tie by newest id", () => {
    const posts = [post(1n, 100, { score: 5n }), post(9n, 100, { score: 5n }), post(4n, 100, { score: 5n })];
    expect(rankWindow(posts, "stake", HEAD).map((p) => p.id)).toEqual([9n, 4n, 1n]);
  });
});

describe("replies ordering", () => {
  it("orders by direct reply count, descending", () => {
    const posts = [post(1n, 100, { replyCount: 2 }), post(2n, 100, { replyCount: 9 }), post(3n, 100)];
    expect(rankWindow(posts, "replies", HEAD).map((p) => p.id)).toEqual([2n, 1n, 3n]);
  });
});

describe("hotScore", () => {
  it("decreases as a post gets older, for identical engagement", () => {
    const young = post(1n, HEAD - 10, { upCount: 5 });
    const old = post(2n, HEAD - 100_000, { upCount: 5 });
    expect(hotScore(young, HEAD)).toBeGreaterThan(hotScore(old, HEAD));
  });

  it("increases with engagement, at identical age", () => {
    const quiet = post(1n, HEAD - 100, { upCount: 1 });
    const loud = post(2n, HEAD - 100, { upCount: 20 });
    expect(hotScore(loud, HEAD)).toBeGreaterThan(hotScore(quiet, HEAD));
  });

  it("counts replies and BOTH vote directions as engagement", () => {
    const onlyUp = post(1n, HEAD - 100, { upCount: 3 });
    const mixed = post(2n, HEAD - 100, { upCount: 1, downCount: 1, replyCount: 1 });
    expect(hotScore(mixed, HEAD)).toBeCloseTo(hotScore(onlyUp, HEAD));
  });

  it("is 0 for a post with no engagement, and never NaN or Infinity", () => {
    const p = post(1n, HEAD);
    expect(hotScore(p, HEAD)).toBe(0);
    expect(Number.isFinite(hotScore(p, HEAD))).toBe(true);
  });

  it("does not blow up on a post AT or AHEAD of the reference block", () => {
    // A best-block read can legitimately return a post from the block we just resolved.
    const atHead = post(1n, HEAD, { upCount: 4 });
    const ahead = post(2n, HEAD + 5, { upCount: 4 });
    expect(Number.isFinite(hotScore(atHead, HEAD))).toBe(true);
    expect(hotScore(ahead, HEAD)).toBe(hotScore(atHead, HEAD)); // clamped to age 0, not negative
  });

  it("puts a well-engaged older post above a brand-new empty one", () => {
    // The whole point of Hot: it must not simply reproduce Latest.
    const newEmpty = post(9n, HEAD, {});
    const olderLoud = post(1n, HEAD - 500, { upCount: 30, replyCount: 10 });
    expect(rankWindow([newEmpty, olderLoud], "hot", HEAD).map((p) => p.id)).toEqual([1n, 9n]);
  });
});

describe("rankWindow", () => {
  it("does not mutate its input", () => {
    const posts = [post(1n, 100, { score: 1n }), post(2n, 100, { score: 9n })];
    const before = posts.map((p) => p.id);
    rankWindow(posts, "stake", HEAD);
    expect(posts.map((p) => p.id)).toEqual(before);
  });

  it("is exactly a sort by the mode's comparator (no filtering, no truncation)", () => {
    const posts = [post(1n, 100, { score: 3n }), post(2n, 100, { score: 1n }), post(3n, 100, { score: 2n })];
    const expected = [...posts].sort(comparatorFor("stake", HEAD));
    expect(rankWindow(posts, "stake", HEAD)).toEqual(expected);
    expect(rankWindow(posts, "stake", HEAD)).toHaveLength(posts.length);
  });

  it("handles empty and single-post windows", () => {
    expect(rankWindow([], "hot", HEAD)).toEqual([]);
    expect(rankWindow([post(1n, 100)], "hot", HEAD).map((p) => p.id)).toEqual([1n]);
  });

  it("is a TOTAL order — sorting twice is stable", () => {
    const posts = [
      post(5n, 100, { score: 2n, replyCount: 1 }),
      post(3n, 200, { score: 2n, replyCount: 1 }),
      post(8n, 300, { score: 2n, replyCount: 1 }),
    ];
    for (const sort of SORTS) {
      const once = rankWindow(posts, sort, HEAD);
      expect(rankWindow(once, sort, HEAD)).toEqual(once);
    }
  });
});

describe("isUndifferentiated — the guard against Latest wearing a ranking's label", () => {
  it("is true when every post ties on the mode's key", () => {
    const flat = [post(1n, 100, { score: 0n }), post(2n, 100, { score: 0n })];
    expect(isUndifferentiated(flat, "stake")).toBe(true);
    expect(isUndifferentiated(flat, "replies")).toBe(true);
    expect(isUndifferentiated(flat, "hot")).toBe(true);
  });

  it("is false as soon as one post differs", () => {
    const varied = [post(1n, 100, { score: 0n }), post(2n, 100, { score: 5n })];
    expect(isUndifferentiated(varied, "stake")).toBe(false);
  });

  it("is true for latest (never a ranking) and for tiny windows", () => {
    expect(isUndifferentiated([post(1n, 1, { score: 1n }), post(2n, 2, { score: 2n })], "latest")).toBe(true);
    expect(isUndifferentiated([], "hot")).toBe(true);
    expect(isUndifferentiated([post(1n, 1, { upCount: 3 })], "hot")).toBe(true);
  });

  it("distinguishes hot by ENGAGEMENT, not by age", () => {
    // Same engagement, different ages → hot is just recency here, so it is undifferentiated.
    const sameEngagement = [post(1n, 100, { upCount: 2 }), post(2n, 900, { upCount: 2 })];
    expect(isUndifferentiated(sameEngagement, "hot")).toBe(true);
  });
});

describe("window constants", () => {
  it("matches the read-path clamp on both sides", () => {
    expect(RANK_WINDOW).toBe(100);
  });

  it("keeps the sort control hidden on a corpus too small to rank", () => {
    expect(MIN_RANKABLE).toBeGreaterThan(1);
    expect(MIN_RANKABLE).toBeLessThan(RANK_WINDOW);
  });
});
