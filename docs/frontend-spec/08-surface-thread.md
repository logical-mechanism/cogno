# 08 — Surface: Thread / Post Detail (`/post/[id]`)

The conversation surface: a single focused post enlarged into the X "post detail" view — bigger body, an absolute
timestamp, the stake-weighted vote **score** + Like / Repost / Quote / Reply counts as a dedicated stats row — with
the **ancestor chain** (walk `Post.parent` up to the conversation root) rendered above it and the **direct replies**
(oldest-first) rendered below, each a `PostCard`. An inline `ReplyComposer` ("Post your reply") is pinned directly
under the focal post. If the focal post is a quote it carries a `QuotedPostEmbed`; if it is a poll it carries an
inline `PollCard`. This doc owns the route `/post/[id]`, its desktop + mobile wireframes, the exact data reads (the
indexer `THREAD` query reproduced from `04-data-layer.md`, plus the PAPI-direct `thread()`/`buildThreadIndex`
fallback), the extrinsic each interaction calls, every UI state (including unknown id, dangling parent, banned
author), responsive behavior, accessibility, and an ordered implementation checklist. It is **chain-backed only**:
no honesty/trust chrome, optimistic UI, capacity surfaced solely as a rate-limit notice (`05-divergences-and-constraints.md`
D5/D11). All component names are the canonical ones from `03-component-library.md`; all tokens are from
`02-design-system.md`; the route/static-export strategy is from `01-information-architecture.md`.

---

## 1. Purpose & route

| | |
|---|---|
| **Route** | `/post/[id]` (`PostDetailPage`, a Client Component — see `01-information-architecture.md` §2) |
| **Param** | `id` = a base-10 **u64** post id, read **client-side** via `useParams()` (never from props) |
| **Renders** | `ThreadView` = ancestor chain (top) → focal `PostCard variant='detail'` → inline `ReplyComposer` → reply `PostCard`s (`variant='reply'`, `showThreadLine`) |
| **Data dep** | `source.thread(BigInt(id))` → `ThreadView` seam value. Available on **both** readers (`caps.threads === true` for indexer and PAPI-direct — `04-data-layer.md` §2.3) |
| **Write gate** | reads are public; Reply / Like / Repost / Quote / poll-vote funnel through the session gate (`04-data-layer.md` §5.2) — `disconnected` → ConnectWalletButton, `connected_unbound` → finish-setup bind |
| **Sticky header** | **Back arrow** (`IconBack`) + label "Post" (per `01-information-architecture.md` §8); back = `history.back()` if in-app history else `router.push('/')` |

The detail variant is **the one place** in the app where the stake-weighted up/down nature is surfaced (the score
line and `upWeight`/`downWeight`), per `05-divergences-and-constraints.md` D2. Everywhere else, Like is just a heart
with `upCount`.

---

## 2. Wireframes

### 2.1 Desktop (≥1020px — 3-column AppShell; this surface owns the center column)

The `LeftNav` (275px) and `RightRail` (350px) are the persistent `AppShell` chrome (`01-information-architecture.md`
§5); only the center column (`--cg-col-feed`, 600px cap) is documented here. The center column is the scroll
container; its sticky header is back-arrow + "Post".

```
┌──────────────┬───────────────────────────────────────────────┬──────────────┐
│  LeftNav     │  ┌─────────────────────────────────────────┐  │  RightRail   │
│  (sticky)    │  │ ←  Post                                  │  │  (sticky)    │  ← sticky header (backdrop-blur)
│              │  └─────────────────────────────────────────┘  │  SearchBar   │
│  · cogno     │  ╭── ANCESTOR CHAIN (parent → … → root) ──╮    │  Who-to-     │
│  · Home      │  │ (•) DisplayName @ab…yz · 3h        [···] │    │  follow      │
│  · Explore   │  │  │  Body of the grandparent / root post  │    │  · footer    │
│  · Profile   │  │  │  ⟲ 4   ↻ 1   ❝ 0   ♥ 9   ↗            │    │              │
│  · Settings  │  │  ┊  (vertical thread line connects down)  │    │              │
│              │  │ (•) DisplayName @cd…wx · 2h        [···] │    │              │
│  [  Post  ]  │  │  │  Body of the direct parent post       │    │              │
│              │  │  │  ⟲ 7   ↻ 2   ❝ 1   ♥ 21  ↗           │    │              │
│  (acct chip) │  ╰──┊──────────────────────────────────────╯    │              │
│              │  ┌─────────────────────────────────────────┐    │              │
│              │  │ (•)  Ada Lovelace                        │    │  ← FOCAL POST (PostCard variant='detail')
│              │  │      @5CBE…oFC                     [···] │    │
│              │  │  ↳ Replying to @cd…wx                    │    │  (only if focal is a reply)
│              │  │                                          │    │
│              │  │  Larger 17px body text of the focused    │    │  ← PostBody size='lg'
│              │  │  post, up to 512 bytes, URLs auto-linked.│    │
│              │  │  ┌────────────────────────────────────┐  │    │
│              │  │  │ QuotedPostEmbed (if post.quote)    │  │    │  ← or PollCard if isPoll
│              │  │  └────────────────────────────────────┘  │    │
│              │  │  3:14 PM · Jun 21, 2026                  │    │  ← absolute timestamp
│              │  │  ─────────────────────────────────────  │    │
│              │  │  38 Likes · 4 Reposts · score +1.2M     │    │  ← STATS / SCORE row (detail only)
│              │  │  ─────────────────────────────────────  │    │
│              │  │  ⟲ Reply   ↻ Repost   ❝ Quote   ♥   ↗   │    │  ← PostCardActions (full-width)
│              │  └─────────────────────────────────────────┘    │              │
│              │  ┌─────────────────────────────────────────┐    │              │
│              │  │ (•) Post your reply             [ Reply ]│    │  ← inline ReplyComposer (pinned)
│              │  └─────────────────────────────────────────┘    │              │
│              │  ╭──────────── REPLIES (oldest-first) ──────╮    │              │
│              │  │ (•) DisplayName @ef…gh · 1h        [···] │    │  ← reply PostCard variant='reply'
│              │  │     Reply body…                          │    │     showThreadLine
│              │  │     ⟲ 0   ↻ 0   ❝ 0   ♥ 3   ↗          │    │              │
│              │  │ ┊ (•) nested reply (depth-2, if present) │    │              │
│              │  │ (•) DisplayName @ij…kl · 1h        [···] │    │              │
│              │  │     Reply body…                          │    │              │
│              │  ╰──────────────────────────────────────────╯    │              │
│              │  │ (skeleton rows while loading more)        │    │              │
└──────────────┴───────────────────────────────────────────────┴──────────────┘
```

