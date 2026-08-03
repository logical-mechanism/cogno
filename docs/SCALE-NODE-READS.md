# Node-served reads

The node serves the whole enriched feed, thread, profile, and search from its own runtime read API —
no external indexer, no GraphQL, no separate service. When the app asks for a page, the node runs the
read loop *inside the runtime* and returns one enriched, viewer-aware page in a single `state_call`,
atomic at one block.

This works because the on-chain data model is already complete: every list the app renders is either an
O(1) aggregate (`VoteTally`, `ReplyCount`, `FollowerCount`, `FollowingCount`, `PollTally`) or a
single-key, prefix-iterable reverse index (`RepliesByParent`, `Followers`, `Following`,
`VotesByAccount`, `PollVotes`) or a SEQ-keyed per-author index (`ByAuthor`, `TopLevelByAuthor`, each
beside an explicit counter). The seq-keyed pair is read by walking its counter DOWN with keyed lookups,
never by prefix iteration: a double map iterates in HASH order, whereas seq is assigned in append order
over strictly ascending post ids, so seq-descending is id-descending with no sort. (They were bounded-vec
blobs until spec 212; see PROTOCOL-PARAMS for why the bound had to go.) The follow graph and every count already live on chain, so the node can
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
- `thread(focal, viewer)` — a reconstructed thread: focal post + ancestor chain (depth-capped) + the newest page of direct replies, plus the cursor to the rest.
- `replies_page(parent, before_seq, limit, viewer)` — the continuation of `thread`: one page of a post's direct replies, newest-first, below the `before_seq` cursor.
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

**One wart.** `EnrichedPost` still carries `repost_count: u32` and `reposted: bool`, and `ViewerState`
still carries `reposted: bool`. All of them are dead — reposting was retired in spec 204, the `Reposts` /
`RepostCount` storage was deleted by migration v5, and the runtime now hardcodes `0` / `false`. The
**fields** stay on the wire because the deployed frontend bundle decodes these structs field-by-field:
removing them changes the return encoding and breaks the live feed for every client that has not
reloaded. They cost 5 bytes per post on `EnrichedPost` and 1 byte per id on `ViewerState`, and they keep
`MicroblogApi` at version 1. Do not read them, do not re-add the storage behind them, and do not
re-declare the `Reposts` / `RepostCount` prefixes — a re-declared prefix resurrects the state the
migration deleted.

## The ordered reply spine

`RepliesByParent` is a `DoubleMap`, so prefix iteration yields HASH order. That is fine for "which
replies does this post have" and useless for "the next page of them": until spec 216 `thread` had to
materialize the whole prefix and sort it, then enrich the first 512 — an unbounded trie walk whose only
bounded part was the enrichment, dropping the *newest* replies, with no cursor for the rest.

`RepliesByParentSeq` (parent, seq → reply id) is the ordered spine, dense over `0 .. ReplyCount[parent]`
in insertion order, which is ascending id order because `NextPostId` is monotonic and replies are
append-only. `index_reply` maintains it alongside `ReplyCount` and `RepliesByParent` on the one
reply-creation path, and the seq IS the pre-increment count — one extra write, no extra read.
`replies_page` walks it DOWN from a cursor: exact-N, no sort, no scan budget, and bounded by SLOTS
examined rather than posts returned, so a (try_state-forbidden) hole yields a short page plus a cursor
instead of a hunt. `thread` returns the newest page off the same walk. Same index/read pairing as the
top-level spine below, for the same reason.

## The top-level-post index

`Posts` interleaves replies and top-level posts in one id space, so paging top-level content by raw id
over-scans past replies. A dense, reply-free spine fixes this: `TopLevelPosts` (seq → post id) with a
`NextTopLevelSeq` counter, and `TopLevelByAuthor` (per-author seq-keyed index). Both are maintained O(1) at every
top-level creation site (`post_message` with `parent == None`, `quote_post`, `create_poll`) via
`index_top_level`. `feed_page` / `following_feed_page` page the seq spine and read exactly N posts;
`author_feed_page` pages `TopLevelByAuthor`; `author_post_count` reads the per-author count directly.

## Bounds and safety

