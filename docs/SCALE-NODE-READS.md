# SCALE-NODE-READS — node-served reads

> **Note.** The `spec_version` numbers below (119/120/121) are **pre-restart build history**. On
> `fork/all-rust` these features shipped into the fresh-genesis runtime and are present in
> `spec_version` **203** (`transaction_version` stays **3**). Current overview:
> [`ARCHITECTURE.md`](ARCHITECTURE.md).

Status: **Features 1 + 3 implemented.** Feature 1 — the `MicroblogApi` runtime read API + client wiring
(`spec_version 120`). Feature 3 — the top-level-post index (`spec_version 121`). **Feature 2 intentionally
skipped** (Feature 1 already returns a clean `reposted`, so the `Reposts` re-encode migration buys nothing).
`transaction_version` stays **3** throughout. Builds on the spec-119 reply aggregates.

> **Implementation note (Feature 1).** The pallet exposes `feed_page` / `author_feed_page` /
> `following_feed_page` / `thread`, each returning one enriched, viewer-aware page, plus — folded in as
> later profile / follower-list / account-reputation work landed — `author_post_count`,
> `author_replies_page`, `likes_page`, `search_posts`, `poll` / `poll_choice`, `viewer_states`,
> `follow_edges`, `profile` (its `ProfileView` carries `account_tally`, the account-reputation-vote surface),
> `resolve_identity`, `search_people`, and `who_to_follow`; the runtime fills author
> profiles from pallet-profile (keeping the pallet free of a profile dependency). The client (`node-reads.ts`)
> runtime-detects the API (`isCompatible`), prefers it, and keeps the keyed reads as the pre-120 fallback,
> chasing `next_cursor` to fill a page so the node path matches the keyed path's full-page semantics. An
> adversarial review hardened four parity edges: a thread ancestor-cycle guard (mirrors the client), the full
> followee set read (no silent `MAX_FOLLOWEES` drop), all direct replies in `thread` (parity with the client),
> and an empty-followee short-circuit.

> **Implementation note (Feature 3).** A reply-free top-level spine — `TopLevelPosts` (seq → post id),
> `NextTopLevelSeq` (the counter / global top-level count) and `TopLevelByAuthor` — maintained O(1) on every
> top-level creation site (`post_message` `parent==None` / `quote_post` / `create_poll`) and backfilled by
> `MigrateV3ToV4`. `feed_page` / `following_feed_page` now page the seq spine (`feed_page` is exact-N: one read
> per returned post, no reply over-scan); `author_feed_page` pages `TopLevelByAuthor`; a new `author_post_count`
> runtime API gives the client the correct top-level profile `postCount` (keyed `ByAuthor` fallback pre-121).
> The feed cursor is now a `TopLevelPosts` seq — opaque + endpoint-scoped (never cross-wire it with the
> author cursor, a post id). An adversarial review added the migration backfill==live-path parity test, a
> density/order `post_upgrade` invariant, and `index_top_level` weight accounting.

## Why (and why this is the *right* next scale step)

spec 119 finished the **on-chain data model**: every list the app reads is now either an O(1) aggregate
(`VoteTally`, `RepostCount`, `ReplyCount`, `FollowerCount`, `FollowingCount`, `PollTally`) or a
single-key, prefix-iterable reverse index (`ByAuthor`, `RepliesByParent`, `Followers`, `Following`,
`VotesByAccount`, `Reposts`, `PollVotes`). Nothing on chain folds the whole post/account set. In big-O
terms the model is already as scalable as it gets — you can't denormalize further.

What is **not** node-served is the *read orchestration*. The client assembles a page by making **N+
separate JSON-RPC storage reads** — for a 30-post feed page, `enrichPosts` fires ~5 reads per post
(tally + repost + reply-count + poll + author profile) ≈ **150 round-trips**, plus a per-card
`Reposts.getEntries(post)` scan in `useViewerStates` because the unit-valued `Reposts` map can't be
point-read over PAPI. That is the scaling ceiling now: latency × round-trips, not algorithmic cost.

This spec moves the read loop **into the runtime** so a whole enriched, viewer-aware page comes back in
**one `state_call`**, atomic at one block. It is the move that makes "the node serves the feed" literally
true, and it needs no external indexer (the follow graph + all aggregates already live on chain).

## Feature 1 (PRIMARY) — a `MicroblogApi` read Runtime API

A custom `sp_api` Runtime API on `pallet-microblog`, implemented in `runtime/src/apis.rs`. The in-repo
template is `pallet_cardano_observer::CardanoObserverApi` (`pallets/cardano-observer/src/lib.rs:225` →
`sp_api::decl_runtime_apis!`, wired at `runtime/src/apis.rs:268`).

### Surface (sketch — finalize during implementation)

```rust
sp_api::decl_runtime_apis! {
    pub trait MicroblogApi<AccountId> where AccountId: Codec {
        /// Global "For-you": top-level posts, newest-first, paged by id below `before_id`
        /// (None ⇒ from the head). `viewer` (when Some) stamps my_vote/reposted per post.
        fn feed_page(before_id: Option<u64>, limit: u32, viewer: Option<AccountId>) -> FeedPage<AccountId>;
        /// One author's top-level posts (profile Posts tab), same paging + viewer semantics.
        fn author_feed_page(author: AccountId, before_id: Option<u64>, limit: u32, viewer: Option<AccountId>) -> FeedPage<AccountId>;
        /// The Following timeline: merge `ByAuthor[followee]` over `Following[viewer]`, newest-first.
        fn following_feed_page(viewer: AccountId, before_id: Option<u64>, limit: u32) -> FeedPage<AccountId>;
        /// A reconstructed thread: focal + ancestor chain (depth-capped) + direct replies, all enriched.
        fn thread(focal: u64, viewer: Option<AccountId>) -> Thread<AccountId>;
    }
}
```