### 2.2 Mobile (<688px — single column, `BottomTabBar` + `ComposeFab`; no rails)

```
┌─────────────────────────────────────────┐
│ ←  Post                                  │  ← sticky top bar (backdrop-blur)
├─────────────────────────────────────────┤
│ (•) @ab…yz · 3h                    [···] │  ← ancestor (root)
│  │  Root post body…                      │
│  │  ⟲4  ↻1  ❝0  ♥9              ↗       │
│  ┊                                       │  ← thread line
│ (•) @cd…wx · 2h                    [···] │  ← ancestor (parent)
│  │  Parent post body…                    │
│  │  ⟲7  ↻2  ❝1  ♥21            ↗       │
├─────────────────────────────────────────┤
│ (•) Ada Lovelace            [···]        │  ← FOCAL (detail), avatar+name stacked
│     @5CBE…oFC                            │
│ ↳ Replying to @cd…wx                     │
│ Larger 17px body of the focused post.    │
│ ┌─────────────────────────────────────┐  │
│ │ QuotedPostEmbed / PollCard          │  │
│ └─────────────────────────────────────┘  │
│ 3:14 PM · Jun 21, 2026                   │
│ ───────────────────────────────────────  │
│ 38 Likes · 4 Reposts · score +1.2M       │  ← stats/score
│ ───────────────────────────────────────  │
│  ⟲ Reply    ↻ Repost   ❝ Quote   ♥   ↗  │  ← actions spread full-width
├─────────────────────────────────────────┤
│ (•) Post your reply            [ Reply ] │  ← inline ReplyComposer
├─────────────────────────────────────────┤
│ (•) @ef…gh · 1h                    [···] │  ← replies, oldest-first
│     Reply body…                          │
│     ⟲0  ↻0  ❝0  ♥3            ↗        │
│ ┊ (•) nested reply (if present)          │
│ (•) @ij…kl · 1h                    [···] │
│     Reply body…                          │
├─────────────────────────────────────────┤
│  [Home] [Explore]  (＋)  [Prof] [Setts]  │  ← BottomTabBar + ComposeFab
└─────────────────────────────────────────┘
```

> The `ComposeFab` remains visible on mobile (opens `ComposerModal` for a **top-level** post, not a reply). The
> inline `ReplyComposer` under the focal post is the reply affordance; the FAB is unrelated. (`01-information-architecture.md` §6.)

---

## 3. Component composition

`ThreadView` (`03-component-library.md` §22.5) is the surface composite. `PostDetailPage` mounts it once the param
resolves and the thread loads.

```
PostDetailPage (/post/[id])
└─ <main> (center column scroll container)
   ├─ StickyHeader   (IconBack + "Post"; back-arrow logic §6.4)        ← per 01 §8
   └─ ThreadView { root, ancestors, replies, viewer, loading, ... }
      ├─ AncestorChain[]       → PostCard variant='thread' showThreadLine   (parent → … → root, top-down)
      │     └─ (each) PostCardHeader · PostBody · PostCardActions
      ├─ PostCard variant='detail'   ← THE FOCAL POST
      │     ├─ PostCardHeader (avatar+name stacked; [···] overflow)
      │     ├─ "Replying to @x" line        (iff post.parentId != null)
      │     ├─ PostBody size='lg'
      │     ├─ QuotedPostEmbed              (iff post.quote)        ── OR ──
      │     ├─ PollCard                      (iff post.isPoll)
      │     ├─ AbsoluteTimestamp            ("3:14 PM · Jun 21, 2026")
      │     ├─ StatsRow                      ("38 Likes · 4 Reposts · score +1.2M")  ← detail-only
      │     └─ PostCardActions (full-width: Reply · Repost · Quote · Like · Share)
      ├─ ReplyComposer (mode='reply', replyTo=root)   ← inline, pinned under focal; "Post your reply"
      └─ RepliesList[]         → PostCard variant='reply' showThreadLine   (oldest-first)
            └─ (each) optional depth-2 nested PostCard (one extra level; deeper → lazy nav)
```

Notes:
- **`ThreadView` is `root + 1 level` of replies** (`04-data-layer.md` §2.7). Depth-2 replies that the indexer
  returns nested under a direct reply are rendered as a single extra indented `PostCard`; anything deeper is reached
  by clicking that reply through to its own `/post/[id]`. A fully-recursive conversation tree is a **deferred
  follow-up** — leave the note, do not build it.
- The **focal post** is `variant='detail'`; **ancestors** use `variant='thread'`; **replies** use `variant='reply'`.
  All of `thread`/`reply` set `showThreadLine` to draw the X vertical connector.
- Per `03-component-library.md` §1, only the **detail** variant renders the absolute timestamp + the stats/score
  row. Ancestors and replies keep relative time and the normal inline action counts.

