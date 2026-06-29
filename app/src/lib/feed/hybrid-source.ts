// The HYBRID (node-first) FeedSource: composes the PAPI-direct node reader with the SubQuery indexer
// reader so that — when an indexer is configured — the PRIMARY surfaces still read NODE-DIRECT (the
// spec-120/121 MicroblogApi: one enriched, viewer-aware page per `state_call`), and the indexer serves
// ONLY what the node genuinely cannot: substring search, People search, and the reverse Replies tab.
//
// WHY: the old selector was all-or-nothing — any configured GraphQL URL routed EVERY read through the
// indexer with no node fallback (`gqlRequest` throws on any failure), so the node-served reads went
// dormant and a down/slow indexer blanked home/explore/profile/thread even though a capable node was
// right there. The one-call node reads are now cheap enough to be the primary hot path, so the indexer
// becomes NON-LOAD-BEARING for the core feed/thread/profile.
//
// ROUTING IS DETERMINISTIC BY QUERY SHAPE — never a mid-call fallback. That is what keeps it safe: the
// node feed cursor is a `TopLevelPosts` seq while the indexer cursor is its own opaque string, so the
// two cursor spaces must never mix within one paged read. Because `page()` routes by `q.search` (and
// `profile()` by `args.tab === "replies"`), every page + its `loadMore` (which carries the same
// `search`/`tab`) resolve to the SAME reader — cursors can't cross.
//
// caps are the UNION that matters: keep the node's `nodeFeedApi` (+ pagination/follows/profiles/…),
// take `search` + `profileReplies` from the indexer. The viewer-overlay bypass in `useViewerStates` is
// data-driven on each post's `myVote` presence (not on caps), so node-served primary pages still skip
// the per-card `Reposts.getEntries` scan, while indexer-served search results fall back to a per-card
// `viewerPostState` read — which this source routes to the NODE.

import type { FeedSource, FeedCaps } from "./source";

/**
 * Compose a node-first hybrid from the PAPI-direct `node` reader and the GraphQL `indexer` reader.
 * Primaries (feed/thread/profile-non-replies + the social aggregates + liveness) read from `node`;
 * the indexer serves search / People / the Replies tab. Pure composition — no concrete-factory imports.
 */
export function createHybridFeedSource(node: FeedSource, indexer: FeedSource): FeedSource {
  const caps: FeedCaps = {
    // Node-first: keep everything the node serves (nodeFeedApi, pagination, tallies, follows, profiles,
    // profileLikes, whoToFollow, threads, revocation) …
    ...node.caps,
    // … and graft on the two affordances only the indexer can serve.
    search: indexer.caps.search,
    profileReplies: indexer.caps.profileReplies,
  };

  return {
    kind: "hybrid",
    caps,
    // Liveness rides the node's NextPostId signal (the indexer has no `liveHeadId`); the generic
    // `watch()` is the node's NextPostId-driven snapshot too.
    watch: () => node.watch(),
    liveHeadId: node.liveHeadId ? () => node.liveHeadId!() : undefined,
    // A search page is indexer-only (the node has no substring index, and `node.page` throws on
    // `q.search`); every other page — global firehose, For-you, Following, author feed — is node-served.
    page: (q) => (q.search ? indexer.page(q) : node.page(q)),
    // Threads node-direct (one `state_call`; `node.thread` already keeps its own keyed fallback inside).
    thread: (rootId, viewer) => node.thread(rootId, viewer),
    // Posts + Likes tabs are node-served. The reverse Replies tab needs the indexer for the reply LIST
    // (no replies-by-author map on chain), but the profile HEADER (banner/location/website + the exact
    // top-level count + fresh counts) is node-served — the indexer shell omits banner/location/website,
    // so reading the whole profile from the indexer would drop them on Replies and flicker them back on
    // Posts/Likes. Serve the header from the node and graft the indexer's replies page on, so the header
    // is identical across tabs; a node hiccup degrades to the indexer header (the old behaviour).
    profile: async (args) => {
      if (args.tab !== "replies") return node.profile(args);
      const [repliesView, nodeHeader] = await Promise.all([
        indexer.profile(args),
        node
          .profile({ author: args.author, identityHash: args.identityHash, viewer: args.viewer })
          .catch(() => null),
      ]);
      return nodeHeader ? { ...nodeHeader, page: repliesView.page } : repliesView;
    },
    // Aggregates + the viewer's own state + the follow graph + who-to-follow are all node-served
    // (who-to-follow as the node's follower-count popularity proxy — keeps the indexer non-load-bearing).
    poll: (hostId) => node.poll(hostId),
    viewerPollChoice: (hostId, who) => node.viewerPollChoice(hostId, who),
    viewerPostState: (post, who) => node.viewerPostState(post, who),
    followEdges: (who) => node.followEdges(who),
    whoToFollow: (who, limit) => node.whoToFollow(who, limit),
    // People search is indexer-only.
    searchPeople: (q, limit) => indexer.searchPeople(q, limit),
  };
}