`EnrichedPost` carries everything a card renders in one shot: `id, author, text, parent, quote, at`,
the tally (`up_weight, down_weight, up_count, down_count`), `repost_count, reply_count, is_poll`, the
viewer overlay (`my_vote: Option<VoteDir>, reposted: bool`), author `display_name`/`avatar`, and a
one-level resolved `quoted` summary. `FeedPage { posts: Vec<EnrichedPost>, next_cursor: Option<u64> }`.

### Why this subsumes the per-card repost scan

The unit-value ambiguity is a **PAPI-client decode** problem, not a runtime one: in wasm,
`Reposts::contains_key(id, who)` and `Votes::get(id, who)` are clean. So when `viewer` is `Some`, the API
returns `reposted: bool` / `my_vote` computed node-side — and `useViewerStates`' per-card
`Reposts.getEntries` scan **disappears entirely**. (This is why Feature 2 below is *optional* once this
lands.)

### Bounds / safety

- Hard-cap `limit` (e.g. `MAX_PAGE = 100`); clamp, don't error.
- `feed_page`/`author_feed_page` bound the id-scan: cap ids examined per call (e.g. `MAX_SCAN = limit ×
  k`) and return `next_cursor` at the last examined id so the client can continue — **no unbounded walk**
  even on a reply-dense range. Feature 3 removes the over-scan entirely.
- `following_feed_page` bounds the followee fan-in (cap followees merged per call; document the cap).
- Runtime APIs aren't gas-metered (they're off-chain `state_call`s with a node-side memory/time budget),
  so bounding is the implementer's responsibility — there is no extrinsic weight, but keep the read loop
  tight and the output `MaxEncodedLen`-bounded in spirit.

### Client wiring

- Bump `spec_version` 119 → **120** (`runtime/src/lib.rs`); leave `transaction_version` at 3.
- Regen PAPI descriptors against a 120 node (the new api hash lands in `apis`): `rm
  app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://<LIVE_WS>)`.
- PAPI calls it as `api.apis.MicroblogApi.feed_page(...)`. Add a `caps.nodeFeedApi` flag to the
  PAPI-direct `FeedSource`; `reads.ts` prefers the API when present and keeps today's keyed reads as the
  fallback path (so a pre-120 node still works).

## Feature 2 (OPTIONAL — only if we want point-reads WITHOUT the API) — `Reposts` point-readability

Today `Reposts: DoubleMap<(post, who), ()>`. PAPI can't distinguish `Some(())` from `None`, forcing the
`getEntries` scan. Fix by changing the value to a non-unit (e.g. `BlockNumberFor<T>` = when reposted, or
a `bool`) so `getValue(post, who)` decodes cleanly. **Encoding change ⇒ a migration** to re-encode
existing `Reposts` rows. **Skip this if Feature 1 ships** — the API already returns a clean `reposted`.

## Feature 3 (FOLLOW-UP) — a top-level-post index

`Posts` interleaves replies and top-level posts in one id space, so top-level paging over-scans (reads
past replies) and the profile `postCount` counts replies. Add:

- `TopLevelPosts: StorageMap<u64 /*seq*/, u64 /*post id*/>` + a `NextTopLevelSeq` counter — a dense,
  reply-free sequence so `feed_page` reads **exactly N** with no over-scan.
- `TopLevelByAuthor: StorageMap<AccountId, BoundedVec<u64>>` (or reuse `ByAuthor` filtered) + an O(1)
  `TopLevelCount` aggregate — exact-N profile paging and a **correct** top-level post count (fixes the
  documented `postCount`-counts-replies tradeoff at the source instead of in the UI).

Maintained O(1) on `post_message` (append on a top-level post). Additive maps ⇒ a one-time backfill
migration (same shape as `MigrateV2ToV3`).

## Migration + spec-bump discipline

- Features 1 (new maps? no — API only) needs **no** storage migration; just the spec bump + api hash.
- Feature 3 adds maps ⇒ a versioned backfill migration (`MigrateV3ToV4`-style), gated on the pallet
  storage version, wired into `SingleBlockMigrations`, with try-runtime pre/post invariants.
- Feature 2, if done, needs a re-encode migration.
- One spec bump (→120) covers whichever features land together. Bump `spec_version` only; regen
  descriptors after deploy; **do not** bump `transaction_version`.

## Testing / acceptance

- Pallet unit tests for each API method (hand-rolled state, mirror `pallets/microblog/src/tests.rs`):
  paging boundaries + `next_cursor`, reply-skipping, viewer overlay correctness, thread reconstruction,
  empty/None cases, `limit`/scan caps.
- A Rust↔TS parity check: the API page must equal the existing keyed-read page (same ids, same
  aggregates) so the fallback path can't drift from the API path.
- `cargo test` (pallet) + `cargo build --release` (wasm links under rustc 1.93.0) + `app` gates
  (`tsc`/`lint`/`vitest`) + the static-export `npm run build` (the only check that catches the
  `@vercel/nft` BigInt trap) before any push.

## Non-goals / guardrails

- **Do not touch `contracts/`** (Aiken vault is live on preprod — any edit moves its hash).
- **Do not renumber pallet indices** (indices 6 and 12 permanently vacant; 7 is GovernedUpgrade).
- This is a **read** API — no privileged calls, no committee path involved.
- Cross-account aggregations (who-to-follow, search) are node-served too now — the external SubQuery
  indexer that formerly handled them has since been removed; this spec covers the *primary
  feed/thread/profile reads*, which the node likewise serves itself.