### 3.1 The detail stats/score row (the one weighted-nature surface)

A single line under the absolute timestamp, above the action row, rendered **only** in `variant='detail'`:

```
38 Likes · 4 Reposts · score +1.2M
```

- **Likes** = `post.upCount` (the heart count); **Reposts** = `post.repostCount`.
- **score** = humanized `post.score` BigInt (`upWeight − downWeight`, **may be negative** → render `+1.2M` /
  `−340K` / `0`). This is the only place `score`/`upWeight`/`downWeight` are exposed (`05-divergences-and-constraints.md`
  D2/D12). Numbers are formatted by a `humanizeWeight(bigint)` helper (BigInt-safe; never `Number()` a u128 —
  `04-data-layer.md` §2.2 u64 discipline).
- Tap targets: "38 Likes" and "4 Reposts" are **not** links in v1 (the "liked-by"/"reposted-by" lists need reverse
  indexes we hide on PAPI-direct); render as plain `--cg-text-secondary` text. Note the follow-up: a "Liked by"
  list is a clean later addition behind `caps.tallies` + a `VIEWER_STATES`-style reverse query.

---

## 4. Data bindings

### 4.1 Indexer path — `THREAD` (reproduced verbatim from `04-data-layer.md` §2.7)

The surface calls `source.thread(BigInt(id))`, which on the indexer issues `THREAD` (the canonical query constant in
`lib/graphql/queries.ts`; **no `deleted` field** — `04-data-layer.md` §1):

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

Bindings into the composition:

| UI element | Source field |
|---|---|
| Focal `PostCard variant='detail'` | top-level `post { … }` → `PostVM` (`03-component-library.md` §0.4) |
| "Replying to @x" line on focal | `post.parent { id, author }` (present iff `post.parentId != null`) |
| Ancestor chain above focal | `post.parent` gives **one** parent; deeper ancestors require walking up — see §4.3 |
| `QuotedPostEmbed` on focal | `post.quote { id, text, author }` (shallow, one level — no recursion, `04-data-layer.md` §2.2) |
| `PollCard` on focal | `post.isPoll === true` → fetch options via `usePoll(source, post.id)` → `POLL` query (§4.4) |
| Stats/score row | `post.upCount`, `post.repostCount`, `post.score` |
| Replies list (oldest-first) | `post.replies.nodes` (`orderBy: ID_ASC` == oldest-first; matches X conversation order) |
| Reply count (focal action row) | `post.replies.totalCount` |

> **`replies.nodes` are direct children only.** A nested (depth-2) reply is fetched by navigating into that reply's
> own `/post/[id]` (`04-data-layer.md` §2.7). The optional one-extra-level nesting in the wireframe is rendered only
> if the indexer returns it under a direct reply (it does not by default in `THREAD`); the v1 baseline is **flat
> direct replies under the focal post**.

**`ViewerPostState` (filled heart / active repost) for every card in the thread.** After `THREAD` resolves, collect
the visible post-id set (focal + ancestors + replies) and call `useViewerStates(source, postIds, who)` →
`VIEWER_STATES` (`04-data-layer.md` §2.9):

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

Map → `Map<bigint, ViewerPostState>`; absence ⇒ `{ myVote: null, reposted: false }`. This drives `viewerVote` /
`viewerReposted` on each `PostVM`. Skip the query entirely when `viewer.status !== 'ready'` (logged-out users see
no filled hearts).

### 4.2 PAPI-direct fallback — `thread()` + `buildThreadIndex`

When `source.kind === 'papi'` (`makeFeedSource` got no GraphQL URL — `04-data-layer.md` §0/§8), `thread(rootId)`
assembles the view from chain storage + the local snapshot (`caps.threads === true` on PAPI-direct —
`04-data-layer.md` §2.3):

1. **Focal post** — `getPost(rootId)` (`Microblog.Posts(id)` → `{ author, text, parent?, quote?, at }`,
   `04-data-layer.md` §2.4 storage table). `parentId` from the stored `parent`. `quote` hydrated via a second
   `getPost(quote_id)` (shallow).
2. **Ancestors** — walk up: while the current node has a `parent`, `getPost(parent)` and prepend, until a node with
   no parent (the root) — capped at a small ancestor budget (§4.3).
3. **Replies** — `buildThreadIndex(snapshot)`: group the live feed snapshot by `parent` and take entries whose
   `parent === rootId`, sorted by `id` ascending (oldest-first). Dangling replies (parent absent from the snapshot
   window) are still **grouped and rendered**, never dropped (`04-data-layer.md` §2.7).
4. **Tallies per card** — enrich each rendered card **lazily** via `social-reads.ts`
   (`readPostTally`, `readRepostCount`) keyed by the card's id (`caps.tallies === true` on PAPI-direct). The detail
   stats/score row reads `readPostTally(api, focal.id)` eagerly (it is one read for the focused post).
5. **Viewer state per card** — `readViewerPostState(api, id, who)` reads `Microblog.Votes(id, who)` (Option) +
   `Microblog.Reposts(id, who)` (Option), batched with `Promise.all` over visible ids (lazy per-card,
   `04-data-layer.md` §2.9).

PAPI-direct gaps to render around (no honesty labels — just **hide/fallback**, `04-data-layer.md` §2.3):
- `caps.profiles === false` → author `displayName`/`avatar` unavailable → `DisplayName` falls back to truncated
  ss58, `Avatar` to the deterministic identicon (`03-component-library.md` §13/§14).
- `timestamp` is `null` on PAPI-direct (no block timestamp) → the focal's absolute-timestamp line shows the block
  height instead (`#1234`) — the single place PAPI-direct shows a block number, and only because there is no clock,
  **not** as honesty marginalia (`03-component-library.md` §1 data bindings; `05-divergences-and-constraints.md`
  D11). Relative time on ancestor/reply cards likewise degrades to `#height`.

