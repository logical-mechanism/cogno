// Pure-logic tests for the indexer-backed FeedSource mapping (the node->CognoPost seam). We mock
// the GraphQL client so no network is hit, and assert the load-bearing mapping invariants the
// audit calls out: u64 ids go STRING->BigInt (never through Number, which would lose precision),
// authorRevoked comes from author.banned (revoke flags, never drops, posts), empty profiles return
// the correct empty shape, and threads reconstruct + sort + compute lastActivity correctly.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the client BEFORE importing the source so the source binds to the mock.
const gqlRequest = vi.fn();
vi.mock("./client", () => ({
  gqlRequest: (...args: unknown[]) => gqlRequest(...args),
  // Keep GraphqlError a real class so `instanceof` in feed-source.watch logging still works.
  GraphqlError: class GraphqlError extends Error {
    kind: string;
    status?: number;
    constructor(message: string, kind: string, status?: number) {
      super(message);
      this.kind = kind;
      this.status = status;
    }
  },
}));

import { createGraphqlFeedSource } from "./feed-source";

beforeEach(() => {
  gqlRequest.mockReset();
});

const source = () => createGraphqlFeedSource("http://localhost:3000/");

describe("page() — feed node mapping", () => {
  it("converts a u64 string id via BigInt, NEVER rounding through Number", async () => {
    // A value beyond Number.MAX_SAFE_INTEGER: if mapping went through Number it would corrupt.
    const big = "9007199254740993"; // 2^53 + 1 — not exactly representable as a JS number
    gqlRequest.mockResolvedValue({
      posts: {
        totalCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [
          {
            cursor: "c1",
            node: {
              id: big,
              authorId: "5Author",
              text: "hi",
              parentId: null,
              blockHeight: 10,
              deleted: false,
              author: { id: "5Author", banned: false, identityHash: null },
            },
          },
        ],
      },
    });
    const pg = await source().page({});
    expect(pg.posts[0].id).toBe(BigInt(big));
    // The corrupted Number path would yield 9007199254740992n — prove we did NOT take it.
    expect(pg.posts[0].id).not.toBe(BigInt(Number(big)));
    expect(typeof pg.posts[0].id).toBe("bigint");
  });

  it("maps parentId (string|null) to parent (bigint|undefined)", async () => {
    gqlRequest.mockResolvedValue({
      posts: {
        totalCount: 2,
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [
          { cursor: "a", node: { id: "1", authorId: "A", text: "root", parentId: null, blockHeight: 1, deleted: false } },
          { cursor: "b", node: { id: "2", authorId: "A", text: "reply", parentId: "1", blockHeight: 2, deleted: false } },
        ],
      },
    });
    const pg = await source().page({});
    expect(pg.posts[0].parent).toBeUndefined();
    expect(pg.posts[1].parent).toBe(1n);
  });

  it("sets authorRevoked from the post's author.banned (per author, not per post)", async () => {
    gqlRequest.mockResolvedValue({
      posts: {
        totalCount: 2,
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [
          { cursor: "a", node: { id: "1", authorId: "BannedGuy", text: "x", parentId: null, blockHeight: 1, deleted: false, author: { id: "BannedGuy", banned: true, identityHash: null } } },
          { cursor: "b", node: { id: "2", authorId: "GoodGuy", text: "y", parentId: null, blockHeight: 1, deleted: false, author: { id: "GoodGuy", banned: false, identityHash: null } } },
        ],
      },
    });
    const pg = await source().page({});
    expect(pg.posts[0].authorRevoked).toBe(true);
    expect(pg.posts[1].authorRevoked).toBe(false);
  });

  it("treats a missing author as not-revoked (banned absent => false, not undefined)", async () => {
    gqlRequest.mockResolvedValue({
      posts: {
        totalCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: [{ cursor: "a", node: { id: "1", authorId: "A", text: "x", parentId: null, blockHeight: 1, deleted: false } }],
      },
    });
    const pg = await source().page({});
    expect(pg.posts[0].authorRevoked).toBe(false);
  });

  it("carries pageInfo (cursor + hasNextPage) and totalCount through", async () => {
    gqlRequest.mockResolvedValue({
      posts: { totalCount: 99, pageInfo: { hasNextPage: true, endCursor: "next" }, edges: [] },
    });
    const pg = await source().page({});
    expect(pg.endCursor).toBe("next");
    expect(pg.hasNextPage).toBe(true);
    expect(pg.totalCount).toBe(99);
  });
});

