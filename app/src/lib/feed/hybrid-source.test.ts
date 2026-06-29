// Routing tests for the node-first hybrid: primaries (feed/thread/profile-non-replies + the social
// aggregates + liveness) must resolve to the NODE reader; only substring search, People search, and the
// reverse Replies tab go to the INDEXER. The caps are the union that matters (search + profileReplies
// from the indexer; nodeFeedApi + the rest from the node). We stub two FeedSources that TAG every
// return with which reader served it, then assert the hybrid dispatched to the right one.

import { describe, it, expect } from "vitest";
import type { Observable } from "rxjs";
import { createHybridFeedSource } from "./hybrid-source";
import type { FeedSource, FeedCaps, ProfileArgs } from "./source";
import type { FeedQuery, Ss58 } from "@/lib/types";

/** A FeedSource stub whose every method resolves to `{ from: tag, … }` so routing is observable. */
function stub(tag: "node" | "indexer", caps: Partial<FeedCaps>, withLiveHead: boolean): FeedSource {
  const fullCaps: FeedCaps = {
    search: false,
    pagination: true,
    threads: true,
    revocation: true,
    tallies: true,
    follows: true,
    profiles: true,
    profileReplies: false,
    profileLikes: true,
    whoToFollow: true,
    nodeFeedApi: false,
    ...caps,
  };
  const sentinel = (extra: Record<string, unknown> = {}) => Promise.resolve({ from: tag, ...extra });
  return {
    kind: tag === "node" ? "papi" : "graphql",
    caps: fullCaps,
    watch: () => ({ from: tag }) as unknown as Observable<never>,
    liveHeadId: withLiveHead
      ? () => ({ from: tag }) as unknown as Observable<never>
      : undefined,
    page: (q: FeedQuery) => sentinel({ q }) as never,
    thread: (rootId: bigint, viewer?: Ss58) => sentinel({ rootId, viewer }) as never,
    // `page` is tagged too so the replies-tab MERGE (node header + indexer page) is observable.
    profile: (args: ProfileArgs) =>
      Promise.resolve({ from: tag, args, page: { from: tag } }) as never,
    poll: () => sentinel() as never,
    viewerPollChoice: () => Promise.resolve(null),
    viewerPostState: () => sentinel() as never,
    followEdges: () => sentinel() as never,
    whoToFollow: () => sentinel() as never,
    searchPeople: () => sentinel() as never,
  } as unknown as FeedSource;
}

/** Await a stub-tagged result and read which reader served it. */
async function servedBy(p: Promise<unknown>): Promise<string> {
  return (await p as { from: string }).from;
}

const WHO = "5GrwvaEF" as Ss58;

describe("createHybridFeedSource — node-first routing", () => {
  const node = stub("node", { nodeFeedApi: true, search: false, profileReplies: false }, true);
  const indexer = stub("indexer", { search: true, profileReplies: true, nodeFeedApi: false }, false);
  const hybrid = createHybridFeedSource(node, indexer);

  it("identifies as the hybrid kind", () => {
    expect(hybrid.kind).toBe("hybrid");
  });

  it("serves the global/home/following/author feed from the NODE", async () => {
    expect(await servedBy(hybrid.page({}))).toBe("node");
    expect(await servedBy(hybrid.page({ tab: "following", followeeOf: WHO }))).toBe("node");
    expect(await servedBy(hybrid.page({ authorId: WHO }))).toBe("node");
  });

  it("serves a SEARCH page from the INDEXER", async () => {
    expect(await servedBy(hybrid.page({ search: "hello" }))).toBe("indexer");
  });

  it("serves threads from the NODE", async () => {
    expect(await servedBy(hybrid.thread(1n, WHO))).toBe("node");
  });

  it("serves Posts + Likes from the NODE; Replies = node HEADER + indexer replies PAGE", async () => {
    expect(await servedBy(hybrid.profile({ author: WHO }))).toBe("node");
    expect(await servedBy(hybrid.profile({ author: WHO, tab: "likes" }))).toBe("node");
    // Replies: the header (banner/location/website + exact count) is node-served, the replies LIST is
    // indexer-served, merged into one ProfileView — so the header doesn't flicker on tab switch.
    const replies = (await hybrid.profile({ author: WHO, tab: "replies" })) as unknown as {
      from: string;
      page: { from: string };
    };
    expect(replies.from).toBe("node"); // header from the node
    expect(replies.page.from).toBe("indexer"); // replies page from the indexer
  });

  it("Replies degrades to the indexer header when the node header read fails", async () => {
    const failNode = stub("node", { nodeFeedApi: true }, true);
    // Make the node's profile read reject so the hybrid falls back to the indexer header.
    (failNode as unknown as { profile: () => Promise<unknown> }).profile = () =>
      Promise.reject(new Error("node down"));
    const h = createHybridFeedSource(failNode, indexer);
    const replies = (await h.profile({ author: WHO, tab: "replies" })) as unknown as { from: string };
    expect(replies.from).toBe("indexer"); // fell back to the indexer's own ProfileView
  });

  it("serves People search from the INDEXER", async () => {
    expect(await servedBy(hybrid.searchPeople("ali", 10))).toBe("indexer");
  });

  it("serves the social aggregates + follow graph + who-to-follow from the NODE", async () => {
    expect(await servedBy(hybrid.poll(1n))).toBe("node");
    expect(await servedBy(hybrid.viewerPostState(1n, WHO))).toBe("node");
    expect(await servedBy(hybrid.followEdges(WHO))).toBe("node");
    expect(await servedBy(hybrid.whoToFollow(WHO, 5))).toBe("node");
  });

  it("unions caps: search + Replies from the indexer, nodeFeedApi + the rest from the node", () => {
    expect(hybrid.caps.search).toBe(true); // indexer
    expect(hybrid.caps.profileReplies).toBe(true); // indexer
    expect(hybrid.caps.nodeFeedApi).toBe(true); // node
    expect(hybrid.caps.pagination).toBe(true);
    expect(hybrid.caps.follows).toBe(true);
    expect(hybrid.caps.profileLikes).toBe(true);
  });

  it("exposes the node's NextPostId liveness (the indexer has none)", () => {
    expect(typeof hybrid.liveHeadId).toBe("function");
    const head = hybrid.liveHeadId!() as unknown as { from: string };
    expect(head.from).toBe("node");
  });
});
