// Unit tests for the CURATION readers added alongside topics/lists/role-lenses:
//   - nodeMembersFeedPage — the list timeline (a fan-out over each member's own author index)
//   - nodeRoleFeedPage    — the SPO/dRep lens (the firehose narrowed on the stamped `authorRoles`)
//   - nodeSearchPosts({keep}) — the topic feed (the node's substring superset narrowed to an exact tag)
//
// The cursor math on the fan-out is the part worth pinning: a merged page must never SKIP a post and
// never return one TWICE across pages, even when one member is truncated at the limit and another is
// exhausted. The "walks every post exactly once" test is the real guard; the rest are boundary cases.
//
// A lean hand-rolled fake CognoApi backs the two runtime-API methods these readers call. It models the
// runtime's actual contract: `author_feed_page` emits a `next_cursor` ONLY when it filled the limit, and
// both methods return posts strictly BELOW `beforeId`.

import { describe, it, expect } from "vitest";
import { Binary } from "polkadot-api";
import { nodeMembersFeedPage, nodeRoleFeedPage, nodeSearchPosts, MAX_FEED_MEMBERS } from "./node-reads";
import type { CognoApi, Ss58 } from "@/lib/types";

interface FakePost {
  id: bigint;
  author: string;
  text: string;
  /** Role kind indices the author holds (0=Spo, 1=DRep, 2=Committee), as the runtime stamps them. */
  roles?: number[];
}

/** Fold a fake post into the `EnrichedPost` shape `mapEnrichedPost` decodes. */
function enrich(p: FakePost) {
  return {
    id: p.id,
    author: p.author,
    text: Binary.fromText(p.text),
    parent: undefined,
    quote: undefined,
    at: 1,
    up_weight: 0n,
    down_weight: 0n,
    up_count: 0,
    down_count: 0,
    reply_count: 0,
    author_display_name: undefined,
    author_avatar: undefined,
    author_roles: (p.roles ?? []).map((k) => [k, `0x${"11".repeat(28)}`] as [number, string]),
    is_poll: false,
  };
}

interface Calls {
  author: Array<{ author: string; beforeId?: bigint; limit: number }>;
  feed: Array<{ beforeId?: bigint; limit: number }>;
  search: Array<{ beforeId?: bigint; limit: number }>;
}

function fakeApi(posts: FakePost[]) {
  const desc = [...posts].sort((a, b) => (a.id === b.id ? 0 : a.id > b.id ? -1 : 1));
  const calls: Calls = { author: [], feed: [], search: [] };

  /** The runtime's page contract: strictly below `beforeId`, and a cursor ONLY when the limit filled. */
  const pageOf = (pool: FakePost[], beforeId: bigint | undefined, limit: number) => {
    const eligible = pool.filter((p) => beforeId == null || p.id < beforeId);
    const taken = eligible.slice(0, limit);
    const filled = taken.length === limit && eligible.length > taken.length;
    return {
      posts: taken.map(enrich),
      next_cursor: filled ? taken[taken.length - 1].id : undefined,
    };
  };

  const api = {
    apis: {
      MicroblogApi: {
        author_feed_page: (
          author: string,
          beforeId: bigint | undefined,
          limit: number,
        ) => {
          calls.author.push({ author, beforeId, limit });
          return Promise.resolve(pageOf(desc.filter((p) => p.author === author), beforeId, limit));
        },
        feed_page: (beforeId: bigint | undefined, limit: number) => {
          calls.feed.push({ beforeId, limit });
          return Promise.resolve(pageOf(desc, beforeId, limit));
        },
        // `Binary` is a value, not a usable type name — take the arg via the fn's own parameter type,
        // the same idiom governance-feed.ts uses for its `Binary.toText` cast.
        search_posts: (
          term: Parameters<typeof Binary.toText>[0],
          beforeId: bigint | undefined,
          limit: number,
        ) => {
          calls.search.push({ beforeId, limit });
          const needle = Binary.toText(term).toLowerCase();
          const pool = desc.filter((p) => p.text.toLowerCase().includes(needle));
          return Promise.resolve(pageOf(pool, beforeId, limit));
        },
      },
    },
  } as unknown as CognoApi;

  return { api, calls };
}

