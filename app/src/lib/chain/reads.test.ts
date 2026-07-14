// Unit tests for the id-paged keyed reads (spec-119): the global feed pages by id and SKIPS replies;
// the cursor walks older pages to exhaustion; per-post enrichment stamps the social aggregates; and
// a thread is reconstructed from the RepliesByParent reverse map + the ReplyCount aggregate — never a
// full-`Posts` scan. A hand-rolled fake CognoApi backs the keyed storage reads the functions make.
//
// The fake also stubs `apis.MicroblogApi.*` (the spec-120 node-served reads, node-reads.ts) by folding
// the SAME spec into the EnrichedPost shape the runtime returns. The PARITY suite at the bottom asserts
// the node-served page maps to the SAME CognoPost the keyed reads produce — the design's acceptance
// criterion that the two read paths cannot drift.

import { describe, it, expect } from "vitest";
import { Binary } from "polkadot-api";
import { getThread, latestPostId } from "./reads";
import { nodeGlobalFeedPage, nodeAuthorFeedPage, nodeThread } from "./node-reads";
import type { CognoApi, CognoPost } from "@/lib/types";

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
  /** Viewer's votes: post id → direction (drives the node API's `my_vote` overlay). */
  votesByAccount?: Map<string, Map<bigint, "Up" | "Down">>;
  /**
   * Viewer's reposts: account → set of post ids. The CHAIN still has Reposts/RepostCount storage and
   * the runtime still returns `reposted` / `repost_count` in its payload — repost was dropped from the
   * FRONTEND only. The fake keeps emitting them on purpose, so these tests prove the client cleanly
   * IGNORES fields the chain still sends, rather than choking on them.
   */
  repostsByAccount?: Map<string, Set<bigint>>;
}

const ZERO_TALLY = { up_weight: 0n, down_weight: 0n, up_count: 0, down_count: 0 };

/** Wrap a FakePost into the PAPI v2-shaped value the reads decode (text is a `Vec<u8>` → Uint8Array). */
function wrap(p: FakePost) {
  return { author: p.author, text: Binary.fromText(p.text), parent: p.parent, quote: p.quote, at: p.at };
}

/** A Uint8Array for the runtime-API stub (matching PAPI v2's `Vec<u8>` byte type; decode via Binary.toText). */
function bin(s: string) {
  return Binary.fromText(s);
}

/**
 * Fold one post id from the spec into the `EnrichedPost` the spec-120 `MicroblogApi` returns — the
 * runtime-side equivalent of `enrichPosts` (same tally aggregates, reply/repost counts, poll flag,
 * profile snapshot, one-level quote, and the viewer overlay when `viewer` is given). This lets the
 * fake serve the node-read path so the parity suite can pin it against the keyed path.
 */
function enrichFor(spec: FakeSpec, id: bigint, viewer?: string) {
  const p = spec.posts.get(id)!;
  const t = spec.voteTally?.get(id) ?? ZERO_TALLY;
  const myDir = viewer ? spec.votesByAccount?.get(viewer)?.get(id) : undefined;
  const reposted = viewer ? spec.repostsByAccount?.get(viewer)?.has(id) === true : false;
  const quotedPost = p.quote != null ? spec.posts.get(p.quote) : undefined;
  return {
    id,
    author: p.author,
    text: bin(p.text),
    parent: p.parent,
    quote: p.quote,
    at: p.at,
    up_weight: t.up_weight,
    down_weight: t.down_weight,
    up_count: t.up_count,
    down_count: t.down_count,
    repost_count: 0,
    reply_count: spec.replyCount?.get(id) ?? 0,
    is_poll: false,
    my_vote: myDir ? { type: myDir } : undefined,
    reposted,
    author_display_name: bin(""),
    author_avatar: bin(""),
    quoted:
      p.quote != null && quotedPost
        ? {
            id: p.quote,
            author: quotedPost.author,
            text: bin(quotedPost.text),
            author_display_name: bin(""),
            author_avatar: bin(""),
          }
        : undefined,
  };
}