### 4.3 Ancestor chain reconstruction (walk `Post.parent` to root)

X renders the full ancestry above the focal post. The chain has only a single `parent` pointer per post, so the
ancestry is a linked list walked upward.

- **Indexer:** `THREAD` returns one `parent` level. To show the **full** chain above the focal post, the data layer
  walks up with the `ONE_POST` constant (`04-data-layer.md` §6) per ancestor:
  ```graphql
  query OnePost($id: String!) {
    post(id: $id) {
      id authorId text parentId blockHeight isPoll
      upWeight downWeight upCount downCount score repostCount
      author { id banned displayName avatar }
      quote { id text author { id banned displayName avatar } }
    }
  }
  ```
  Loop: start at `focal.parentId`; fetch `ONE_POST`; prepend; continue at its `parentId`; stop when `parentId == null`.
- **PAPI-direct:** the same walk via `getPost` (§4.2 step 2).
- **Ancestor budget:** cap the walk at **`MAX_ANCESTORS = 16`** to bound deep-link cost. If the root is deeper than
  the budget, render a subtle `"Show this thread"` affordance at the top of the ancestor list that, when clicked,
  navigates to the **root** post's `/post/[id]` (so the user can climb). One-line rationale: deep-linking into a
  600-post chain must not fan-out 600 reads on first paint; X similarly truncates very deep ancestry.
- **`order`:** ancestors render **top-down** (root first, focal-parent last), i.e. the reverse of the upward walk.
  Use `PostCard variant='thread'` with `showThreadLine` so the vertical connector flows continuously down into the
  focal post.
- **Dangling/unindexed parent:** if a `parentId` resolves to a post the reader cannot find (indexer lag, or the
  PAPI-direct snapshot window does not include it), **stop the walk** and render a subtle inline marker at the top of
  the ancestor list: `"in reply to a post not loaded"` (muted `--cg-text-secondary`, `04-data-layer.md` §2.7). Never
  fabricate or drop the focal — the focal still renders; only the ancestry is truncated. **Posts are never deleted**
  (`05-divergences-and-constraints.md` D10), so a missing ancestor is always "not indexed / outside window," never
  "deleted" — the copy must reflect that.

### 4.4 Poll on the focal post — `POLL`

If `focal.isPoll === true`, the focal's `PollCard` fetches options + tallies via `usePoll(source, focal.id)`, which
issues `POLL` (`04-data-layer.md` §2.8):

```graphql
query Poll($hostId: ID!) {
  poll(id: $hostId) {
    id
    options(orderBy: INDEX_ASC) { index label weight count }
    votes { totalCount }
  }
}
```

→ `PollView`: `options[i] = { index, label, weight: BigInt, count }`, `totalWeight = Σ weight`,
`totalCount = Σ count`, plus the viewer's choice via `readViewerPollChoice`/the indexer `PollVote`. PAPI-direct:
`readPoll(api, hostId)` (reads `Microblog.Polls` + `Microblog.PollTally`). Bars are **stake-weighted**
(`option.weight / totalWeight`), no countdown, "Open" chip — never "Final results" (`05-divergences-and-constraints.md`
D4). On the detail surface, results are shown **always** (regardless of whether the viewer has voted), because the
detail view is the inspectable view (`03-component-library.md` §6 behavior).

### 4.5 Quote on the focal post — `QuotedPostEmbed`

