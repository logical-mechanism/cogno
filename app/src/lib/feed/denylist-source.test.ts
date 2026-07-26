// The operator serve lever, at the layer it actually lives.
//
// The shipped list is EMPTY, so `withServeDenylist` returns the source unwrapped and none of this is
// reachable in production. That is exactly why it needs testing: a mechanism whose only exercise is
// "the empty case does nothing" is a mechanism nobody has ever run, and the day it is populated is a
// day somebody is acting on a legal notice, not a day to discover that thread replies were missed.
//
// The denylist module is mocked rather than driven through env vars, because `process.env.NEXT_PUBLIC_*`
// is inlined at build time by Next and cannot be set per test.

import { describe, it, expect, vi } from "vitest";

const { DENIED_AUTHOR, DENIED_POST } = vi.hoisted(() => ({
  DENIED_AUTHOR: "5DeniedAuthorAddress",
  DENIED_POST: 42n,
}));

vi.mock("@/lib/config/denylist", () => ({
  DENYLIST_EMPTY: false,
  isDeniedAuthor: (a: string | null | undefined) => a === DENIED_AUTHOR,
  isDeniedPost: (id: bigint | string | null | undefined) => String(id) === String(DENIED_POST),
  isDenied: (p: { id: bigint; author: string }) =>
    p.author === DENIED_AUTHOR || String(p.id) === String(DENIED_POST),
}));

import { withServeDenylist } from "./denylist-source";
import type { FeedPage, FeedQuery, CognoPost } from "@/lib/types";
import type { FeedSource } from "./source";

const post = (id: bigint, author = "5Ok"): CognoPost =>
  ({ id, author, text: `post ${id}`, at: 1 }) as unknown as CognoPost;

const emptyPage = (): FeedPage => ({ posts: [], endCursor: null, hasNextPage: false, asOf: null });

/** A source whose `page` serves a scripted list of pages, recording how many were pulled. */
function sourceWithPages(pages: FeedPage[]): { source: FeedSource; calls: () => number } {
  let calls = 0;
  const source = {
    page: async (_q: FeedQuery) => {
      const p = pages[calls] ?? emptyPage();
      calls += 1;
      return p;
    },
  } as unknown as FeedSource;
  return { source, calls: () => calls };
}

describe("withServeDenylist — page()", () => {
  it("omits a denied author's posts", async () => {
    const { source } = sourceWithPages([
      { ...emptyPage(), posts: [post(1n), post(2n, DENIED_AUTHOR), post(3n)] },
    ]);
    const pg = await withServeDenylist(source).page({});
    expect(pg.posts.map((p) => p.id)).toEqual([1n, 3n]);
  });

  it("omits a denied post id even when its author is fine", async () => {
    const { source } = sourceWithPages([{ ...emptyPage(), posts: [post(1n), post(DENIED_POST)] }]);
    const pg = await withServeDenylist(source).page({});
    expect(pg.posts.map((p) => p.id)).toEqual([1n]);
  });

  it("TOPS UP rather than returning an empty page with a live cursor", async () => {
    // THE RUNAWAY. Timeline's tail is an IntersectionObserver over a sentinel a short list never
    // pushes out of view, and it re-observes on every loadMore identity change — so an empty page plus
    // hasNextPage fires the callback immediately and walks the cursor toward post id 0, each hop
    // costing up to six feed_page state_calls that rebuild staker_weights(). /explore guards this for
    // its own axes; Home, profile, bookmarks and lists pass hasMore through raw. Fixing it here means
    // the layer that causes the problem is the layer that solves it.
    const { source, calls } = sourceWithPages([
      { posts: [post(1n, DENIED_AUTHOR)], endCursor: "10", hasNextPage: true, asOf: null },
      { posts: [post(2n, DENIED_AUTHOR)], endCursor: "20", hasNextPage: true, asOf: null },
      { posts: [post(3n)], endCursor: "30", hasNextPage: true, asOf: null },
    ]);
    const pg = await withServeDenylist(source).page({});
    expect(pg.posts.map((p) => p.id)).toEqual([3n]);
    expect(calls()).toBe(3);
  });

  it("bounds the top-up rather than walking the whole chain", async () => {
    // Coming back short is a better failure than an unbounded read. It is also the same shape the
    // runtime's own bounded lens reads already produce, which /explore's guard already handles.
    const denied = { posts: [post(9n, DENIED_AUTHOR)], endCursor: "1", hasNextPage: true, asOf: null };
    const { source, calls } = sourceWithPages(Array.from({ length: 50 }, () => denied));
    const pg = await withServeDenylist(source).page({});
    expect(pg.posts).toHaveLength(0);
    expect(calls()).toBeLessThanOrEqual(4); // the first page plus MAX_TOP_UP
  });

  it("does not top up when there is nothing left to fetch", async () => {
    const { source, calls } = sourceWithPages([
      { posts: [post(1n, DENIED_AUTHOR)], endCursor: null, hasNextPage: false, asOf: null },
    ]);
    const pg = await withServeDenylist(source).page({});
    expect(pg.posts).toHaveLength(0);
    expect(calls()).toBe(1);
  });

  it("does not top up a page that still has survivors", async () => {
    const { source, calls } = sourceWithPages([
      { posts: [post(1n), post(2n, DENIED_AUTHOR)], endCursor: "10", hasNextPage: true, asOf: null },
    ]);
    await withServeDenylist(source).page({});
    expect(calls()).toBe(1);
  });

  it("reports totalCount as what will actually render", async () => {
    const { source } = sourceWithPages([
      { posts: [post(1n), post(2n, DENIED_AUTHOR)], endCursor: null, hasNextPage: false, totalCount: 2, asOf: null },
    ]);
    expect((await withServeDenylist(source).page({})).totalCount).toBe(1);
  });
});

