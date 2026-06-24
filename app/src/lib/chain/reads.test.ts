// Unit tests for the id-paged keyed reads (spec-119): the global feed pages by id and SKIPS replies;
// the cursor walks older pages to exhaustion; per-post enrichment stamps the social aggregates; and
// a thread is reconstructed from the RepliesByParent reverse map + the ReplyCount aggregate — never a
// full-`Posts` scan. A hand-rolled fake CognoApi backs the keyed storage reads the functions make.

import { describe, it, expect } from "vitest";
import { getGlobalFeedPage, getAuthorFeedPage, getThread, latestPostId } from "./reads";
import type { CognoApi } from "@/lib/types";

interface FakePost {
  author: string;
  text: string;
  parent?: bigint;
  quote?: bigint;
  at: number;
}

interface FakeSpec {
  posts: Map<bigint, FakePost>;
  replyCount?: Map<bigint, number>;
  repliesByParent?: Map<bigint, bigint[]>;
  voteTally?: Map<bigint, { up_weight: bigint; down_weight: bigint; up_count: number; down_count: number }>;
  byAuthor?: Map<string, bigint[]>;
}

const ZERO_TALLY = { up_weight: 0n, down_weight: 0n, up_count: 0, down_count: 0 };

/** Wrap a FakePost into the PAPI-shaped value the reads decode (text is a Binary with `.asText()`). */
function wrap(p: FakePost) {
  return { author: p.author, text: { asText: () => p.text }, parent: p.parent, quote: p.quote, at: p.at };
}

function makeFakeApi(spec: FakeSpec): CognoApi {
  let maxId = -1n;
  for (const k of spec.posts.keys()) if (k > maxId) maxId = k;
  const nextId = maxId >= 0n ? maxId + 1n : 0n;

  return {
    query: {
      Microblog: {
        NextPostId: { getValue: () => Promise.resolve(nextId) },
        Posts: {
          getValue: (id: bigint) =>
            Promise.resolve(spec.posts.has(id) ? wrap(spec.posts.get(id)!) : undefined),
        },
        VoteTally: { getValue: (id: bigint) => Promise.resolve(spec.voteTally?.get(id) ?? ZERO_TALLY) },
        RepostCount: { getValue: () => Promise.resolve(0) },
        ReplyCount: { getValue: (id: bigint) => Promise.resolve(spec.replyCount?.get(id) ?? 0) },
        Polls: { getValue: () => Promise.resolve(undefined) },
        ByAuthor: { getValue: (a: string) => Promise.resolve(spec.byAuthor?.get(a) ?? []) },
        RepliesByParent: {
          getEntries: (parent: bigint) =>
            Promise.resolve(
              (spec.repliesByParent?.get(parent) ?? []).map((child) => ({
                keyArgs: [parent, child],
                value: undefined,
              })),
            ),
        },
      },
      Profile: { Profiles: { getValue: () => Promise.resolve(undefined) } },
    },
  } as unknown as CognoApi;
}

/** A 4-post chain: 0 top-level (2 replies), 1 reply→0, 2 top-level, 3 top-level. */
function sampleSpec(): FakeSpec {
  return {
    posts: new Map<bigint, FakePost>([
      [0n, { author: "alice", text: "root", at: 0 }],
      [1n, { author: "bob", text: "reply", parent: 0n, at: 1 }],
      [2n, { author: "carol", text: "second", at: 2 }],
      [3n, { author: "alice", text: "third", at: 3 }],
    ]),
    replyCount: new Map([[0n, 1]]),
    repliesByParent: new Map([[0n, [1n]]]),
    voteTally: new Map([[2n, { up_weight: 5n, down_weight: 2n, up_count: 1, down_count: 1 }]]),
    byAuthor: new Map([
      ["alice", [0n, 3n]],
      ["bob", [1n]],
      ["carol", [2n]],
    ]),
  };
}

describe("latestPostId", () => {
  it("is NextPostId - 1, or null on an empty chain", async () => {
    expect(await latestPostId(makeFakeApi(sampleSpec()))).toBe(3n);
    expect(await latestPostId(makeFakeApi({ posts: new Map() }))).toBeNull();
  });
});

describe("getGlobalFeedPage — id paging, replies excluded", () => {
  it("returns the newest top-level posts and a cursor for the next page", async () => {
    const api = makeFakeApi(sampleSpec());
    const page1 = await getGlobalFeedPage(api, { limit: 2 });
    // Newest top-level first; reply id 1 is NOT in the feed.
    expect(page1.posts.map((p) => p.id)).toEqual([3n, 2n]);
    expect(page1.nextCursor).toBe(1n); // continue just below the last examined id (2)
    // Enrichment stamped the tally aggregates (post 2 has up 5 / down 2 → score 3).
    const p2 = page1.posts.find((p) => p.id === 2n)!;
    expect(p2.score).toBe(3n);
    expect(p2.upWeight).toBe(5n);
  });

  it("walks the cursor to exhaustion, skipping the reply, then stops", async () => {
    const api = makeFakeApi(sampleSpec());
    const page2 = await getGlobalFeedPage(api, { beforeId: 1n, limit: 2 });
    expect(page2.posts.map((p) => p.id)).toEqual([0n]); // id 1 skipped (reply), id 0 kept
    expect(page2.nextCursor).toBeNull(); // reached id 0 — no further page
    // The top-level root carries its reply count (denormalized ReplyCount aggregate).
    expect(page2.posts[0].replyCount).toBe(1);
  });

  it("filters by a keep() predicate (the Following-feed author set)", async () => {
    const api = makeFakeApi(sampleSpec());
    const page = await getGlobalFeedPage(api, {
      limit: 5,
      keep: (v) => v.author === "alice",
    });
    expect(page.posts.map((p) => p.id)).toEqual([3n, 0n]); // alice's top-level posts only
  });
});

describe("getAuthorFeedPage — top-level over the ByAuthor index", () => {
  it("pages an author's own top-level posts newest-first", async () => {
    const api = makeFakeApi(sampleSpec());
    const page = await getAuthorFeedPage(api, "alice", { limit: 10 });
    expect(page.posts.map((p) => p.id)).toEqual([3n, 0n]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("getThread — keyed reverse lookup, no full scan", () => {
  it("reads the focal's direct replies from RepliesByParent + the ReplyCount aggregate", async () => {
    const api = makeFakeApi(sampleSpec());
    const thread = await getThread(api, 0n);
    expect(thread.root.id).toBe(0n);
    expect(thread.ancestors).toEqual([]); // root is top-level
    expect(thread.replies.map((p) => p.id)).toEqual([1n]);
    expect(thread.replyCount).toBe(1);
  });

  it("walks the ancestor chain up from a reply", async () => {
    const api = makeFakeApi(sampleSpec());
    const thread = await getThread(api, 1n);
    expect(thread.root.id).toBe(1n);
    expect(thread.ancestors.map((p) => p.id)).toEqual([0n]); // parent chain, top-down
    expect(thread.replies).toEqual([]); // the reply itself has no children here
  });
});