const A = "5A" as Ss58;
const B = "5B" as Ss58;
const C = "5C" as Ss58;

describe("nodeMembersFeedPage — the list timeline", () => {
  it("merges members newest-first and ignores non-members", async () => {
    const { api } = fakeApi([
      { id: 5n, author: A, text: "a5" },
      { id: 4n, author: C, text: "c4" }, // not a member
      { id: 3n, author: B, text: "b3" },
      { id: 2n, author: A, text: "a2" },
    ]);
    const page = await nodeMembersFeedPage(api, [A, B], { limit: 10 });
    expect(page.posts.map((p) => p.id)).toEqual([5n, 3n, 2n]);
    expect(page.nextCursor).toBeNull();
  });

  it("returns an empty page and makes NO calls for an empty member set", async () => {
    const { api, calls } = fakeApi([{ id: 1n, author: A, text: "a" }]);
    const page = await nodeMembersFeedPage(api, [], { limit: 10 });
    expect(page.posts).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(calls.author).toHaveLength(0);
  });

  it("reads one page per member — not one per post", async () => {
    const { api, calls } = fakeApi([
      { id: 3n, author: A, text: "a3" },
      { id: 2n, author: B, text: "b2" },
      { id: 1n, author: A, text: "a1" },
    ]);
    await nodeMembersFeedPage(api, [A, B], { limit: 10 });
    expect(calls.author.map((c) => c.author).sort()).toEqual([A, B]);
  });

  it("caps the fan-out at MAX_FEED_MEMBERS rather than reading every member", async () => {
    const many = Array.from({ length: MAX_FEED_MEMBERS + 8 }, (_, i) => `5M${i}` as Ss58);
    const { api, calls } = fakeApi(many.map((m, i) => ({ id: BigInt(i + 1), author: m, text: `p${i}` })));
    await nodeMembersFeedPage(api, many, { limit: 100 });
    expect(calls.author).toHaveLength(MAX_FEED_MEMBERS);
  });

  it("truncates to the limit and hands back the slice minimum as the next cursor", async () => {
    const { api } = fakeApi([
      { id: 6n, author: A, text: "a6" },
      { id: 5n, author: B, text: "b5" },
      { id: 4n, author: A, text: "a4" },
      { id: 3n, author: B, text: "b3" },
    ]);
    const page = await nodeMembersFeedPage(api, [A, B], { limit: 2 });
    expect(page.posts.map((p) => p.id)).toEqual([6n, 5n]);
    // The lowest id we RETURNED — the next page asks for posts strictly below it.
    expect(page.nextCursor).toBe(5n);
  });

  it("walks every post EXACTLY ONCE across pages (no gaps, no duplicates)", async () => {
    // The real guard on the cursor math: A is dense and gets truncated, B is sparse and exhausts early.
    // Post ids are globally unique on chain, so no two authors may share one here — B interleaves into
    // A's range (55) and sits above it (100) to exercise both sides of the merge.
    const posts: FakePost[] = [];
    for (let i = 1; i <= 12; i++) posts.push({ id: BigInt(i * 10), author: A, text: `a${i}` });
    posts.push({ id: 999n, author: B, text: "b999" }); // above A's whole range
    posts.push({ id: 55n, author: B, text: "b55" }); // interleaved inside A's range
    const { api } = fakeApi(posts);

    const seen: bigint[] = [];
    let cursor: bigint | undefined = undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await nodeMembersFeedPage(api, [A, B], { limit: 3, beforeId: cursor });
      seen.push(...page.posts.map((p) => p.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    const expected = posts.map((p) => p.id).sort((x, y) => (x > y ? -1 : 1));
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
  });

  it("keeps a cursor when a member still has more, even if the page did not fill", async () => {
    // A alone fills the limit exactly, so A reports more; the merged page must not claim it is done.
    const { api } = fakeApi([
      { id: 9n, author: A, text: "a9" },
      { id: 8n, author: A, text: "a8" },
      { id: 7n, author: A, text: "a7" },
    ]);
    const page = await nodeMembersFeedPage(api, [A], { limit: 2 });
    expect(page.posts.map((p) => p.id)).toEqual([9n, 8n]);
    expect(page.nextCursor).toBe(8n);
  });
});

describe("nodeRoleFeedPage — the SPO / dRep lens", () => {
  const SPO = 0;
  const DREP = 1;

  it("keeps only posts whose author holds the role", async () => {
    const { api } = fakeApi([
      { id: 4n, author: A, text: "spo", roles: [SPO] },
      { id: 3n, author: B, text: "drep", roles: [DREP] },
      { id: 2n, author: C, text: "none" },
      { id: 1n, author: A, text: "spo again", roles: [SPO] },
    ]);
    const spo = await nodeRoleFeedPage(api, "Spo", { limit: 10 });
    expect(spo.posts.map((p) => p.id)).toEqual([4n, 1n]);

    const drep = await nodeRoleFeedPage(api, "DRep", { limit: 10 });
    expect(drep.posts.map((p) => p.id)).toEqual([3n]);
  });

  it("matches an author holding SEVERAL roles", async () => {
    const { api } = fakeApi([{ id: 1n, author: A, text: "both", roles: [SPO, DREP] }]);
    expect((await nodeRoleFeedPage(api, "Spo", { limit: 5 })).posts).toHaveLength(1);
    expect((await nodeRoleFeedPage(api, "DRep", { limit: 5 })).posts).toHaveLength(1);
  });

  it("BOUNDS its hops when nothing matches, instead of scanning to the end of the chain", async () => {
    // 400 role-less posts: an unbounded filtered chase would run MAX_EMPTY_CHASE_HOPS (256) state_calls.
    const posts = Array.from({ length: 400 }, (_, i) => ({
      id: BigInt(400 - i),
      author: C,
      text: `p${i}`,
    }));
    const { api, calls } = fakeApi(posts);
    const page = await nodeRoleFeedPage(api, "Spo", { limit: 10 });
    expect(page.posts).toEqual([]);
    expect(calls.feed.length).toBeLessThanOrEqual(6);
    // It still yields a cursor, so "load more" can advance rather than dead-ending.
    expect(page.nextCursor).not.toBeNull();
  });

  it("honours an explicit maxHops from the caller", async () => {
    const posts = Array.from({ length: 400 }, (_, i) => ({
      id: BigInt(400 - i),
      author: C,
      text: `p${i}`,
    }));
    const { api, calls } = fakeApi(posts);
    await nodeRoleFeedPage(api, "Spo", { limit: 10, maxHops: 2 });
    expect(calls.feed).toHaveLength(2);
  });
});

describe("nodeSearchPosts({ keep }) — the topic feed", () => {
  it("narrows the node's substring superset to an EXACT tag", async () => {
    const { api } = fakeApi([
      { id: 4n, author: A, text: "about #cardano" },
      { id: 3n, author: B, text: "about #cardanoNFT" }, // substring match, different topic
      { id: 2n, author: C, text: "see https://x.org/#cardano" }, // URL fragment, not a tag
      { id: 1n, author: A, text: "#Cardano uppercase" }, // same topic, author's casing
    ]);
    const { bodyHasTopic } = await import("@/lib/topics");
    const page = await nodeSearchPosts(api, "#cardano", {
      limit: 10,
      keep: (p) => bodyHasTopic(p.text, "cardano"),
    });
    expect(page.posts.map((p) => p.id)).toEqual([4n, 1n]);
  });

  it("is unfiltered when no `keep` is given (plain search is unchanged)", async () => {
    const { api } = fakeApi([
      { id: 2n, author: A, text: "about #cardano" },
      { id: 1n, author: B, text: "about #cardanoNFT" },
    ]);
    const page = await nodeSearchPosts(api, "#cardano", { limit: 10 });
    expect(page.posts.map((p) => p.id)).toEqual([2n, 1n]);
  });
});

describe("nodeMembersFeedPage — a failed member must not punch a silent hole", () => {
  /** A fake whose `author_feed_page` REJECTS for one nominated member. */
  function flakyApi(posts: FakePost[], failFor: string) {
    const { api, calls } = fakeApi(posts);
    const inner = (api as unknown as {
      apis: { MicroblogApi: { author_feed_page: (a: string, b?: bigint, c?: number) => Promise<unknown> } };
    }).apis.MicroblogApi;
    const real = inner.author_feed_page;
    inner.author_feed_page = (author: string, beforeId?: bigint, limit?: number) =>
      author === failFor
        ? Promise.reject(new Error("rpc blip"))
        : real(author, beforeId, limit);
    return { api, calls };
  }

  const posts: FakePost[] = [
    { id: 100n, author: A, text: "a100" },
    { id: 99n, author: C, text: "c99" }, // C fails — these two are ABOVE the next cursor
    { id: 97n, author: C, text: "c97" },
    { id: 98n, author: A, text: "a98" },
    { id: 96n, author: A, text: "a96" },
  ];

  it("THROWS on the first page rather than rendering a page missing that member", async () => {
    // The cursor is min(id) over the members that SUCCEEDED, so a failed member's posts above it can
    // never be requested again. Keeping the cursor alive is not recovery — page one must fail loud.
    const { api } = flakyApi(posts, C);
    await expect(nodeMembersFeedPage(api, [A, C], { limit: 3 })).rejects.toThrow(/member read failed/);
  });

  it("throws when EVERY member read fails (a read failure, not an empty list)", async () => {
    const { api } = flakyApi([{ id: 1n, author: C, text: "c" }], C);
    await expect(nodeMembersFeedPage(api, [C], { limit: 5 })).rejects.toThrow(/member read failed/);
  });

  it("still degrades (does not throw) on a LATER page, and keeps a cursor", async () => {
    // Paging deeper, the reader has already seen the newer posts, so a partial page is survivable —
    // but it must not claim to be the end.
    const { api } = flakyApi(posts, C);
    const page = await nodeMembersFeedPage(api, [A, C], { limit: 2, beforeId: 100n });
    expect(page.posts.map((p) => p.id)).toEqual([98n, 96n]);
    expect(page.nextCursor).not.toBeNull();
  });

  it("succeeds normally when no member fails", async () => {
    const { api } = fakeApi(posts);
    const page = await nodeMembersFeedPage(api, [A, C], { limit: 10 });
    expect(page.posts.map((p) => p.id)).toEqual([100n, 99n, 98n, 97n, 96n]);
  });
});

describe("nodeSearchPosts({keep}) — a topic with no matches terminates", () => {
  it("returns an empty page with a BOUNDED number of reads, not a chain-wide walk", async () => {
    // The bug this pins: an empty page + a live cursor drives Timeline's auto-loading tail, so an
    // unbounded chase would spin forever while the honest empty copy stayed unreachable.
    const posts = Array.from({ length: 400 }, (_, i) => ({
      id: BigInt(400 - i),
      author: A,
      text: `#other post ${i}`,
    }));
    const { api, calls } = fakeApi(posts);
    const { bodyHasTopic } = await import("@/lib/topics");
    const page = await nodeSearchPosts(api, "#other", {
      limit: 10,
      keep: (p) => bodyHasTopic(p.text, "cardano"),
    });
    expect(page.posts).toEqual([]);
    expect(calls.search.length).toBeLessThanOrEqual(6);
  });
});
