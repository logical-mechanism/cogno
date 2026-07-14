# Node-served reads

The node serves the whole enriched feed, thread, profile, and search from its own runtime read API —
no external indexer, no GraphQL, no separate service. When the app asks for a page, the node runs the
read loop *inside the runtime* and returns one enriched, viewer-aware page in a single `state_call`,
atomic at one block.

This works because the on-chain data model is already complete: every list the app renders is either an
O(1) aggregate (`VoteTally`, `ReplyCount`, `FollowerCount`, `FollowingCount`, `PollTally`) or a
single-key, prefix-iterable reverse index (`ByAuthor`, `RepliesByParent`, `Followers`, `Following`,
`VotesByAccount`, `PollVotes`). The follow graph and every count already live on chain, so the node can
assemble a "For-you" feed, a thread, a following timeline, or a profile page without asking any other
system. The alternative — the client firing several JSON-RPC reads per card, roughly 150 round-trips for
a 30-post page — is exactly what this API removes.

## The `MicroblogApi` runtime API

`pallet-microblog` declares a custom `sp_api` Runtime API (`sp_api::decl_runtime_apis!` in
`pallets/microblog/src/lib.rs`), implemented in `runtime/src/apis.rs`. The pallet exposes the read
methods; the runtime layer fills each post's author profile from `pallet-profile` (so the pallet keeps
no dependency on profile). The main surface:

- `feed_page(before, limit, viewer)` — the global "For-you" feed: top-level posts, newest-first.
- `author_feed_page(author, before_id, limit, viewer)` — one author's top-level posts (profile Posts tab).
- `following_feed_page(viewer, before, limit)` — top-level posts by the accounts `viewer` follows.
- `thread(focal, viewer)` — a reconstructed thread: focal post + ancestor chain (depth-capped) + direct replies.
- `author_replies_page`, `likes_page` — the profile Replies and Likes tabs.
- `search_posts(term, …)` — case-insensitive substring search over post bodies (an in-runtime linear scan).
- `poll` / `poll_choice` — a poll's options and per-option tally, and the viewer's own choice.
- `viewer_states(who, ids)` — the viewer's own vote over a batch of ids.
- `follow_edges`, `profile`, `resolve_identity`, `search_people`, `who_to_follow` — the People / profile surface.
- `author_post_count(author)` — the author's top-level post count (replies excluded), the correct profile `postCount`.

Every feed method returns `FeedPage { posts: Vec<EnrichedPost>, next_cursor: Option<u64> }`. An
`EnrichedPost` carries everything a card renders in one shot: `id, author, text, parent, quote, at`, the
tally (`up_weight, down_weight, up_count, down_count`), `reply_count, is_poll`, the viewer overlay
(`my_vote`), the author's `display_name`/`avatar`, and a one-level resolved `quoted` summary. Because the
runtime computes the overlay node-side, a viewer-aware page needs no follow-up reads.

The viewer overlay is a runtime computation, not a client one: inside wasm, `Votes::get(id, who)` decodes
cleanly, so `my_vote` comes back stamped per post.

**One wart.** `EnrichedPost` and `ViewerState` still carry `repost_count: u32` and `reposted: bool`. Both
are dead — reposting was retired in spec 204, the `Reposts` / `RepostCount` storage was deleted by
migration v5, and the runtime now hardcodes `0` / `false`. The **fields** stay on the wire because the
deployed frontend bundle decodes these structs field-by-field: removing them changes the return encoding
and breaks the live feed for every client that has not reloaded. They cost 5 bytes a post and keep
`MicroblogApi` at version 1. Do not read them, do not re-add the storage behind them, and do not
re-declare the `Reposts` / `RepostCount` prefixes — a re-declared prefix resurrects the state the
migration deleted.

## The top-level-post index

`Posts` interleaves replies and top-level posts in one id space, so paging top-level content by raw id
over-scans past replies. A dense, reply-free spine fixes this: `TopLevelPosts` (seq → post id) with a
`NextTopLevelSeq` counter, and `TopLevelByAuthor` (per-author list). Both are maintained O(1) at every
top-level creation site (`post_message` with `parent == None`, `quote_post`, `create_poll`) via
`index_top_level`. `feed_page` / `following_feed_page` page the seq spine and read exactly N posts;
`author_feed_page` pages `TopLevelByAuthor`; `author_post_count` reads the per-author count directly.

## Bounds and safety

- `limit` is clamped to `[1, MAX_PAGE]` (100) — the API clamps, it never errors on an over-large page.
- The feed scans are bounded: `feed_page` / `search_posts` examine at most `limit · MAX_SCAN_FACTOR` (8)
  ids per call and return `next_cursor` at the last id examined, so the client continues instead of the
  node walking unboundedly over a reply-dense range.
- `thread` caps the ancestor chain at a fixed depth (matching the client) and breaks on a cyclic parent.
- Cursors are **opaque and endpoint-scoped**: a `next_cursor` from one method is only valid passed back to
  the *same* method. `feed_page` / `following_feed_page` page a `TopLevelPosts` seq; `author_feed_page`
  pages a post id. Never cross-wire them.
- Runtime APIs are off-chain `state_call`s under a node-side time/memory budget — not gas-metered — so the
  bounds above are what keep each call tight.

## Client wiring

There is exactly **one** reader: `app/src/lib/feed/papi-source.ts`, PAPI-direct against the node, calling
`api.apis.MicroblogApi.feed_page(…)` unconditionally. The `FeedSource` interface in `source.ts` survives
only as a type seam, so the React layer never touches a concrete reader.

There is **no capability detection** and no second read path. The old `FeedCaps` flags, the `nodeFeedApi`
gate, and the keyed-storage fallback for a pre-`MicroblogApi` node were all deleted: the live chain is
spec 204 and a pre-spec-120 cogno node cannot sync it, so every one of those branches was unreachable.

One fallback survives, in `thread()`: `nodeThread(…).catch(() => getThread(…))`. That is a **resilience**
path, not a compatibility one — a viral post whose replies are enumerated in a single `state_call` can hit
the node's resource budget, where incremental keyed reads still succeed. The feed paths are deliberately
*not* wrapped this way: the node cursor is a `TopLevelPosts` seq while the keyed cursor is a post id, so a
mid-page fallback would cross-wire the cursor.

## Guardrails

- This is a **read** API: no privileged calls, no committee path, no writes.
- Do not touch `contracts/` — the Aiken vault is live on preprod and any edit moves its hash.
- Do not renumber pallet indices — 6 and 12 are permanently vacant, 7 is GovernedUpgrade.
- After an encoding-affecting change to the API, regenerate the frontend's PAPI descriptors:
  `rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full design.