If `focal.quote` is present, render `QuotedPostEmbed` (`03-component-library.md` §5) with the shallow `QuotedRef`
(`id`, `author`, `text`, `authorRevoked`, `displayName?`, `avatar?` — `04-data-layer.md` §2.1). Clicking the embed
navigates to the quoted post's `/post/[id]` (`onOpen(quote.id)`). A quote **and** a poll are mutually exclusive on
the same post (a poll's host post is the question; a quote references another post) — render whichever is present;
if neither, render just the `PostBody`.

### 4.6 Capability gating recap (cite `04-data-layer.md` §2.3)

| Element on this surface | indexer | PAPI-direct | Gated by |
|---|:--:|:--:|---|
| Focal post + replies (the thread) | ✅ | ✅ | `threads` (true both) |
| Full ancestor walk | ✅ (`ONE_POST` loop) | ✅ (`getPost` loop) | `threads` |
| Stats / score row + per-card like counts | ✅ eager | ✅ (eager for focal, lazy per reply) | `tallies` (true both) |
| Filled heart / active repost (viewer state) | ✅ `VIEWER_STATES` | ✅ `readViewerPostState` | `tallies` |
| Author display name / avatar | ✅ | ❌ → ss58 + identicon | `profiles` |
| Absolute timestamp | ✅ (ISO) | ❌ → `#blockHeight` | — (no clock) |
| Banned-author flag | ✅ | ✅ | `revocation` (true both) |

---

## 5. Interactions → extrinsics

Every write goes through `lib/chain/mutations.ts` (`04-data-layer.md` §3.1) with the optimistic-apply → confirm →
rollback lifecycle (`04-data-layer.md` §3.3). All social actions are **feeless + capacity-metered**; capacity
exhaustion surfaces as `RateLimitNotice` (§7). Each interaction is gated by `viewer.status` (§6.1).

| Interaction (where) | Mutation fn | Extrinsic | Args | Optimistic delta |
|---|---|---|---|---|
| **Reply** (inline `ReplyComposer` under focal; or any card's Reply icon) | `submitReply` | `Microblog.post_message` | `{ text: Binary.fromText(s), parent: Some(focal.id) }` | insert a `pending` `PostCard` at the **bottom** of the replies list (oldest-first order → newest at end); bump focal reply count |
| **Like** (heart, any card) | `submitVote(Up)` | `Microblog.vote` | `{ post_id, dir: { type:"Up" } }` | `viewerVote="Up"`, `upCount+1`, `upWeight += votingPower` |
| **Unlike** (filled heart, any card) | `submitClearVote` | `Microblog.clear_vote` | `{ post_id }` | `viewerVote=null`, `upCount−1`, `upWeight −= prevWeight` |
| **Down-vote** (overflow `[···]` → Downvote) | `submitVote(Down)` | `Microblog.vote` | `{ post_id, dir: { type:"Down" } }` | `viewerVote="Down"`, `downCount+1`, `downWeight += votingPower` |
| **Repost** (any card; confirm popover) | `submitRepost` | `Microblog.repost` | `{ post_id }` | `viewerReposted=true`, `repostCount+1`; **permanent** — button then disabled |
| **Quote** (any card) | `submitQuote` | `Microblog.quote_post` | `{ text: Binary.fromText(s), quoted_id: post.id }` | opens `QuoteComposer`; on confirm a new feed post (not part of this thread) |
| **Poll vote** (focal `PollCard`, if `isPoll`) | `submitPollVote` | `Microblog.cast_poll_vote` | `{ post_id: focal.id, option: u8 }` | move viewer weight from prior option to chosen; bump count; re-cast replaces (no un-vote) |
| **Share-link** (any card) | *(local)* | — | copy `https://<host>/post/[id]/` to clipboard | success `Toast` "Link copied" |
| **Open author** (avatar/name) | *(nav)* | — | `router.push('/u/<address>/')` | — |
| **Open a card** (ancestor/reply row click) | *(nav)* | — | `router.push('/post/<id>/')` | — |

Encoding notes (from `04-data-layer.md` §3.1): `VoteDir` is `{ type: "Up" | "Down" }`; `text` via
`Binary.fromText`; byte limits enforced by `ByteCounter` (UTF-8 **bytes**, ≤ 512 for the reply —
`05-divergences-and-constraints.md` D1). `post_id`/`quoted_id` are `bigint`. The reply submit path is
`signSubmitAndWatch` (feeless signed); the bare unsigned binds are **not** reachable from this surface (binding
happens at `/welcome`/`/settings`).

### 5.1 Inline `ReplyComposer` specifics

- **Placement:** pinned directly under the focal `PostCard variant='detail'`, above the replies list. Always
  visible (not a modal) on the detail surface — this is X's "Post your reply" box. (`03-component-library.md` §9.)
- **`replyTo = root`** (the focal post). CTA label "Reply". On success the textarea **clears and stays open**
  (X "reply again" affordance, `03-component-library.md` §9) and the new reply appears optimistically at the bottom
  of the replies list, swapping its `clientId` for the real `PostCreated` id on `inBestBlock`
  (`04-data-layer.md` §3.3 step 3).
- **Reply from a non-focal card** (an ancestor's or another reply's Reply icon) opens a **`ReplyComposer` modal**
  (`ComposerModal` route overlay, `01-information-architecture.md` §7) with `replyTo` = that card, not the inline box
  — because its parent differs from the focal. The optimistic pending card then appears under **that** parent if it
  is in-thread, else it is simply submitted and the surface shows nothing new (it belongs to another conversation).
- **Gating:** when `viewer.status !== 'ready'`, the inline `ReplyComposer` renders the finish-setup prompt instead of
  the textarea (§6.1).

---

## 6. States

### 6.1 Session / write-gate states (cite `04-data-layer.md` §5.2)

| `viewer.status` | Reads | Inline `ReplyComposer` | Like / Repost / Quote / poll-vote on cards |
|---|---|---|---|
| `not-connected` (`disconnected`) | full | replaced by `ConnectWalletButton` ("Connect to reply") | clicking any → opens connect flow (`/welcome` or header `ConnectWalletButton`) |
| `not-identity-bound` (`connected_unbound`) | full | replaced by inline "Finish setting up your account to reply" + Bind button (`useIdentity.bind`) | clicking any → routes to finish-setup bind |
| `ready` (`bound` / `bound_no_stake` / `bound_staked`) | full | active textarea | active; **votes carry weight only when `bound_staked`** — a `bound_no_stake` Like still registers (`upCount+1`, weight 0), no block (`04-data-layer.md` §5.2) |

The action is **deferred** (not auto-replayed) after connect+bind in v1 — note the follow-up to remember intent
(`04-data-layer.md` §5.2).

### 6.2 Load / data states

| State | Rendering |
|---|---|
| **loading (initial)** | sticky header + a **skeleton thread**: one large focal-post skeleton (`Skeleton` block at `--cg-fs-lg` height) + 3 reply-row skeletons; shimmer respects `prefers-reduced-motion` (`02-design-system.md`). No spinner-only blank. |
| **loading more (deep ancestors)** | ancestor-chain area shows a small `Spinner` at its top while the upward walk resolves; the focal post renders as soon as it is fetched (ancestors hydrate above it without shifting the focal out of view — preserve scroll, §6.5). |
| **focal loaded, replies pending** | focal + `ReplyComposer` render immediately; replies area shows 2–3 reply-row skeletons until `replies` resolves. |
| **empty (no replies)** | replies area shows a quiet `EmptyState` (variant default): "No replies yet. Be the first." with the inline `ReplyComposer` above it as the call to action. (No illustration heavier than the X empty style.) |
| **optimistic-pending reply** | the just-submitted reply renders as a `pending` `PostCard` (`opacity:0.6`, inline `Spinner` by the time, actions disabled — `03-component-library.md` §1) at the bottom of the replies list; reconciles on `inBestBlock`, removed + failure `Toast` on error (`04-data-layer.md` §3.3). |
| **rate-limited** | the `ReplyComposer` shows a `RateLimitNotice` (inline) above its actions; the Reply CTA disabled (§7). |
| **banned author (focal or any card)** | `post.author.banned`: body in `--cg-text-muted`, "This account has been restricted" chip after the handle; **posts stay, actions remain enabled** (`03-component-library.md` §1; `05-divergences-and-constraints.md` D10). |
| **dangling/unindexed ancestor** | "in reply to a post not loaded" marker at the top of the ancestor list; focal still renders (§4.3). |

### 6.3 Error / not-found states

| State | Trigger | Rendering |
|---|---|---|
| **invalid id** | param fails `/^\d+$/` (placeholder `"_"` or junk) | in-app not-found: `<NotFoundInline kind="post" />` — `EmptyState` "This post doesn't exist." + a "Back to home" link. **Not** a hard 404 (the server is never reached — `01-information-architecture.md` §2). |
| **unknown / missing post** | valid id but the reader returns no post (`THREAD.post == null` / `getPost` empty) | same `NotFoundInline kind="post"` — "This post doesn't exist." Because content is permanent, a valid-but-absent id is either never-created or (PAPI-direct) outside the snapshot window; on PAPI-direct add a quiet secondary line "or it isn't loaded — set a GraphQL endpoint in Settings." (one line, not a trust disclaimer). |
| **load error** | network / GraphQL throw on `thread()` | inline `EmptyState` "Couldn't load this post." + a **Retry** button (`03-component-library.md` §1 detail error state). Retry re-runs `useThread`. |
| **reply submit error** | tx `invalid`/`error` phase | optimistic reply card removed; error `Toast` (friendly string via `stringifyError`); `RateLimitNotice`/Toast if `ExhaustsResources` (§7). The textarea is **not** cleared on failure (preserve the draft). |

### 6.4 Permalink / scroll-to-focal / back navigation

- **Scroll-to-focal:** on first paint after the thread resolves, the **focal post** is scrolled into view at the top
  of the viewport (X behavior: the focused post sits just under the sticky header, ancestors scroll up off-screen).
  Implement by scrolling the focal `PostCard`'s ref into view (`scrollIntoView({ block: 'start' })`) once, after
  layout, guarded so it fires only on the initial mount for that `id` (not on every reply insert).
- **Ancestors-above stability:** because ancestors hydrate after the focal (the upward walk is async, §4.3), inserting
  them above the focal must **not** push the focal out of view. Anchor scroll to the focal: measure the focal's
  offset before inserting ancestors and restore it after (preserve-scroll), or render ancestor placeholders sized to
  collapse cleanly. (§6.5 has the responsive caveat.)
- **Permalink:** the URL is the canonical permalink `https://<host>/post/[id]/` (trailing slash,
  `trailingSlash:true` — `01-information-architecture.md`). Share-link copies exactly this. Deep-linking to it is
  served by the nginx SPA fallback (§4.7 below).
- **Back arrow** (`IconBack` in the sticky header): `history.back()` when `window.history.length > 1` and the prior
  entry is in-app; else `router.push('/')` (uniform back behavior — `01-information-architecture.md` §8). Browser
  back/forward also work (client routing).

### 6.5 Static-export deep-link load (cite `01-information-architecture.md` §2–§3)

`/post/[id]` is a **client-resolved** route. Implementation contract (verbatim from `01-information-architecture.md`):

```ts
// src/app/post/[id]/page.tsx
export function generateStaticParams() {
  return [{ id: "_" }];   // single throwaway placeholder so the static export emits the route bundle
}
```
```tsx
"use client";
import { useParams } from "next/navigation";

export default function PostDetailPage() {
  const { id } = useParams<{ id: string }>();
  if (!/^\d+$/.test(id)) return <NotFoundInline kind="post" />;  // placeholder "_" / junk → in-app not-found
  // … source.thread(BigInt(id)) via useThread …
}
```

- The param is read **client-side**, never trusted from props (the on-disk HTML is the placeholder doc).
- A real deep link `https://<host>/post/918273/` has no `out/post/918273/index.html`; nginx `try_files $uri $uri/
  /404.html;` serves the SPA shell, the client boots, `useParams()` yields `918273`, and `useThread` fetches it
  (`01-information-architecture.md` §3 nginx block). **Do not** set `dynamicParams = false`.
- A user pasting the no-trailing-slash form `/post/918273` also falls through `try_files` to the shell (documented in
  `01-information-architecture.md` §3) — no 301.

---

## 7. Capacity as rate-limit (no battery)

The focal post's replies are feeless but capacity-metered. The only capacity surface is `RateLimitNotice`
(`02-design-system.md` §17; `04-data-layer.md` §4) — **never a battery**.

- **Pre-flight gate** on the inline `ReplyComposer`: `useCapacity` + `draftStatus(view, byteLen, K)` →
  `ok | no_weight | too_long | charging | wait`. Disable the Reply CTA + show the `RateLimitNotice` line per the
  `04-data-layer.md` §4.1 table:
  - `ok` → enabled, no notice.
  - `no_weight` → "Lock ADA to start posting." → links to `/settings` vault.
  - `too_long` → "This is too long to post at your current capacity. Shorten it."
  - `charging` / `wait` → "You are over the rate limit. Try again shortly."
- **Reactive race:** if the pool rejects the reply with `ExhaustsResources`, the tx stream emits `error`;
  `stringifyError` maps it to the exact line "You are over the rate limit. Try again shortly." surfaced as an error
  `Toast`, and the optimistic reply card is rolled back (`04-data-layer.md` §4.2/§4.3). Same line for like/repost/
  quote/poll-vote race rejections.
- **Never render** a percentage, a block count, or a meter (`05-divergences-and-constraints.md` D5). The button
  auto-re-enables when capacity regenerates (poll `useCapacity` per block, flip to `ok`), silently.

---

## 8. Responsive behavior

| Breakpoint | Layout |
|---|---|
| **mobile <688px** | single column; sticky back-arrow header; `BottomTabBar` + `ComposeFab` are the `AppShell` chrome; thread fills the viewport width; action row spreads full-width with Share trailing. Inline `ReplyComposer` is full-bleed under the focal. |
| **tablet 688–1019px** | collapsed icon-only `LeftNav` (88px), **no `RightRail`** (`01-information-architecture.md` §5); center column expands toward the 600px cap; thread layout identical to desktop center column. |
| **desktop ≥1020px** | full 3-column; `LeftNav` 275px + center (600px cap) + `RightRail` 350px; center column is the scroll container with the sticky back-arrow header; `LeftNav`/`RightRail` are `position:sticky;top:0;height:100vh`. |

- The center column never exceeds `--cg-col-feed` (600px). The focal `PostBody` uses `size='lg'` (`--cg-fs-md` 17px,
  `03-component-library.md` §4) at all breakpoints.
- Sticky header: `position:sticky; top:0; z-index:--cg-z-sticky; backdrop-filter: blur(var(--cg-header-blur))` over
  translucent `--cg-header-bg` (`02-design-system.md`).
- The vertical thread connector (`showThreadLine`) scales with avatar gutter (40px) at every breakpoint.

---

## 9. Accessibility

- **Focal landmark:** `ThreadView` root is a `<section aria-label="Conversation">`. The focal post is the
  `aria-current`-less primary `<article>`; on initial mount, programmatic focus moves to the focal post's article
  (`tabIndex={-1}` + `.focus()`) after scroll-to-focal so a screen-reader/keyboard user lands on the focused post,
  not the top of the ancestor chain.
- **Reading order:** DOM order is top-down (ancestors → focal → reply composer → replies), matching the visual
  order, so screen readers narrate ancestors then the focal then replies naturally.
- **Cards:** each `PostCard` is an `<article>` with `aria-labelledby` → its display-name node; the row-click is an
  overlay `<a href="/post/[id]/">` (X pattern — `03-component-library.md` §1) so the whole card is a real link
  without nesting buttons in an anchor; interactive children stop propagation.
- **Action buttons:** icon-only buttons carry `aria-label` ("Reply", "Repost", "Like" / "Liked", "Quote", "Share
  link"); toggles carry `aria-pressed` (Like, and the sticky-once Repost). The `[···]` is `<button aria-haspopup="menu">`
  → `role="menu"` (Downvote / Clear vote / Share-link).
- **Stats/score row:** a `role="group" aria-label="Post statistics"`; "score +1.2M" carries a fuller
  `aria-label="score plus 1.2 million (weighted)"` so the humanized number is intelligible.
- **`ReplyComposer`:** the textarea has `aria-label="Post your reply"`; the `ByteCounter` is `aria-live="polite"`
  reporting remaining bytes; `RateLimitNotice` is `role="status"` (`03-component-library.md` §0.5/§17).
- **Live regions:** the `Toaster` is `aria-live="polite"`; an optimistic reply insertion announces "Reply posted"
  politely on confirm (suppressed on `prefers-reduced-motion`-only? no — announcement is independent of motion).
- **Keyboard:** the surface honors the app-wide shortcuts where sensible — `Esc` closes the `ReplyComposer`-modal
  (non-inline) / overflow menu; `.` (period) opens the focal overflow menu; `l` / `r` / `t` act on the **focal**
  post (Like / Reply-focus / Repost) when no input is focused; `j`/`k` move focus through ancestors→focal→replies
  (the thread is a vertical list — reuse `Timeline`'s `j/k` ring keyed on `data-post-id`,
  `03-component-library.md` §0.5). `n` opens the top-level `ComposerModal` (a new post, not a reply). All shortcuts
  are inert while a textarea/input has focus.
- **Focus ring:** `--cg-focus-ring` (accent), 2px, offset 2px on every interactive element
  (`02-design-system.md`).
- **Reduced motion:** the like-pop, optimistic fade-in, skeleton shimmer, and scroll-to-focal smooth-scroll collapse
  to instant under `prefers-reduced-motion` (`02-design-system.md`).

---

## 10. Notifications hook (deferred — leave the seam)

This surface is a **primary source** of the deferred notifications feed: a reply to your post (`Post.parent` →
your id), a Like/Down-vote (`Vote` on your post), a Repost (`Repost` on your post), and a Quote (`Post.quote` → your
post) all originate as interactions here. Do **not** build a `/notifications` surface now. Leave a labeled comment at
the `PostCardActions`/`ReplyComposer` mutation sites noting that the indexer `Voted` / `Reposted` / reply-`PostCreated`
/ quote edges targeting the focal author are exactly the events a future `useNotifications(who)` folds
(`04-data-layer.md` §5.4; `03-component-library.md` §24).

---

## 11. Implementation checklist (ordered)

- [ ] **Route shell (§6.5):** create `src/app/post/[id]/page.tsx` as a `'use client'` `PostDetailPage`; add
      `generateStaticParams()` returning `[{ id: "_" }]`; read `id` via `useParams()`; validate `/^\d+$/` →
      `<NotFoundInline kind="post" />` otherwise. **Do not** set `dynamicParams=false`.
- [ ] **Wire `useThread(source, BigInt(id))` (`04-data-layer.md` §7.2):** load focal + replies via `source.thread`;
      expose `addOptimisticReply` for the inline composer.
- [ ] **Implement `ThreadView` (`03-component-library.md` §22.5):** compose ancestor chain (`variant='thread'`,
      `showThreadLine`) → focal `PostCard variant='detail'` → inline `ReplyComposer` → replies (`variant='reply'`,
      `showThreadLine`); props `{ root, ancestors, replies, viewer, loading, on* }`.
- [ ] **Detail-variant rendering (`03-component-library.md` §1):** absolute timestamp ("3:14 PM · Jun 21, 2026"),
      `PostBody size='lg'`, the stats/score row ("N Likes · N Reposts · score ±X" via `humanizeWeight` BigInt-safe),
      full-width `PostCardActions`. PAPI-direct: timestamp falls back to `#blockHeight`.
- [ ] **Ancestor walk (§4.3):** loop `ONE_POST` (indexer) / `getPost` (PAPI-direct) from `focal.parentId` up to
      root; cap at `MAX_ANCESTORS=16` with a "Show this thread" → root affordance; render top-down with the thread
      line; **dangling parent → "in reply to a post not loaded"**, never "deleted".
- [ ] **`THREAD` query (cite `04-data-layer.md` §2.7):** ensure `lib/graphql/queries.ts` `THREAD` matches §4.1
      (no `deleted`); map `post`/`parent`/`quote`/`replies.nodes` → `PostVM[]`; replies `orderBy: ID_ASC`
      (oldest-first).
- [ ] **Viewer state (§4.1):** call `useViewerStates(source, [focal,...ancestors,...replies].ids, who)` →
      `VIEWER_STATES` (indexer) / `readViewerPostState` (PAPI); hydrate `viewerVote`/`viewerReposted`; skip when not
      `ready`.
- [ ] **Poll on focal (§4.4):** if `focal.isPoll`, mount `PollCard` via `usePoll(source, focal.id)` → `POLL`;
      stake-weighted bars, "Open" chip, always-show results on detail; `cast_poll_vote` optimistic (no un-vote).
- [ ] **Quote on focal (§4.5):** if `focal.quote`, mount `QuotedPostEmbed`; `onOpen(quote.id)` → `/post/<id>/`.
- [ ] **Inline `ReplyComposer` (§5.1):** pinned under the focal; `mode='reply'`, `replyTo=focal`; submit
      `submitReply` → `Microblog.post_message(text, parent: Some(focal.id))`; clears + stays open on success;
      optimistic pending card appended to replies; swap `clientId`→real id on `inBestBlock`; rollback + Toast on
      error (preserve draft).
- [ ] **Non-focal Reply → `ComposerModal`:** Reply icon on an ancestor/reply opens a `ReplyComposer` **modal**
      (`replyTo`=that card) via the modal-route host (`01-information-architecture.md` §7).
- [ ] **Card actions (§5):** wire Like (`submitVote Up` / `submitClearVote`), Down-vote (overflow,
      `submitVote Down`), Repost (`submitRepost`, permanent — disable once reposted), Quote (`submitQuote` via
      `QuoteComposer`), Share-link (copy `/post/<id>/`, success Toast); all optimistic per `04-data-layer.md` §3.3.
- [ ] **Session gate (§6.1, cite `04-data-layer.md` §5.2):** `not-connected` → `ConnectWalletButton`;
      `connected_unbound` → finish-setup bind prompt in the composer; `ready` → active; `bound_no_stake` Like still
      registers at weight 0 (no block).
- [ ] **Capacity / rate-limit (§7, cite `04-data-layer.md` §4):** `draftStatus` gates the Reply CTA;
      `RateLimitNotice` inline copy; reactive `ExhaustsResources` → error Toast + rollback; never a battery/percentage.
- [ ] **Load/empty/error states (§6.2/§6.3):** skeleton thread on load; "No replies yet. Be the first." empty;
      `NotFoundInline kind="post"` for invalid/unknown id; "Couldn't load this post." + Retry on fetch error.
- [ ] **Scroll-to-focal + ancestor stability (§6.4):** scroll the focal into view once on mount; preserve the
      focal's position when ancestors hydrate above it; move keyboard/SR focus to the focal article.
- [ ] **Sticky header (§6.4, cite `01-information-architecture.md` §8):** back-arrow (`IconBack`) + "Post";
      `history.back()` else `router.push('/')`; `position:sticky` + backdrop blur.
- [ ] **Responsive (§8):** verify mobile single-column (BottomTabBar + ComposeFab), tablet collapsed rail (no
      RightRail), desktop 3-column with the center column as the scroll container.
- [ ] **Accessibility (§9):** `<section aria-label="Conversation">`; focus the focal on mount; `aria-label`/
      `aria-pressed` on action buttons; `role="group"` stats row with humanized `aria-label`; `j/k/l/r/t/./Esc/n`
      shortcuts inert in inputs; focus ring; reduced-motion guards.
- [ ] **Deploy/deep-link acceptance (cite `01-information-architecture.md` §3):** after `npm run build` +
      `rsync … out/ /var/www/cogno/`, confirm a fresh-tab deep link `https://<host>/post/<realId>/` boots the shell
      and renders the thread (nginx `try_files … /404.html` fallback); `/post/<realId>` (no slash) also resolves;
      `/post/<junk>/` shows the in-app not-found.
- [ ] **Notifications seam (§10):** leave the labeled deferred comment at the action/composer mutation sites; do not
      build the surface.
- [ ] **Tests (Vitest, mocks per `app/README.md`):** unit-test the ancestor-walk loop (stops at root / at
      `MAX_ANCESTORS` / on dangling parent), `THREAD` → `PostVM[]` mapping (bigint discipline, no `deleted`),
      oldest-first reply ordering, optimistic reply insert/confirm/rollback, and the `humanizeWeight` score formatter
      (negative + large u128).
```