describe("withServeDenylist — thread()", () => {
  const threadSource = (replies: CognoPost[], ancestors: CognoPost[] = []) =>
    ({
      thread: async () => ({ root: post(1n), ancestors, replies, replyCount: replies.length, lastActivity: 1 }),
    }) as unknown as FeedSource;

  it("omits denied replies and ancestors", async () => {
    const t = await withServeDenylist(
      threadSource([post(2n), post(3n, DENIED_AUTHOR)], [post(4n, DENIED_AUTHOR), post(5n)]),
    ).thread(1n);
    expect(t.replies.map((p) => p.id)).toEqual([2n]);
    expect(t.ancestors.map((p) => p.id)).toEqual([5n]);
  });

  it("adjusts replyCount so the UI does not promise rows it will not render", async () => {
    const t = await withServeDenylist(threadSource([post(2n), post(3n, DENIED_AUTHOR)])).thread(1n);
    expect(t.replyCount).toBe(1);
  });

  it("keeps the ROOT, because there is no shape for 'the post you asked for is gone'", async () => {
    // Dropping it would leave the caller rendering somebody else's reply as the focal post, which is
    // worse. The permalink stub is PostCard's job, which is why the predicate is in useModeration too.
    const t = await withServeDenylist(threadSource([])).thread(1n);
    expect(t.root.id).toBe(1n);
  });
});

describe("withServeDenylist — people surfaces", () => {
  it("blanks a denied author's whole profile, not just their posts", async () => {
    // The header renders display name, bio, banner and website — all chain text this deployment has
    // decided not to serve. Filtering only the post list would leave every one of those on screen.
    const source = {
      profile: async () => ({
        author: DENIED_AUTHOR,
        identityHash: "0xabc",
        postCount: 5,
        banned: false,
        displayName: "a name",
        bio: "a bio",
        page: { posts: [post(1n, DENIED_AUTHOR)], endCursor: null, hasNextPage: false, totalCount: 1, asOf: null },
      }),
    } as unknown as FeedSource;
    const p = await withServeDenylist(source).profile({ author: DENIED_AUTHOR });
    expect(p.author).toBeNull();
    expect(p.displayName).toBeUndefined();
    expect(p.page.posts).toHaveLength(0);
  });

  it("still filters a non-denied author's list", async () => {
    const source = {
      profile: async () => ({
        author: "5Ok",
        identityHash: null,
        postCount: 2,
        banned: false,
        page: { posts: [post(1n), post(DENIED_POST)], endCursor: null, hasNextPage: false, totalCount: 2, asOf: null },
      }),
    } as unknown as FeedSource;
    const p = await withServeDenylist(source).profile({ author: "5Ok" });
    expect(p.author).toBe("5Ok");
    expect(p.page.posts.map((x) => x.id)).toEqual([1n]);
  });

  it("omits denied accounts from who-to-follow and people search", async () => {
    const source = {
      whoToFollow: async () => [{ author: "5Ok" }, { author: DENIED_AUTHOR }],
      searchPeople: async () => [{ author: DENIED_AUTHOR }, { author: "5Ok" }],
    } as unknown as FeedSource;
    const wrapped = withServeDenylist(source);
    expect((await wrapped.whoToFollow(null, 10)).map((s) => s.author)).toEqual(["5Ok"]);
    expect((await wrapped.searchPeople("a", 10)).map((s) => s.author)).toEqual(["5Ok"]);
  });

  it("omits denied accounts from both directions of the follow graph", async () => {
    const source = {
      followEdges: async () => ({
        followers: ["5Ok", DENIED_AUTHOR],
        following: [DENIED_AUTHOR, "5Other"],
        followerCount: 2,
        followingCount: 2,
      }),
    } as unknown as FeedSource;
    const e = await withServeDenylist(source).followEdges("5Me");
    expect(e.followers).toEqual(["5Ok"]);
    expect(e.following).toEqual(["5Other"]);
  });

  it("empties a denied poll's options, which are user-authored text on that post", async () => {
    const source = {
      poll: async (hostId: bigint) => ({
        hostId,
        options: [{ text: "yes" }, { text: "no" }],
        totalWeight: 5n,
        totalCount: 2,
        kind: "Stake",
      }),
    } as unknown as FeedSource;
    const wrapped = withServeDenylist(source);
    expect((await wrapped.poll(DENIED_POST)).options).toHaveLength(0);
    expect((await wrapped.poll(7n)).options).toHaveLength(2);
  });
});