/** The newest-first top-level ids in the spec (mirrors the keyed feed's selection). */
function topLevelDesc(spec: FakeSpec): bigint[] {
  return Array.from(spec.posts.entries())
    .filter(([, p]) => p.parent == null)
    .map(([id]) => id)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
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
    // ── spec-120 node-served reads: fold the SAME spec into the runtime's EnrichedPost/FeedPage shape ──
    apis: {
      MicroblogApi: {
        feed_page: (beforeId: bigint | undefined, limit: number, viewer?: string) => {
          const ids = topLevelDesc(spec).filter((id) => beforeId == null || id < beforeId);
          const taken = ids.slice(0, limit);
          const next = ids.length > taken.length ? taken[taken.length - 1] - 1n : undefined;
          return Promise.resolve({
            posts: taken.map((id) => enrichFor(spec, id, viewer)),
            next_cursor: next,
          });
        },
        author_feed_page: (author: string, beforeId: bigint | undefined, limit: number, viewer?: string) => {
          const ids = topLevelDesc(spec).filter(
            (id) => spec.posts.get(id)!.author === author && (beforeId == null || id < beforeId),
          );
          const taken = ids.slice(0, limit);
          const next = ids.length > taken.length ? taken[taken.length - 1] - 1n : undefined;
          return Promise.resolve({
            posts: taken.map((id) => enrichFor(spec, id, viewer)),
            next_cursor: next,
          });
        },
        following_feed_page: (viewer: string, beforeId: bigint | undefined, limit: number) => {
          // The fake's "Following" is simply the global feed (no follow graph in these specs); the
          // viewer is the timeline owner, so its overlay is stamped.
          const ids = topLevelDesc(spec).filter((id) => beforeId == null || id < beforeId).slice(0, limit);
          return Promise.resolve({
            posts: ids.map((id) => enrichFor(spec, id, viewer)),
            next_cursor: undefined,
          });
        },
        thread: (focal: bigint, viewer?: string) => {
          if (!spec.posts.has(focal)) {
            return Promise.resolve({ ancestors: [], focal: undefined, replies: [] });
          }
          // Top-down ancestor chain by walking `parent`.
          const ancestors: bigint[] = [];
          let cursor = spec.posts.get(focal)!.parent;
          const seen = new Set<bigint>([focal]);
          while (cursor != null && !seen.has(cursor) && spec.posts.has(cursor)) {
            seen.add(cursor);
            ancestors.push(cursor);
            cursor = spec.posts.get(cursor)!.parent;
          }
          ancestors.reverse();
          const replies = (spec.repliesByParent?.get(focal) ?? []).slice().sort((a, b) => (a < b ? -1 : 1));
          return Promise.resolve({
            ancestors: ancestors.map((id) => enrichFor(spec, id, viewer)),
            focal: enrichFor(spec, focal, viewer),
            replies: replies.map((id) => enrichFor(spec, id, viewer)),
          });
        },
      },
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

// These assertions were the KEYED reader's, and they are kept verbatim against the node reader that
// replaced it: they were the reference the node path was originally verified against, so they are
// exactly the right expectations to hold it to now that it is the only path.
describe("nodeGlobalFeedPage — id paging, replies excluded", () => {
  it("returns the newest top-level posts and a cursor for the next page", async () => {
    const api = makeFakeApi(sampleSpec());
    const page1 = await nodeGlobalFeedPage(api, { limit: 2 });
    // Newest top-level first; reply id 1 is NOT in the feed.
    expect(page1.posts.map((p) => p.id)).toEqual([3n, 2n]);
    expect(page1.nextCursor).toBe(1n); // continue just below the last examined id (2)
    // The tally aggregates are stamped (post 2 has up 5 / down 2 → score 3).
    const p2 = page1.posts.find((p) => p.id === 2n)!;
    expect(p2.score).toBe(3n);
    expect(p2.upWeight).toBe(5n);
  });

  it("walks the cursor to exhaustion, skipping the reply, then stops", async () => {
    const api = makeFakeApi(sampleSpec());
    const page2 = await nodeGlobalFeedPage(api, { beforeId: 1n, limit: 2 });
    expect(page2.posts.map((p) => p.id)).toEqual([0n]); // id 1 skipped (reply), id 0 kept
    expect(page2.nextCursor).toBeNull(); // reached id 0 — no further page
    // The top-level root carries its reply count (denormalized ReplyCount aggregate).
    expect(page2.posts[0].replyCount).toBe(1);
  });
});

describe("nodeAuthorFeedPage — top-level over the ByAuthor index", () => {
  it("pages an author's own top-level posts newest-first", async () => {
    const api = makeFakeApi(sampleSpec());
    const page = await nodeAuthorFeedPage(api, "alice", { limit: 10 });
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

// ── PARITY: nodeThread MUST equal the keyed getThread ────────────────────────────────────────────
// This is the ONE parity pair left, and it is still load-bearing: getThread ships as `thread()`'s
// RESILIENCE fallback (a viral post enumerates every reply in one state_call and can hit a resource
// limit, so the keyed per-card path can succeed where the big call cannot). The two must therefore
// still agree, or a thread would silently render differently after a fallback.
//
// The keyed feed readers are GONE (they were the pre-spec-120 compat path and unreachable on a spec-203
// chain), so there is nothing left to compare the feed pages against; their assertions now run directly
// against the node reader above.

/** The fields both read paths produce for a card (everything but the node-only viewer overlay). */
function sharedFields(p: CognoPost) {
  return {
    id: p.id,
    author: p.author,
    text: p.text,
    parent: p.parent,
    at: p.at,
    upWeight: p.upWeight,
    downWeight: p.downWeight,
    upCount: p.upCount,
    downCount: p.downCount,
    score: p.score,
    replyCount: p.replyCount,
    isPoll: p.isPoll,
    quote: p.quote,
  };
}

describe("node-served reads", () => {
  it("a no-viewer page leaves the overlay UNSET, so the per-card read still runs", async () => {
    const api = makeFakeApi(sampleSpec());
    const node = await nodeGlobalFeedPage(api, { limit: 2 });
    // `carriedViewerStates` keys on `myVote !== undefined`. Stamping the overlay on a page fetched with
    // NO viewer would make it wrongly trust a null overlay for a logged-in account and hide their votes.
    expect(node.posts.every((p) => p.myVote === undefined)).toBe(true);
  });

  it("nodeThread matches getThread — the resilience fallback must not render differently", async () => {
    const api = makeFakeApi(sampleSpec());
    const keyed = await getThread(api, 0n);
    const node = await nodeThread(api, 0n);
    expect(node.root.id).toBe(keyed.root.id);
    expect(sharedFields(node.root)).toEqual(sharedFields(keyed.root));
    expect(node.ancestors.map((p) => p.id)).toEqual(keyed.ancestors.map((p) => p.id));
    expect(node.replies.map((p) => p.id)).toEqual(keyed.replies.map((p) => p.id));
    expect(node.replyCount).toBe(keyed.replyCount);
  });

  it("stamps the viewer overlay (myVote) node-side when a viewer is passed", async () => {
    const spec = sampleSpec();
    spec.votesByAccount = new Map([["dave", new Map([[2n, "Up"]])]]);
    spec.repostsByAccount = new Map([["dave", new Set([3n])]]);
    const api = makeFakeApi(spec);
    const page = await nodeGlobalFeedPage(api, { limit: 5, viewer: "dave" });
    const byId = new Map(page.posts.map((p) => [p.id, p]));
    expect(byId.get(2n)!.myVote).toBe("Up");
    expect(byId.get(3n)!.myVote).toBeNull();
    // No viewer ⇒ NO overlay at all: the keys stay UNSET (undefined), not `null`/`false`. The runtime
    // returns my_vote: None regardless of viewer, so the client must NOT stamp it
    // when it passed no viewer — otherwise carriedViewerStates would wrongly trust a null overlay for a
    // logged-in account and hide their real votes.
    const anon = await nodeGlobalFeedPage(api, { limit: 5 });
    expect(anon.posts.every((p) => p.myVote === undefined)).toBe(true);
  });
});