describe("profile() — author mapping + empty shape", () => {
  it("returns the empty profile shape with NO args (no author, no identity)", async () => {
    const prof = await source().profile({});
    expect(gqlRequest).not.toHaveBeenCalled(); // short-circuits, no network
    expect(prof.author).toBeNull();
    expect(prof.postCount).toBe(0);
    expect(prof.banned).toBe(false);
    expect(prof.page.posts).toEqual([]);
  });

  it("returns the empty profile when the indexer has no author record (by account)", async () => {
    gqlRequest.mockResolvedValue({ author: null });
    const prof = await source().profile({ author: "5Unknown" });
    expect(prof.author).toBe("5Unknown");
    expect(prof.postCount).toBe(0);
    expect(prof.page.posts).toEqual([]);
  });

  it("returns the empty profile when an identity-hash lookup finds no authors", async () => {
    gqlRequest.mockResolvedValue({ authors: { nodes: [] } });
    const prof = await source().profile({ identityHash: "0xdeadbeef" });
    expect(prof.identityHash).toBe("0xdeadbeef");
    expect(prof.postCount).toBe(0);
  });

  it("maps a populated author: weight string -> bigint, profile fields, posts inherit banned + social defaults", async () => {
    gqlRequest.mockResolvedValue({
      author: {
        id: "5Author",
        banned: true,
        identityHash: "0xabc",
        weight: "100000000000000000000", // > Number.MAX_SAFE_INTEGER
        displayName: "Auth",
        bio: "hi",
        avatar: "https://x/y.png",
        pinnedPostId: null,
        postCount: 2,
        followerCount: 3,
        followingCount: 4,
        posts: {
          totalCount: 2,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { id: "1", authorId: "5Author", text: "a", parentId: null, blockHeight: 1 },
            { id: "2", authorId: "5Author", text: "b", parentId: null, blockHeight: 2 },
          ],
        },
      },
    });
    const prof = await source().profile({ author: "5Author" });
    expect(prof.weight).toBe(BigInt("100000000000000000000"));
    expect(prof.banned).toBe(true);
    expect(prof.displayName).toBe("Auth");
    expect(prof.followerCount).toBe(3);
    // Every post inherits the author's banned flag.
    expect(prof.page.posts.every((p) => p.authorRevoked === true)).toBe(true);
    // No `deleted` field anymore; social tallies default to zero.
    expect(prof.page.posts[1].upCount).toBe(0);
    expect(prof.page.posts[1].score).toBe(0n);
    expect(prof.page.posts.map((p) => p.id)).toEqual([1n, 2n]);
  });

  it("leaves weight undefined when null (not 0n)", async () => {
    gqlRequest.mockResolvedValue({
      author: { id: "A", banned: false, identityHash: null, postCount: 0, weight: null, posts: { totalCount: 0, nodes: [] } },
    });
    const prof = await source().profile({ author: "A" });
    expect(prof.weight).toBeUndefined();
  });
});

describe("thread() — reconstruction", () => {
  it("throws when the root post is not found", async () => {
    gqlRequest.mockResolvedValue({ post: null });
    await expect(source().thread(7n)).rejects.toThrow(/not found/i);
  });

  it("returns a root with no replies as replyCount=0, replies=[]", async () => {
    gqlRequest.mockResolvedValue({
      post: { id: "1", authorId: "A", text: "root", blockHeight: 5, deleted: false, author: { id: "A", banned: false, identityHash: null }, replies: { totalCount: 0, nodes: [] } },
    });
    const t = await source().thread(1n);
    expect(t.replyCount).toBe(0);
    expect(t.replies).toEqual([]);
    expect(t.lastActivity).toBe(5); // only the root's block height
  });

  it("lastActivity is the MAX block height of root and all replies", async () => {
    gqlRequest.mockResolvedValue({
      post: {
        id: "1",
        authorId: "A",
        text: "root",
        blockHeight: 10,
        deleted: false,
        author: { id: "A", banned: false, identityHash: null },
        replies: {
          totalCount: 2,
          nodes: [
            { id: "2", authorId: "B", text: "r1", parentId: "1", blockHeight: 12, deleted: false, author: { id: "B", banned: false, identityHash: null } },
            { id: "3", authorId: "C", text: "r2", parentId: "1", blockHeight: 25, deleted: false, author: { id: "C", banned: false, identityHash: null } },
          ],
        },
      },
    });
    const t = await source().thread(1n);
    expect(t.replyCount).toBe(2);
    expect(t.lastActivity).toBe(25);
    expect(t.replies.map((r) => r.id)).toEqual([2n, 3n]);
  });

  it("maps the thread root + its social defaults (no deleted field anymore)", async () => {
    gqlRequest.mockResolvedValue({
      post: { id: "1", authorId: "A", text: "root", parentId: null, blockHeight: 3, author: { id: "A", banned: false, identityHash: null }, replies: { totalCount: 0, nodes: [] } },
    });
    const t = await source().thread(1n);
    expect(t.root.id).toBe(1n);
    expect(t.root.text).toBe("root");
    expect(t.root.score).toBe(0n);
  });
});
