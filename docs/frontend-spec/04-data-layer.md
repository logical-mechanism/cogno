# 04 — Data Layer & State

This document is the **contract between the UI and the chain**. It owns *how every surface reads and writes*: the
`FeedSource` read seam (extended with the spec-116 social reads — votes, reposts, quotes, polls, follows, profiles,
and the viewer's own vote/repost/follow state), a `mutations` module that maps every user action to its exact
extrinsic with an optimistic-update + rollback pattern, the **capacity-as-rate-limit** model (no battery — graceful
`RateLimitNotice`), the full **hooks inventory** (which existing hooks are reused, which are new), and the
**identity/session state machine** (logged-out → connected-not-bound → bound) that gates write affordances across
the app. It is the single source of truth other docs cite for query names, hook signatures, mutation names, and
session states. Sibling docs to coordinate with: `01-information-architecture.md` (routes/static-export),
`02-design-system.md` (tokens, `RateLimitNotice`, `Toaster/Toast`), `01-information-architecture.md` (app shell) +
`03-component-library.md` §22.7 (`AppShell`, session gating), and the per-surface docs `06-surface-home.md`,
`07-surface-profile.md`, `08-surface-thread.md`, `09-surface-compose.md`, `10-surface-explore-search.md`,
`11-surface-onboarding-auth.md`, `12-surface-settings.md`.

> **Inherited reality (from SHARED GROUNDING + LOCKED DECISIONS).** Runtime **spec_version 116**. Frontend is a
> **Next.js 14 static export** (`output:'export'`) — no server, no SSR, no API routes; every read/write is a
> browser-side PAPI/GraphQL call. The honesty/trust layer is **dropped**: no "signed ≠ finalized" marginalia, no
> block numbers in the UI chrome, no "operator-run" labels. We surface only two chain realities to the user:
> **(a)** a graceful rate-limit message when talk-capacity is exhausted, and **(b)** a quiet failure toast on tx
> error. UI is **optimistic**: the post/like/repost appears immediately and reconciles or rolls back. We keep
> **CSS Modules + `--cg-*` tokens** (no Tailwind) and the existing `FeedSource` seam (extend, don't replace).

---

## 0. Module map (what this doc governs)

| Path | Role | Status |
|---|---|---|
| `app/src/lib/types.ts` | shared shapes (the deterministic seam) | **extend** (add social fields; delete `deleted`) |
| `app/src/lib/feed/source.ts` | `FeedSource` interface + `FeedCaps` | **extend** (new caps + reads) |
| `app/src/lib/feed/index.ts` | `makeFeedSource(api, graphqlUrl)` selector | reuse as-is |
| `app/src/lib/feed/papi-source.ts` | PAPI-direct reader (fallback) | **extend** (derive social fields from storage) |
| `app/src/lib/graphql/feed-source.ts` | indexer reader | **extend** (new queries → social fields) |
| `app/src/lib/graphql/queries.ts` | the exact GraphQL strings | **rewrite** (delete `deleted`; add social) |
| `app/src/lib/chain/post.ts` | `watchTx` phase stream + `submitPost` | reuse; generalize event name |
| `app/src/lib/chain/identity.ts` | feeless bare binds + gate reads | reuse as-is |
| `app/src/lib/chain/capacity.ts` | capacity replay (advisory) | reuse as-is |
| `app/src/lib/chain/reads.ts` | live storage reads | **extend** (social storage maps) |
| **`app/src/lib/chain/mutations.ts`** | **NEW** — all write actions → extrinsics | **create** |
| **`app/src/lib/chain/social-reads.ts`** | **NEW** — PAPI-direct social tallies | **create** |
| `app/src/hooks/*` | React hooks | reuse 9, **add 14** (§7) |

**Core principle (unchanged):** the React layer **only ever touches the seam types** (`lib/types.ts`) and the
hooks. It never imports a concrete reader or builds a raw extrinsic; readers are swapped by `makeFeedSource`, writes
go through `lib/chain/mutations.ts`. This keeps the static-export bundle reader-agnostic and lets the indexer be
non-load-bearing (clearing the GraphQL endpoint silently falls back to PAPI-direct).

---

## 1. The `deleted` bug — REMOVE IT EVERYWHERE

`Microblog.delete_post` was removed at spec 113 (**content is permanent**); the indexer schema dropped
`Post.deleted`. Nothing is ever deleted — only **authors** are flagged `banned` (after `Revoked`), and their posts
**stay**. Every `deleted` reference in the FE is a query against a non-existent column and **will throw a GraphQL
error**. Delete all of them:

- `lib/graphql/queries.ts`: remove `deleted` from `FEED`, `PROFILE_BY_IDENTITY`, `PROFILE_BY_ACCOUNT`, `THREAD`.
- `lib/graphql/feed-source.ts`: remove `deleted` from `FeedNode` / `AuthorPostNode` / `ThreadResponse`; remove
  `deleted: n.deleted === true` from `nodeToPost`/`authorPostToPost`; remove `feedFilter`'s
  `{ deleted: { equalTo: false } }` (the filter object keeps `text`/`authorId` only, and may be `{}`); remove the
  `{ deleted: { equalTo: false } }` filter from `watch()`'s poll.
- `lib/types.ts`: delete the `deleted?: boolean` field on `CognoPost` (keep `authorRevoked` — that is the real,
  surviving "this author was banned, posts remain" flag).

> **Rationale (one line):** there is no soft-delete; the only mutable author state is `banned`. The UI never hides a
> banned author's posts at the data layer — surfacing/dimming a banned author is a **presentation** choice
> (`02-design-system.md` defines the muted treatment); the data layer just carries `authorRevoked`.

---

## 2. READS — extend the `FeedSource` seam

### 2.1 Extended seam types (`lib/types.ts`)

Add the social fields the new surfaces need. These are **additive**; both readers (indexer + PAPI-direct) implement
them, the indexer fully and the PAPI-direct reader as far as direct storage allows (gated by `caps`, §2.3).

```ts
/** A 0-indexed poll option with its stake-weighted tally. */
export interface PollOptionView {
  index: number;          // 0..=3
  label: string;          // UTF-8 option text (<= 80 bytes)
  weight: bigint;         // sum of weight snapshots currently choosing this option
  count: number;          // accounts currently choosing this option
}

/** A poll attached to a host post (Poll.id == host post id). */
export interface PollView {
  hostId: bigint;         // == the post id that IS the poll question
  options: PollOptionView[];
  totalWeight: bigint;    // sum over options (for percent bars)
  totalCount: number;
}

/** A compact reference to a quoted post for the QuotedPostEmbed (no recursion). */
export interface QuotedRef {
  id: bigint;
  author: Ss58;
  text: string;
  authorRevoked: boolean;
  displayName?: string;   // resolved from Profile when available (indexer only)
  avatar?: string;
}

/** The viewer's own relationship to a post — drives the active/filled action icons. */
export interface ViewerPostState {
  myVote: "Up" | "Down" | null;   // null = not voted
  reposted: boolean;              // permanent once true
}
```

Extend `CognoPost` (additive; all optional so a partial reader can omit them):

```ts
export interface CognoPost {
  id: bigint;
  author: Ss58;
  text: string;
  parent?: bigint;          // reply target (Twitter "in reply to")
  at: number;               // blockHeight (NOT timestamp; the chrome never shows it — §intro)
  authorRevoked?: boolean;  // author banned; posts STAY (FLAG, never drop)
  // ── spec-116 social (indexer-derived; PAPI-direct fills what storage allows) ──
  quote?: QuotedRef;        // present iff this post quotes another (Post.quote on-chain)
  isPoll?: boolean;         // true iff a PollCreated fired for this id; fetch options via poll(hostId)
  upWeight?: bigint;        // stake-weighted up tally
  downWeight?: bigint;      // stake-weighted down tally
  upCount?: number;
  downCount?: number;
  score?: bigint;           // upWeight - downWeight (MAY be negative)
  repostCount?: number;     // permanent; only increments
  replyCount?: number;      // count of direct replies (Post.replies length / totalCount)
  // ── profile snapshot of the author (indexer convenience; avoids N+1 on the timeline) ──
  authorDisplayName?: string;
  authorAvatar?: string;
  authorWeight?: bigint;    // posting power (lovelace); null/undefined until staked
}
```

> **`deleted` is GONE** (§1). Do not re-add it.

Extend `FeedCaps` so the UI only lights up affordances a reader can honestly serve:

```ts
export interface FeedCaps {
  search: boolean;       // substring search over bodies              (indexer-only)
  pagination: boolean;   // cursor (after) pagination                  (indexer-only)
  threads: boolean;      // root + replies reconstruction              (both)
  revocation: boolean;   // author-banned flagging                     (both)
  // ── NEW ──
  tallies: boolean;      // vote/poll weight tallies + counts          (indexer-only*)
  follows: boolean;      // follow edges + follower/following counts   (indexer-only)
  profiles: boolean;     // display name / bio / avatar / pinned       (indexer-only)
  whoToFollow: boolean;  // ranked suggestion list                     (indexer-only)
}
```

> `tallies` PAPI-direct caveat: the PAPI reader *can* read `VoteTally`/`PollTally`/`Reposts`/`Votes` storage
> directly (§2.4), so it **can** set `tallies: true`. The reason `follows`/`profiles`/`whoToFollow` are
> indexer-only is that they need reverse-index aggregation (counts, ranked lists) the node cannot serve cheaply.
> Set the PAPI-direct caps to: `{ search:false, pagination:false, threads:true, revocation:true, tallies:true,
> follows:false, profiles:false, whoToFollow:false }`. The indexer caps are **all `true`**.

Add the seam methods on `FeedSource` (the React layer calls these via hooks, never the readers directly):

```ts
export interface FeedSource {
  kind: "papi" | "graphql";
  caps: FeedCaps;
  watch(): Observable<FeedSnapshot>;
  page(q: FeedQuery): Promise<FeedPage>;
  thread(rootId: bigint): Promise<ThreadView>;
  profile(args: ProfileArgs): Promise<ProfileView>;
  // ── NEW ──
  poll(hostId: bigint): Promise<PollView>;                       // gated on caps.tallies
  viewerPostState(post: bigint, who: Ss58): Promise<ViewerPostState>; // gated on caps.tallies
  followEdges(who: Ss58): Promise<FollowEdges>;                  // gated on caps.follows
  whoToFollow(who: Ss58 | null, limit: number): Promise<Suggestion[]>; // gated on caps.whoToFollow
  searchPeople(q: string, limit: number): Promise<Suggestion[]>; // author search by displayName; gated on caps.search && caps.profiles
}
```

with:

```ts
export interface FollowEdges {
  followers: Ss58[];        // accounts following `who`
  following: Ss58[];        // accounts `who` follows
  followerCount: number;
  followingCount: number;
}
export interface Suggestion { author: Ss58; displayName?: string; avatar?: string; weight?: bigint; followerCount: number; }
```

`FeedQuery` gains a discriminator for the home tabs and the profile tabs (the indexer applies it as a `filter` +
`orderBy`; PAPI-direct supports only the unfiltered live feed):

```ts
export interface FeedQuery {
  first?: number;
  after?: FeedCursor;
  search?: string;             // indexer-only
  authorId?: Ss58;             // scope to one author (profile)
  identityHash?: string;
  // ── NEW ──
  tab?: "forYou" | "following" | "replies" | "likes"; // see §2.2 / §2.6
  followeeOf?: Ss58;           // "Following" timeline: posts by accounts this user follows
  order?: "recency" | "score"; // forYou default recency; "score" = top (indexer orderBy SCORE_DESC)
}
```

### 2.2 Home timeline — `FEED` (For you / Following)

**For you** = recency (or top-by-score). **Following** = posts authored by accounts the viewer follows
(via `Follow` edges).

The canonical `FEED` query (cursor-paginated; **no `deleted`**), enriched with social fields and author profile
snapshots:

```graphql
query Feed($first: Int!, $after: Cursor, $orderBy: [PostsOrderBy!], $filter: PostFilter) {
  posts(first: $first, after: $after, orderBy: $orderBy, filter: $filter) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges {
      cursor
      node {
        id
        authorId
        text
        parentId
        blockHeight
        isPoll
        upWeight downWeight upCount downCount score repostCount
        author { id banned identityHash weight displayName avatar }
        quote { id text author { id banned displayName avatar } }
      }
    }
  }
}
```

- **orderBy:** `["ID_DESC"]` for `order:"recency"` (newest-first by post id; stable, equals time order on a single
  chain); `["SCORE_DESC", "ID_DESC"]` for `order:"score"` (top). `TIMESTAMP_DESC`/`BLOCK_HEIGHT_DESC` also exist
  but `ID_DESC` is the stable default the existing code uses — keep it.
- **filter (For you):** omit `parentId` filtering — top-level + replies both appear, matching Twitter's "For you"
  which surfaces replies too. (If a doc wants top-level-only, add `parentId: { isNull: true }`.)
- **filter (Following):** the indexer has no single `followeeOf` filter. Resolve the followee set first via
  `followEdges(who).following`, then page with `filter: { authorId: { in: $followees } }`. The frontend caps the
  `in`-list at 1000 accounts (Following timelines beyond that paginate the followee set — out of v1 scope; note it).
  `order:"recency"`.
- **search** is spliced into `filter` as `text: { includesInsensitive: $term }` (substring; indexer-only).
- **`quote`** is a **shallow** embed (one level — no recursion). `QuotedPostEmbed` renders `quote.text` +
  `quote.author`. A quote-of-a-quote shows only the immediate quoted post.

**`nodeToPost` mapping** (extend the existing function):

```ts
function nodeToPost(n: FeedNode): CognoPost {
  return {
    id: BigInt(n.id),
    author: n.authorId,
    text: n.text,
    parent: n.parentId == null ? undefined : BigInt(n.parentId),
    at: n.blockHeight,
    authorRevoked: n.author?.banned === true,
    isPoll: n.isPoll === true,
    upWeight: BigInt(n.upWeight), downWeight: BigInt(n.downWeight),
    upCount: n.upCount, downCount: n.downCount,
    score: BigInt(n.score), repostCount: n.repostCount,
    authorDisplayName: n.author?.displayName ?? undefined,
    authorAvatar: n.author?.avatar ?? undefined,
    authorWeight: n.author?.weight == null ? undefined : BigInt(n.author.weight),
    quote: n.quote == null ? undefined : {
      id: BigInt(n.quote.id),
      author: n.quote.author.id,
      text: n.quote.text,
      authorRevoked: n.quote.author.banned === true,
      displayName: n.quote.author.displayName ?? undefined,
      avatar: n.quote.author.avatar ?? undefined,
    },
  };
}
```

> **u64 discipline:** `id`/`parentId`/`quote.id` are strings → `BigInt(...)`; `upWeight`/`downWeight`/`score`/
> `weight` are `BigInt`-strings → `BigInt(...)`. **Never** `Number(...)` a u64/u128 (lovelace > 2^53).

**PAPI-direct fallback (For you):** the existing `watchFeed`-derived `page()` returns the live snapshot (no search,
no cursor). It already excludes nothing; enrich each post with tallies from storage (`social-reads.ts`, §2.4) when
`caps.tallies` — but to keep the timeline cheap, the PAPI-direct timeline renders tallies **lazily per visible
card** (§2.4) rather than eagerly for all 50. **Following** is **unsupported** on PAPI-direct (`caps.follows:false`)
— the UI hides the *Following* tab when the active source is PAPI-direct (see §2.7 gating table).

### 2.3 Capability gating (which affordances light up)

The UI reads `source.caps` and disables/hides affordances a reader cannot serve. The canonical table other docs
cite:

| Affordance | indexer (`graphql`) | PAPI-direct (`papi`) | Gated by cap |
|---|:--:|:--:|---|
| Live home feed (For you) | ✅ (poll) | ✅ (`watchEntries`) | always |
| Search (`/explore`) | ✅ | ❌ hide SearchBar results | `search` |
| Cursor "load more" | ✅ | ❌ single snapshot | `pagination` |
| Thread (post + replies) | ✅ | ✅ | `threads` |
| Banned-author flag | ✅ | ✅ | `revocation` |
| Like/score counts on cards | ✅ eager | ✅ lazy per-card | `tallies` |
| Poll options + % bars | ✅ | ✅ (read `Polls`+`PollTally`) | `tallies` |
| Following timeline tab | ✅ | ❌ hide tab | `follows` |
| Follower/Following counts | ✅ | ❌ omit on profile | `follows` |
| Display name / bio / avatar | ✅ | ❌ fallback to ss58 + identicon | `profiles` |
| Who-to-follow (RightRail) | ✅ | ❌ hide RightRail block | `whoToFollow` |

> **Honesty without honesty-labels:** we do *not* show a "reads: indexer" badge (the trust layer is dropped). We
> simply **hide** what a reader cannot serve. When the active reader is PAPI-direct, the *Following* tab,
> *who-to-follow* rail, and profile counts are absent — not greyed with an explanation. The user configures the
> indexer endpoint silently in `/settings`.

### 2.4 PAPI-direct social reads (`lib/chain/social-reads.ts`, NEW)

The node serves per-post tallies and the viewer's own state from storage, so the PAPI-direct reader can set
`caps.tallies:true`. Storage maps (confirmed in `pallets/microblog`):

| Read | Storage | Returns |
|---|---|---|
| up/down tally for a post | `Microblog.VoteTally(post_id)` | `{ up_weight, down_weight, up_count, down_count }` (u128/u32) |
| viewer's vote on a post | `Microblog.Votes(post_id, who)` | `Option<{ dir: VoteDir, weight: u128 }>` |
| repost count | `Microblog.RepostCount(post_id)` *(or count `Reposts` double-map)* | u32 |
| viewer reposted? | `Microblog.Reposts(post_id, who)` | `Option<()>` present ⇒ reposted |
| poll options | `Microblog.Polls(host_id)` | `{ options: Vec<BoundedVec<u8>> }` (labels) |
| poll tally per option | `Microblog.PollTally(host_id)` | `Vec<{ weight, count }>` indexed by option |
| viewer's poll choice | `Microblog.PollVotes(host_id, who)` | `Option<{ option: u8, weight: u128 }>` |
| author's posts | `Microblog.ByAuthor(account)` | `Vec<u64>` |
| post body/quote/parent | `Microblog.Posts(id)` | `{ author, text, parent?, quote?, at }` |

> **Field names are PAPI-decoded snake_case structs.** Confirm exact storage item names against the live metadata
> at implementation time (`api.query.Microblog.*`); the names above match the pallet. If a `VoteTally`/`PollTally`
> aggregate map is absent, the PAPI reader falls back to setting `tallies:false` (counts hidden) — **never** iterate
> all `Votes` entries to sum a tally on the client (O(votes) per card is unacceptable). Prefer the aggregate maps.

`social-reads.ts` exports pure async functions:

```ts
export async function readPostTally(api, id: bigint): Promise<{ upWeight: bigint; downWeight: bigint; upCount: number; downCount: number; score: bigint }>;
export async function readRepostCount(api, id: bigint): Promise<number>;
export async function readViewerPostState(api, id: bigint, who: Ss58): Promise<ViewerPostState>;
export async function readPoll(api, hostId: bigint): Promise<PollView>;        // Polls + PollTally
export async function readViewerPollChoice(api, hostId: bigint, who: Ss58): Promise<number | null>;
```

The PAPI-direct `poll()`/`viewerPostState()` seam methods delegate to these. `followEdges`/`whoToFollow`/`searchPeople`/`profile`
display fields **throw `UnsupportedQuery`** on PAPI-direct (the caps already tell the UI not to call them —
`searchPeople` is gated on `caps.search && caps.profiles`, both `false` PAPI-direct).

### 2.5 Explore / search — `FEED` with `$search`

`/explore` reuses `FEED` with `filter.text = { includesInsensitive: $term }` and `orderBy:["ID_DESC"]` (recency) or
`["SCORE_DESC","ID_DESC"]` (top). Empty term ⇒ the explore default list (top posts by score over the recent set —
`order:"score"`). Gated on `caps.search`; PAPI-direct hides the result list and shows an `EmptyState`:
"Search needs the indexer — set a GraphQL endpoint in Settings." (one-line, not a trust disclaimer).

### 2.6 Profile — `PROFILE_BY_ACCOUNT` / `PROFILE_BY_IDENTITY` (+ tabs)

The profile page (`/u/[address]`) reads an `Author` by ss58 (primary) or by identity hash (secondary). Rewrite the
queries to add profile + social fields and the three tabs (**Posts / Replies / Likes** — no Media tab; the chain
has no media, see `02-design-system.md` `ProfileTabs`):

```graphql
query ProfileByAccount($ss58: String!, $first: Int!, $after: Cursor) {
  author(id: $ss58) {
    id banned identityHash weight
    displayName bio avatar pinnedPostId
    postCount followerCount followingCount
    posts(first: $first, after: $after, orderBy: ID_DESC) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id text parentId blockHeight isPoll
        upWeight downWeight upCount downCount score repostCount
        quote { id text author { id banned displayName avatar } }
      }
    }
  }
}
```

- **Posts tab:** `posts` filtered to `parentId: { isNull: true }` (top-level authored posts + quotes + polls).
- **Replies tab:** `posts` filtered to `parentId: { isNotNull: true }` (this author's replies). `tab:"replies"`.
- **Likes tab:** the author's up-votes — query `Vote` where `voterId == ss58 && dir == "Up"`, then resolve each
  `post`. `tab:"likes"`. (Down-votes are not "likes"; only `dir:"Up"` shows in Likes — matches the
  Like==up-vote modeling.) Query:
  ```graphql
  query Likes($ss58: String!, $first: Int!, $after: Cursor) {
    votes(filter: { voterId: { equalTo: $ss58 }, dir: { equalTo: "Up" } },
          first: $first, after: $after, orderBy: ID_DESC) {
      pageInfo { hasNextPage endCursor }
      nodes { post { id text authorId blockHeight isPoll upWeight downWeight upCount downCount score repostCount
                     author { id banned displayName avatar weight } } }
    }
  }
  ```
- `pinnedPostId` is a **bare string id**, not validated on-chain; the profile header fetches that single post via
  `getPost`/a one-post query and renders it pinned at top (or omits it silently if it 404s).

**PAPI-direct profile** (existing `papi-source.profile`): resolves the account, reads `ByAuthor` → posts; sets
`banned` from `PkhOf` absence, `weight` from `TalkStake.AllowedStake`, `identityHash` from `PkhOf`. It **cannot**
serve `displayName`/`bio`/`avatar`/`followerCount`/`followingCount` (`caps.profiles:false`, `caps.follows:false`)
— the profile header falls back to truncated-ss58 `DisplayName` + identicon `Avatar` and **omits** follower/following
counts. Replies/Likes tabs are unavailable PAPI-direct (Likes needs the `Vote` reverse index) — hide those tabs.

> **Profile display fields come from `pallet-profile@17`** but on the **indexer** they live denormalized on
> `Author` (the indexer folds `ProfileSet`/`ProfileCleared`). The FE never reads `Profile.Profiles` storage for
> *display* in the indexer path; only the PAPI-direct fallback reads chain storage, and it omits them.

### 2.7 Thread — `THREAD` (post + replies recursion)

`/post/[id]` shows the root + its conversation. The indexer `THREAD` query (rewritten, no `deleted`, with tallies +
quote + the parent chain for "replying to"):

```graphql
query Thread($rootId: String!) {
  post(id: $rootId) {
    id authorId text parentId blockHeight isPoll
    upWeight downWeight upCount downCount score repostCount
    author { id banned identityHash weight displayName avatar }
    quote { id text author { id banned displayName avatar } }
    parent { id authorId text author { id banned displayName avatar } }   # "Replying to @..." context
    replies(orderBy: ID_ASC) {
      totalCount
      nodes {
        id authorId text parentId blockHeight isPoll
        upWeight downWeight upCount downCount score repostCount
        author { id banned displayName avatar }
        quote { id text author { id banned displayName avatar } }
      }
    }
  }
}
```

- **Replies are direct children only** (`Post.replies` via `parent` reverse relation). Depth-2+ replies are fetched
  by navigating into that reply's own `/post/[id]` (lazy, Twitter-style) — the v1 ThreadView is **root + 1 level**.
  Note the follow-up: a recursive `ThreadView` (full conversation tree) is a clean later addition; mark it.
- `ThreadView.lastActivity` = max `blockHeight` over root+replies. The UI never *shows* it (no block numbers), but
  the indexer may use it for ordering — keep the field, don't render it.

**PAPI-direct thread** (existing): `getPost(root)` + `buildThreadIndex(snapshot)` grouped by `parent`. Dangling
replies (parent absent from the snapshot window) are still grouped and rendered under a subtle "in reply to a post
not loaded" affordance (never dropped). Enrich each rendered card's tally lazily (§2.4).

### 2.8 Poll state — `POLL`

A poll's **question is the host post**; only options + tallies live on `Poll`/`PollOption`. After rendering a card
with `isPoll:true`, fetch the poll by host id:

```graphql
query Poll($hostId: ID!) {
  poll(id: $hostId) {
    id
    options(orderBy: INDEX_ASC) { index label weight count }
    votes { totalCount }
  }
}
```

Map → `PollView`: `options[i] = { index, label, weight: BigInt, count }`, `totalWeight = Σ weight`,
`totalCount = Σ count`. `PollCard` renders **stake-weighted percent bars** = `weight / totalWeight` (NOT
vote-count percent — the chain weights by stake; one-line rationale: a poll result is the *stake-weighted* will,
matching votes). Show `count` as a secondary "(N voters)" line. **No expiry** — polls never close (no on-chain
deadline); the UI shows results live and always allows `cast_poll_vote` (re-cast replaces). Note the divergence:
Twitter polls close after a duration; **ours never close** — render "Final results" never; always "Live results".

**PAPI-direct poll** (`readPoll`): read `Microblog.Polls(hostId)` for labels + `Microblog.PollTally(hostId)` for
`{weight,count}` per index; assemble `PollView`. `caps.tallies:true` covers this.

### 2.9 Viewer's own state — `viewerPostState` / `VIEWER_VOTE` / `VIEWER_REPOST`

To render the **filled heart** (you liked it) and the **active repost** icon, the card needs the viewer's own
vote/repost on each post. Two strategies, both behind `viewerPostState(post, who)`:

- **indexer:** batch-query the viewer's votes/reposts for the visible post-id set:
  ```graphql
  query ViewerStates($who: String!, $postIds: [String!]!) {
    votes(filter: { voterId: { equalTo: $who }, postId: { in: $postIds } }) {
      nodes { postId dir }
    }
    reposts(filter: { reposterId: { equalTo: $who }, postId: { in: $postIds } }) {
      nodes { postId }
    }
  }
  ```
  Map to a `Map<bigint, ViewerPostState>`; absence ⇒ `{ myVote:null, reposted:false }`.
- **PAPI-direct:** `readViewerPostState(api, id, who)` reads `Microblog.Votes(id, who)` (Option) + `Reposts(id, who)`
  (Option). For a list, batch with `Promise.all` over visible ids (lazy per-card).

> Optimistic writes (§3) update this state **immediately**; the read is the reconciliation source of truth.

### 2.10 Who-to-follow — `WHO_TO_FOLLOW`

`RightRail` shows ranked suggestions (indexer-only). Rank by `followerCount` desc among authors the viewer does not
already follow and is not themselves:

```graphql
query WhoToFollow($limit: Int!) {
  authors(filter: { banned: { equalTo: false }, postCount: { greaterThan: 0 } },
          orderBy: FOLLOWER_COUNT_DESC, first: $limit) {
    nodes { id displayName avatar weight followerCount }
  }
}
```

The hook (`useWhoToFollow`, §7) filters out the viewer + already-followed ids client-side (using
`followEdges(who).following`). PAPI-direct: `caps.whoToFollow:false` ⇒ `RightRail` omits the block. Note the
follow-up: a smarter "followed-by-people-you-follow" suggestion is a later addition.

### 2.11 Live `watch()` reconciliation

The live feed (`useFeed`) keeps polling (indexer, 6 s) / `watchEntries` (PAPI). Optimistic writes (§3) live in a
separate **pending overlay** the hooks merge on top of the watched snapshot so an optimistic card is not clobbered
by the next poll before it confirms; on confirmation the overlay entry is dropped (the real row now carries it), on
failure it is rolled back (§3.3). The feed's `watch()` itself is unchanged — reconciliation is a hook-layer concern
(§7 `useOptimisticFeed`).

---

## 3. WRITES — the `mutations` module (`lib/chain/mutations.ts`, NEW)

Every user action maps to **exactly one extrinsic**. This module is the *only* place the FE builds a microblog/
profile/gate call. It is reader-agnostic and returns the honest phase stream (`Observable<TxUpdate>`) or, for the
bare binds, a `Promise<BindResult|StakeLinkResult>` (binds are unsigned and resolve, not stream).

### 3.1 Action → extrinsic table (exact arg shapes)

| Action | Function | Extrinsic | Args | Cost | Submit path |
|---|---|---|---|---|---|
| Post | `submitPost` *(exists)* | `Microblog.post_message` | `{ text: Binary.fromText(s), parent?: bigint }` | **feeless** + capacity | `signSubmitAndWatch` |
| Reply | `submitReply` | `Microblog.post_message` | `{ text, parent: Some(targetId) }` | feeless + cap | sign+watch |
| Quote | `submitQuote` | `Microblog.quote_post` | `{ text: Binary.fromText(s), quoted_id: bigint }` | feeless + cap | sign+watch |
| Like (up-vote) | `submitVote(up)` | `Microblog.vote` | `{ post_id: bigint, dir: { type:"Up" } }` | feeless + cap | sign+watch |
| Down-vote | `submitVote(down)` | `Microblog.vote` | `{ post_id, dir: { type:"Down" } }` | feeless + cap | sign+watch |
| Unlike / clear | `submitClearVote` | `Microblog.clear_vote` | `{ post_id: bigint }` | feeless + cap | sign+watch |
| Repost | `submitRepost` | `Microblog.repost` | `{ post_id: bigint }` | feeless + cap | sign+watch |
| Follow | `submitFollow` | `Microblog.follow` | `{ target: ss58 }` | feeless + cap | sign+watch |
| Unfollow | `submitUnfollow` | `Microblog.unfollow` | `{ target: ss58 }` | feeless + cap | sign+watch |
| Create poll | `submitCreatePoll` | `Microblog.create_poll` | `{ question: Binary.fromText(q), options: Vec<Binary.fromText> }` | feeless + cap | sign+watch |
| Cast poll vote | `submitPollVote` | `Microblog.cast_poll_vote` | `{ post_id: bigint, option: u8 }` | feeless + cap | sign+watch |
| Bind identity | `submitLinkIdentityFeeless` *(exists)* | `CognoGate.link_identity_signed` | `{ cose_sign1, cose_key, thread_pointer? }` | **feeless UNSIGNED bare** | `getBareTx()` + `client.submit` |
| Bind stake | `submitLinkStakeFeeless` *(exists)* | `CognoGate.link_stake_signed` | `{ cose_sign1, cose_key }` | feeless UNSIGNED bare | `getBareTx()` + `submit` |
| Edit profile | `submitSetProfile` | `Profile.set_profile` | `{ display_name: Binary.fromText, bio: Binary.fromText, avatar: Binary.fromText }` | **FEE-BEARING** signed | `signSubmitAndWatch` |
| Clear profile | `submitClearProfile` | `Profile.clear_profile` | `{}` | FEE-BEARING | sign+watch |
| Pin post | `submitPinPost` | `Profile.pin_post` | `{ id: bigint }` | FEE-BEARING | sign+watch |
| Unpin | `submitUnpinPost` | `Profile.unpin_post` | `{}` | FEE-BEARING | sign+watch |

> **VoteDir encoding:** PAPI encodes the runtime `enum VoteDir { Up, Down }` as `{ type: "Up" }` / `{ type: "Down" }`.
> **Poll options:** `Vec<Vec<u8>>` → `options.map(Binary.fromText)`; 2..=4 options, each ≤ 80 **bytes** (validate
> in `09-surface-compose.md` with `ByteCounter`).
> **Byte limits (UTF-8 BYTES, not chars):** post/quote/poll-question ≤ 512; profile `display_name` ≤ 64, `bio` ≤
> 256, `avatar` ≤ 128. Pre-validate with the same UTF-8 byte count the chain enforces (`new TextEncoder().encode(s).length`).

### 3.2 Submit signatures

Feeless/fee-bearing **signed** writes reuse the existing `watchTx` machinery. **Generalize** `post.ts` so
`watchTx`/`extractPostId` accept any event name (today it is hardcoded `"PostCreated"`):

```ts
// lib/chain/mutations.ts
import { Binary } from "polkadot-api";
import { watchTx } from "@/lib/chain/post";   // generalized to (submit, eventName?, fallbackId?)

export function submitPost(api, signer, text: string, parent?: bigint): Observable<TxUpdate>;
export function submitReply(api, signer, text: string, parentId: bigint): Observable<TxUpdate>;   // == submitPost(.., parentId)
export function submitQuote(api, signer, text: string, quotedId: bigint): Observable<TxUpdate>;    // emits PostCreated
export function submitVote(api, signer, postId: bigint, dir: "Up" | "Down"): Observable<TxUpdate>; // emits Voted (no postId out)
export function submitClearVote(api, signer, postId: bigint): Observable<TxUpdate>;                 // emits VoteCleared
export function submitRepost(api, signer, postId: bigint): Observable<TxUpdate>;                    // emits Reposted
export function submitFollow(api, signer, target: Ss58): Observable<TxUpdate>;                      // emits Followed
export function submitUnfollow(api, signer, target: Ss58): Observable<TxUpdate>;                    // emits Unfollowed
export function submitCreatePoll(api, signer, question: string, options: string[]): Observable<TxUpdate>; // emits PostCreated + PollCreated
export function submitPollVote(api, signer, hostId: bigint, option: number): Observable<TxUpdate>;  // emits PollVoted

// fee-bearing (signed) — same stream; the only difference is a tx fee is charged
export function submitSetProfile(api, signer, name: string, bio: string, avatar: string): Observable<TxUpdate>; // ProfileSet
export function submitClearProfile(api, signer): Observable<TxUpdate>;
export function submitPinPost(api, signer, id: bigint): Observable<TxUpdate>;
export function submitUnpinPost(api, signer): Observable<TxUpdate>;

// bare unsigned binds — resolve, not stream (re-exported from identity.ts; see §5)
export { submitLinkIdentityFeeless, submitLinkStakeFeeless } from "@/lib/chain/identity";
```

`watchTx`'s `eventName` parameter becomes a union of the events we extract an id from (`"PostCreated"`); for
vote/repost/follow the id is already known (the caller passed `postId`/`target`), so those pass no event name and
read no id — they only need the phase. Generalize `extractPostId` to accept the pallet event name but keep
`"PostCreated"` as the only id-bearing one (a poll's new id also comes from `PostCreated`, emitted before
`PollCreated`).

### 3.3 Optimistic update + rollback pattern

The locked decision: **optimistic UI**. Each mutation hook (§7) follows this lifecycle:

```
USER CLICK
  1. APPLY optimistic delta to local state immediately:
       like      → myVote="Up",  upCount+1,  upWeight += myVotingPower (snapshot)
       unlike    → myVote=null,  upCount-1,  upWeight -= prevWeight
       down      → myVote="Down",downCount+1,downWeight += myVotingPower
       repost    → reposted=true, repostCount+1
       follow    → following.add(target), followerCount(target)+1
       reply     → insert a pending PostCard (clientId) at top of the thread
       quote     → insert a pending PostCard in the feed
       poll vote → move my weight from prev option to new option; bump count
  2. SUBMIT the extrinsic; subscribe to the TxUpdate phase stream.
  3. ON phase "inBestBlock" (ok): CONFIRM — keep the optimistic delta; for reply/quote/poll,
       swap the pending clientId card for the real id from PostCreated (postId in TxUpdate).
  4. ON phase "finalized": no UI change (we already showed it at inBestBlock — Twitter-speed).
  5. ON phase "invalid" | "error" (incl. rate-limit, dispatch error): ROLL BACK the optimistic
       delta exactly, and raise a Toast (§4 maps the message). Pending cards are removed.
```

Rules:
- **Idempotent guards** mirror the chain: `repost` is permanent — once `reposted`, the button is disabled (the
  chain rejects `AlreadyReposted`; the optimistic UI must not let you double-fire). `follow`/`unfollow` toggle.
  `vote` re-vote **replaces** (optimistically reverse prev weight, apply new). `clear_vote` requires an existing
  vote (`NotVoted` ⇒ rollback).
- **Weight for optimistic tally:** use the viewer's **`votingPower`** snapshot (`TalkStake.VotingPower`, from
  `useIdentity`), not `AllowedStake`. If `votingPower === 0n` (no stake bound), an up-vote still registers as
  `myVote="Up"` and `upCount+1` but adds `0` weight — the chain accepts a zero-weight vote (it counts the voter,
  weight 0). Reconcile from `viewerPostState`/tally read after confirmation.
- **Reconciliation:** after `inBestBlock`, the next feed poll / `viewerPostState` read overwrites the optimistic
  numbers with chain truth (the optimistic snapshot weight may differ from the chain's snapshot). The optimistic
  overlay (§2.11) is keyed by `(postId, action)` and cleared on confirm/fail so the poll's authoritative numbers win.
- **No delete rollback** — there is no delete action.

### 3.4 Tx lifecycle → Toaster states

`watchTx` emits `TxPhase = "signing" | "broadcast" | "inBestBlock" | "finalized" | "invalid" | "error"`. With the
honesty layer dropped, the mapping to `Toaster/Toast` (`02-design-system.md`) is **minimal and Twitter-like**:

| Phase | Toast | Notes |
|---|---|---|
| `signing` | *(none)* | the optimistic UI already showed the action; signing is invisible (wallet popup is its own UX for binds) |
| `broadcast` | *(none)* | silent |
| `inBestBlock` (ok) | *(none, or a subtle success for binds/profile)* | for feeless social actions: **silent success** (Twitter shows nothing when a like lands). For profile/pin (fee-bearing): a brief "Profile updated" success toast |
| `inBestBlock` (invalid) | **error Toast** + rollback | dispatch error → friendly string (§4) |
| `finalized` | *(none)* | no UI change |
| `error` | **error Toast** + rollback | signer rejection / network / rate-limit |

> **Feeless social actions are silent on success** — this is the whole point of optimistic UI. The user sees the
> heart fill instantly; we do **not** toast "Liked!". We toast **only on failure** (the quiet failure toast) and
> on rate-limit (the graceful notice). Fee-bearing profile edits get a small confirming toast because they are
> rarer, deliberate, and have a modal that should close on success.

---

## 4. CAPACITY as a rate limit (no battery)

The decision: **no `CapacityBattery`**. Talk-capacity surfaces only as a **Twitter-style rate-limit message**. The
`CapacityBattery` component is **removed** from the UI; the underlying `lib/chain/capacity.ts` replay is **kept** —
repurposed from a battery gauge to a **pre-flight gate** and a friendly notice.

### 4.1 Pre-flight gate (proactive)

Before enabling the **Post** CTA (and Reply/Quote/Poll submit), `useCapacity` + `draftStatus(view, byteLen, K)`
(both exist) compute whether the current draft is postable:

- `draftStatus` returns one of `ok | no_weight | too_long | charging | wait`. Map to the Composer's submit button +
  `RateLimitNotice`:

| `DraftStatus` | Post button | `RateLimitNotice` copy (Twitter-style; one line) |
|---|---|---|
| `ok` | **enabled** | *(no notice)* |
| `no_weight` (weight 0) | disabled | "Lock ADA to start posting." → links to `/settings` vault (NOT a battery) |
| `too_long` (need > cap) | disabled | "This is too long to post at your current capacity. Shorten it." |
| `charging` (first-touch, regenerating from 0) | disabled | "You are over the rate limit. Try again shortly." |
| `wait` (under budget, postable in N blocks) | disabled | "You are over the rate limit. Try again shortly." |

> **We never show N blocks or a percentage.** Twitter says "You are over the rate limit. Try again later." — so do
> we. `RateLimitNotice` (`02-design-system.md`) is a slim inline banner above the Composer's actions, in
> `--cg-text-secondary`, no battery, no countdown. The `blocks` number from `draftStatus` MAY be used internally to
> auto-re-enable the button when capacity regenerates (poll `useCapacity` each block; flip `ok` → enable) but is
> never rendered.

### 4.2 Reactive (the race)

Capacity is advisory (the runtime's `CheckCapacity::validate()` is the authority). If a post is submitted in the
rare window where the client thought `ok` but the pool rejects it, the extrinsic stream emits `phase:"error"` with
an `ExhaustsResources` message. `stringifyError` (exists) already maps `/ExhaustsResources/i` → a friendly string;
**override** it for the dropped-trust UX to the exact rate-limit copy:

```ts
// in stringifyError (lib/chain/post.ts), the ExhaustsResources branch:
if (/ExhaustsResources/i.test(raw)) return "You are over the rate limit. Try again shortly.";
```

So both the proactive gate and the reactive race produce the **same** Twitter-style line, surfaced as a
`RateLimitNotice` (proactive) or an error `Toast` (reactive).

### 4.3 What `CheckCapacity` rejection looks like

At the pool, a feeless extrinsic over budget is rejected with a transaction-validity error whose dispatch/validity
class is `ExhaustsResources` (FRAME's "resources exhausted"). In the PAPI `signSubmitAndWatch` stream this surfaces
as either a thrown stream `error` (pool rejection before inclusion) or an `invalid` best-block state — both routed
through `stringifyError`/`stringifyDispatchError`. The FE matches on `ExhaustsResources` (case-insensitive) and
never shows the raw class to the user.

---

## 5. Identity / session model (the write-gate state machine)

The dual-key model: the **Cardano CIP-30 wallet** is the identity/stake key; the **posting key** is an sr25519 key
**derived** from the wallet's signature (`useSigner`, nothing stored). Writes require an on-chain **identity bind**
(`link_identity_signed`). Stake-weighted votes additionally require a **stake bind** (`link_stake_signed`).

### 5.1 Session states (canonical — other docs cite these)

```
SessionState =
  | "disconnected"        // no wallet, no dev account chosen        → read-only
  | "connecting"          // sign-to-derive in flight (useSigner.deriving)
  | "connected_unbound"   // posting key derived, NOT identity-bound  → read + can bind, cannot post
  | "binding"             // CIP-8 identity bind in flight (useIdentity.binding)
  | "bound"               // identity-bound                            → full write (post/reply/quote/vote/repost/follow/poll/profile)
  | "bound_no_stake"      // bound but no stake credential             → can post; votes carry 0 weight
  | "bound_staked"        // bound + stake credential bound            → votes carry weight
```

Derivation (from existing hooks):

```ts
function sessionState({ deriving, postingEnabled, walletConnected }: UseSigner,
                      { bound, binding, stakeBound }: UseIdentity): SessionState {
  if (deriving) return "connecting";
  if (!postingEnabled) return "disconnected";        // no wallet & no dev account
  if (binding) return "binding";
  if (bound === false) return "connected_unbound";
  if (bound === true) return stakeBound ? "bound_staked" : "bound_no_stake";
  return "disconnected"; // bound === null (loading): treat as not-yet-writable
}
```

> `bound_no_stake` vs `bound_staked` is **not** a hard write gate — both can post and even vote; the difference is
> whether a vote carries weight. The UI does **not** block voting when unstaked (a zero-weight vote is valid); it
> may offer a subtle "Add voting power" prompt in `/settings` (no nag, no honesty framing).

### 5.2 Write-affordance gating across the app (the table other docs cite)

| Affordance | disconnected | connected_unbound | bound* |
|---|:--:|:--:|:--:|
| Read feed / thread / profile / explore | ✅ | ✅ | ✅ |
| **Compose / Post CTA** | ➜ ConnectWalletButton | ➜ "Finish setup" (bind) | ✅ |
| Reply / Quote | ➜ connect | ➜ bind | ✅ |
| Like / Down-vote / Clear | ➜ connect | ➜ bind | ✅ |
| Repost | ➜ connect | ➜ bind | ✅ |
| Follow / Unfollow | ➜ connect | ➜ bind | ✅ |
| Create / vote poll | ➜ connect | ➜ bind | ✅ |
| Edit profile / pin (fee-bearing) | ➜ connect | ➜ bind | ✅ (needs identity-gate; pallet requires bound) |
| Vote **carries weight** | — | — | only `bound_staked` |

- `➜ ConnectWalletButton`: clicking a write affordance while `disconnected` opens the connect-wallet flow
  (`/welcome` or the `ConnectWalletButton` in `LeftNav`/header). The action is **deferred**: after connect+bind we
  do **not** auto-replay the click (v1; note the follow-up to remember intent).
- `➜ bind`: while `connected_unbound`, write affordances route to the **finish-setup** step (the CIP-8 bind). The
  Composer shows a "Finish setting up your account to post" inline prompt with a Bind button (calls
  `useIdentity.bind(walletId)`).
- **Profile/pin** additionally require the on-chain identity gate (`pallet-profile` rejects an unbound account) —
  same `bound` gate; no extra state.

### 5.3 Bind flow (unsigned bare; reuse `useIdentity`)

The binds are **feeless UNSIGNED bare** extrinsics (`getBareTx()` + `client.submit`) — no fee, no nonce, no funded
sponsor (a zero-balance derived account binds itself; the CIP-8 proof is the authorization). This is already
implemented in `lib/chain/identity.ts` + `useIdentity`; the data layer **reuses it unchanged**. The mutation module
re-exports `submitLinkIdentityFeeless`/`submitLinkStakeFeeless` for callers that want the raw promise, but UI should
prefer the hook (it does genesis read → CIP-8 sign → submit → `AccountOf` readback → live `bound`/`stakeBound`
watch).

- **identity bind** (`useIdentity.bind(walletId)`): wallet signs CIP-8 over the pinned payload committing
  genesis + posting account → `link_identity_signed` bare → readback confirms `AccountOf[idHash] === my ss58`.
- **stake bind** (`useIdentity.bindStake(walletId)`): requires `bound===true` (pre-checked; `NotPaymentBound` on
  chain). Wallet signs CIP-8 with its **stake key** → `link_stake_signed` bare → `votingPower` lands a few blocks
  later (watched live).

### 5.4 Notifications hook (DEFERRED — leave the seam)

Not authored in v1. The data layer **does** expose the events that make it a clean follow-up: the indexer's `Vote`,
`Repost`, `Follow`, `Reply` (`Post.parent`), and `Quote` (`Post.quote`) edges **targeting the viewer** are exactly
a notifications feed. A future `useNotifications(who)` would query `votes(filter:{ postId:{ in: myPostIds }})`,
`reposts(...)`, `follows(filter:{ followeeId:{ equalTo: who }})`, `posts(filter:{ parentId:{ in: myPostIds }})`,
and `posts(filter:{ quoteId:{ in: myPostIds }})`, merged by recency. **Do not build it now** — just leave this hook
slot named.

---

## 6. Canonical query + mutation names (cite these verbatim)

**GraphQL query constants** (`lib/graphql/queries.ts`):

| Name | Purpose | Caps |
|---|---|---|
| `FEED` | home timeline + explore/search (cursor) | `search`/`pagination` |
| `SEARCH_PEOPLE` | author search by `displayName` (explore People results, via the indexer) | `search`/`profiles` |
| `PROFILE_BY_ACCOUNT` | profile by ss58 (+ posts page, profile fields, counts) | `profiles`/`follows` |
| `PROFILE_BY_IDENTITY` | profile by 0x identity hash | `profiles` |
| `PROFILE_REPLIES` | profile Replies tab (`parentId` not null) | — |
| `PROFILE_LIKES` | profile Likes tab (this author's `Up` votes) | — |
| `THREAD` | post + parent context + direct replies | `threads` |
| `POLL` | poll options + per-option tally for a host id | `tallies` |
| `VIEWER_STATES` | viewer's votes + reposts over a post-id set | `tallies` |
| `FOLLOW_EDGES` | followers/following ids + counts for an account | `follows` |
| `WHO_TO_FOLLOW` | ranked suggestions by follower count | `whoToFollow` |
| `ONE_POST` | a single post by id (pinned post, quote target resolve) | — |

**Mutation functions** (`lib/chain/mutations.ts`): `submitPost`, `submitReply`, `submitQuote`, `submitVote`,
`submitClearVote`, `submitRepost`, `submitFollow`, `submitUnfollow`, `submitCreatePoll`, `submitPollVote`,
`submitSetProfile`, `submitClearProfile`, `submitPinPost`, `submitUnpinPost`, (+ re-exported
`submitLinkIdentityFeeless`, `submitLinkStakeFeeless`).

---

## 7. Hooks inventory

### 7.1 Reused as-is

| Hook | Owns | Signature (unchanged) |
|---|---|---|
| `useChain()` | the single PAPI ws connection | `→ { handle, api, client, status, boot, wsUrl, reconnect }` *(expose `client` for bare binds)* |
| `useFeed(source)` | live snapshot from `FeedSource.watch()` | `→ { snapshot, ready, error }` |
| `useFeedPage(source, query, enabled)` | paginated/search read | `→ { posts, page, loading, error, hasNextPage, totalCount, loadMore }` |
| `useSigner()` | derive sr25519 from wallet; dev accounts | `→ { signer, walletConnected, postingEnabled, connectedWalletId, walletAddress, deriving, error, connectWallet, disconnect, ... }` |
| `useIdentity(api, client, signer)` | bind state machine (identity + stake) | `→ { bound, binding, error, bind, stakeBound, votingPower, bindStake, stakeBinding, stakeError, ... }` |
| `useCapacity(api, ss58, bestBlock)` | advisory capacity view for the rate-limit gate | `→ { view, consts }` |
| `useVault(...)` | lock/exit 100 ADA via Blockfrost (Settings) | unchanged |
| `useHeads(client)` | best/finalized heads | kept (drives `bestBlock` for `useCapacity`); **not rendered** in chrome |
| `useAnchor(api)` | anchor checkpoint | **unused by UI** (trust layer dropped); keep the read, do not render |

> `useChain` must surface `client` (the `PolkadotClient`) so the bare-unsigned binds (`client.submit`) and
> `useIdentity` can use it. It already holds `handle.client`; expose it as `client` on the return.

### 7.2 New hooks

| Hook | Signature | Owns |
|---|---|---|
| `useFeedSource(api, graphqlUrl)` | `→ FeedSource \| null` | wraps `makeFeedSource`; memoized on `[api, graphqlUrl]`; the single seam other hooks consume |
| `useOptimisticFeed(source, pending)` | `→ { snapshot, ready, error }` | `useFeed` + merges the §2.11 optimistic overlay so a pending card/like is not clobbered before confirm |
| `useViewerStates(source, postIds, who)` | `→ Map<bigint, ViewerPostState>` | batch `VIEWER_STATES` / PAPI per-card; refetch on confirm; drives filled-heart / active-repost icons |
| `useVote(api, signer, source)` | `→ { like, unlike, downvote, clear, pending }` | optimistic vote/clear; `like`=up-vote (Like==up); reconciles tally |
| `useRepost(api, signer)` | `→ { repost, pending, reposted(id) }` | optimistic permanent repost; disables once reposted (`AlreadyReposted` guard) |
| `useFollow(api, signer, source, who)` | `→ { isFollowing(target), follow, unfollow, followers, following, followerCount, followingCount, pending }` | follow graph + optimistic toggle (gated `caps.follows`) |
| `usePoll(source, hostId)` | `→ { poll, myChoice, castVote, loading, error }` | fetch `PollView` + viewer choice; optimistic `cast_poll_vote` |
| `useProfile(source, args)` | `→ { profile, posts, loading, error, loadMore }` | `FeedSource.profile`; tab-aware (`tab` in the query) |
| `useThread(source, rootId)` | `→ { thread, loading, error, addOptimisticReply }` | `FeedSource.thread`; supports the optimistic pending reply card |
| `useWhoToFollow(source, who, limit)` | `→ { suggestions, loading }` | `WHO_TO_FOLLOW` minus self/already-followed (gated `caps.whoToFollow`) |
| `useMutation(stream$)` | `→ { run, phase, error, reset }` | generic adapter: subscribe a `TxUpdate` stream, expose phase + Toast wiring; the optimistic hooks build on it |
| `useBalance(api, ss58)` | `→ { free, loading, error }` | reads `System.Account(ss58).data.free` (live); drives the fee-bearing profile/pin funded-account gate (account-funding owned by `12-surface-settings.md`) |
| `useFeeEstimate(tx, ss58)` | `→ { fee, loading, error }` | wraps `tx.getEstimatedFees(ss58)`; estimates the cost of a `set_profile`/`pin_post` call so the gate can compare against `useBalance.free` |
| `useTheme()` | `→ { theme, setTheme, toggle }` | dark-first; persists `--cg-*` `[data-theme]` on `:root` (default `dark`); see `02-design-system.md` |

> **Hook → seam contract.** Every social hook takes `source: FeedSource` and respects `source.caps`: e.g.
> `useFollow` returns `followers:[]`, `followerCount:0`, and a working optimistic toggle even on PAPI-direct
> (`caps.follows:false`) — the toggle still **writes** (follow is a chain extrinsic, available to anyone bound), it
> just cannot **read** the edge set, so the profile counts are hidden. The write path is never gated by reader caps;
> only the **read** affordances are.

### 7.3 Composition example (a `PostCard`'s data)

```
PostCard(post: CognoPost, source, signer, session)
  ├─ post.upCount/upWeight/score/repostCount            ← from FEED node (indexer) or lazy social-reads (papi)
  ├─ viewer state (myVote, reposted)                    ← useViewerStates(source,[post.id],who)
  ├─ Like  → useVote(...).like(post.id)                 ← optimistic; submitVote(Up); rollback on error
  ├─ Repost→ useRepost(...).repost(post.id)             ← optimistic; submitRepost; permanent
  ├─ Reply → opens ReplyComposer → submitReply          ← optimistic pending card via useThread
  ├─ Quote → opens QuoteComposer → submitQuote
  └─ overflow "…" → Down-vote (submitVote Down), Share-link (copy /post/[id]), Clear vote
```

---

## 8. Static-export constraints on the data layer

- **No server data fetching.** Every query is a browser `fetch`/PAPI call from an effect or handler. The dynamic
  routes `/post/[id]` and `/u/[address]` are statically exported as client-rendered shells that read the param on
  the client and call the seam (the route strategy is owned by `01-information-architecture.md`; the data layer
  assumes nginx `try_files` SPA fallback so a deep link resolves the shell, then fetches).
- **SSG-safe modules.** `lib/graphql/client.ts` and the readers touch no `window`/`fetch` at module-eval time
  (already true); keep new modules the same (only call from effects/handlers).
- **Endpoints from config, never load-bearing.** `makeFeedSource(api, graphqlUrl)` picks the indexer when a
  GraphQL URL is set in `/settings`, else PAPI-direct. Clearing the URL silently degrades (caps shrink, affordances
  hide). The ws endpoint + GraphQL endpoint live in `/settings` **silently** (not framed as honesty).
- **u64/u128 everywhere as `bigint`.** Post ids, weights, scores. Never serialize a `bigint` to a route or compare
  via `Number`.

---

## 9. Implementation checklist (ordered)

- [ ] **Kill `deleted` (§1):** remove every `deleted` reference from `queries.ts`, `feed-source.ts` (`FeedNode`,
      `AuthorPostNode`, `ThreadResponse`, `nodeToPost`, `authorPostToPost`, `feedFilter`, `watch()`), and the
      `CognoPost.deleted` field in `types.ts`. Run `npm test` — the existing GraphQL fixtures must update.
- [ ] **Extend `types.ts` (§2.1):** add `PollOptionView`, `PollView`, `QuotedRef`, `ViewerPostState`, `FollowEdges`,
      `Suggestion`; add the social fields to `CognoPost`; extend `FeedCaps` (tallies/follows/profiles/whoToFollow);
      extend `FeedSource` (poll/viewerPostState/followEdges/whoToFollow) and `FeedQuery` (tab/followeeOf/order).
- [ ] **Rewrite `queries.ts` (§2.2/2.6/2.7/2.8/2.9/2.10):** `FEED` (+ social + quote + author profile), the new
      `PROFILE_BY_ACCOUNT`/`PROFILE_BY_IDENTITY`/`PROFILE_REPLIES`/`PROFILE_LIKES`, `THREAD` (+ parent + tallies),
      `POLL`, `VIEWER_STATES`, `FOLLOW_EDGES`, `WHO_TO_FOLLOW`, `ONE_POST`.
- [ ] **Extend `graphql/feed-source.ts` (§2):** map the new fields in `nodeToPost`/`authorToProfile`; implement
      `poll`, `viewerPostState`, `followEdges`, `whoToFollow`; set indexer caps all-`true`.
- [ ] **Create `lib/chain/social-reads.ts` (§2.4):** `readPostTally`, `readRepostCount`, `readViewerPostState`,
      `readPoll`, `readViewerPollChoice` from storage; confirm exact `Microblog.*` storage names against live
      metadata.
- [ ] **Extend `feed/papi-source.ts` (§2):** wire `poll`/`viewerPostState` to `social-reads`; throw
      `UnsupportedQuery` for `followEdges`/`whoToFollow`/profile-display; set PAPI caps
      `{search:false,pagination:false,threads:true,revocation:true,tallies:true,follows:false,profiles:false,whoToFollow:false}`.
- [ ] **Generalize `lib/chain/post.ts` (§3.2):** make `watchTx`/`extractPostId` event-name-parameterized; keep
      `PostCreated` as the only id-bearing event; update the `ExhaustsResources` copy (§4.2) to the rate-limit line.
- [ ] **Create `lib/chain/mutations.ts` (§3):** all `submit*` functions per the action→extrinsic table, exact arg
      shapes (Binary.fromText, VoteDir `{type:"Up"|"Down"}`, `option: u8`); re-export the two bare binds.
- [ ] **Build the optimistic engine (§3.3):** the pending overlay + per-action apply/confirm/rollback; reconcile
      against the feed poll / `viewerPostState`.
- [ ] **Wire capacity-as-rate-limit (§4):** remove `CapacityBattery` from the UI; keep `capacity.ts`; map
      `draftStatus` → Post-button disabled + `RateLimitNotice` copy; auto-re-enable on regeneration (no countdown
      rendered).
- [ ] **Session state machine (§5):** add `sessionState(...)` derivation; expose `client` from `useChain`; ensure
      write affordances route per the §5.2 gating table (connect → bind → write).
- [ ] **New hooks (§7.2):** `useFeedSource`, `useOptimisticFeed`, `useViewerStates`, `useVote`, `useRepost`,
      `useFollow`, `usePoll`, `useProfile`, `useThread`, `useWhoToFollow`, `useMutation`, `useTheme`.
- [ ] **Toast mapping (§3.4):** silent success for feeless social actions; error Toast + rollback on
      invalid/error; brief success toast for fee-bearing profile/pin; rate-limit → `RateLimitNotice`/Toast.
- [ ] **Leave the notifications seam (§5.4):** name `useNotifications(who)` as a deferred hook; do not implement.
- [ ] **Tests:** unit-test `nodeToPost` social mapping (bigint discipline), `mutations` arg shapes (VoteDir, poll
      options bytes), the optimistic apply/rollback math (re-vote weight reversal), and `sessionState` transitions.
      Keep MeshJS/PAPI mocked (Vitest, per `app/README.md`).