- `limit` is clamped to `[1, MAX_PAGE]` (100) — the API clamps, it never errors on an over-large page.
- The feed scans are bounded: `feed_page` / `search_posts` / `author_replies_page` examine at most
  `limit · MAX_SCAN_FACTOR` (8) ids per call and return `next_cursor` at the last id examined, so the
  client continues instead of the node walking unboundedly over a reply-dense range.
- The two per-author readers are bounded WITHOUT that budget where they can be. Until spec 212 they
  leaned on `MaxPostsPerAuthor` (10,000) for their iteration bound; that cap is gone, so they now
  resolve a `before_id` cursor by BINARY SEARCH over the seq range (post ids ascend with seq, because
  `NextPostId` is monotonic and the index is append-only) rather than by skipping entry by entry. That
  makes `author_feed_page` cost `O(log n) + limit` reads at any page depth — its index is reply-free, so
  every entry it examines is returned and it can never over-scan. `author_replies_page` filters to
  replies, so it takes the scan budget above on top: an author with a long top-level run cannot make it
  walk their whole index to return nothing.
- `thread` caps the ancestor chain at a fixed depth (matching the client) and breaks on a cyclic parent.
  Its replies are a PAGE (the newest `MAX_THREAD_REPLIES`, 512) with a cursor, not a truncation.
- `replies_page` needs no scan budget: the spine holds only that parent's replies and is dense, so every
  slot it touches is returned. An out-of-range `before_seq` is clamped to `ReplyCount`, never trusted.
- The two PEOPLE readers, `search_people` and `who_to_follow`, spend a separate budget: `MAX_PEOPLE_SCAN`
  (10,000 rows EXAMINED per call, in `runtime/src/apis.rs`). They differ from every reader above in that
  there is no seq-ordered index over people to page — `Profiles` and `ByAuthorCount` are both
  `Blake2_128Concat` maps — so the walk order is hash order, arbitrary but stable within a block, and the
  cursor is the last account EXAMINED, resumed exclusively through `iter_from_key`.

  Since spec 217 that budget is a PAGE, not a truncation. Both reads filter inside it (the display-name
  match; the bound-account gate), and before the cursor existed a bound account whose address hashed past
  position 10,000 was not mis-ranked, it was permanently INVISIBLE — its exact display name came back as
  "No people found", with no signal to the caller that anything had been cut. Both now return
  `PeoplePage { people, next_cursor }` under the same short-page-plus-cursor contract as the feeds.

  Three honest limits remain. Ranking is **per page**: the follower-count sort runs over what one page
  examined, so a caller that wants the best N overall must chase the cursor and rank the union itself
  (`nodeSearchPeople` does). A globally-correct top-N needs a ranked index, which is separate work. The
  budget value is deliberately not raised — `Profiles::iter()` full-decodes each ~1 KB profile before
  the bound-account gate can reject it, so 10,000 already authorises megabytes of decode per anonymous
  call; reach is what the cursor buys, not a bigger number. And the reach the FRONTEND takes is itself
  bounded: `chasePeoplePage` stops after `MAX_PEOPLE_HOPS` (8) calls, so it sees the first ~80,000
  profiles in walk order rather than all of them. The runtime hands back every match through exactly one
  page; how far a client walks that chain is the client's own trade against 8 full-budget scans per
  committed query.
- Cursors are **opaque and endpoint-scoped**: a `next_cursor` from one method is only valid passed back to
  the *same* method. `feed_page` / `following_feed_page` page a `TopLevelPosts` seq; `replies_page` pages
  a per-parent reply seq; `author_feed_page` pages a post id; `search_people` / `who_to_follow` page an
  ACCOUNT. Never cross-wire them. The one deliberate crossing is `Thread::replies_next_cursor`, which
  exists to seed `replies_page`.
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
mid-page fallback would cross-wire the cursor. `repliesPage` is not wrapped either, and for a sharper
version of the same reason: its cursor is a seq in the ordered spine, an index the keyed path cannot page
at all — a "fallback" would have to re-read and re-sort the entire prefix, which is the unbounded read the
spine replaced.

## Guardrails

- This is a **read** API: no privileged calls, no committee path, no writes.
- Do not touch `contracts/` — the Aiken vault is live on preprod and any edit moves its hash.
- Do not renumber pallet indices — 6 and 12 are permanently vacant, 7 is GovernedUpgrade.
- After an encoding-affecting change to the API, regenerate the frontend's PAPI descriptors:
  `rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full design.
