# 06 — Surface: Home Timeline (`/`)

The **Home** surface is the default landing route of the cogno-chain X-clone: a dense, single-column,
reverse-chronological feed of `PostCard`s under a sticky, backdrop-blurred header carrying the
**`TimelineTabs`** strip — **For you** (global recency, optionally score-ranked) and **Following**
(posts authored by accounts the connected viewer follows, via `Follow` edges). On desktop an inline
`Composer` sits at the top of the column and collapses on scroll; on mobile composing is the floating
`ComposeFab`. The feed is **infinite-scroll** when an indexer is configured (`caps.pagination`) and a
**capped live snapshot** on PAPI-direct. New live items surface a Twitter-style **"Show N posts"** pill
at the top instead of jumping the scroll. Every write (Post / Reply / Quote / Like / Repost / Follow /
Poll) is **optimistic** — it appears instantly and reconciles or rolls back — and the only chain
realities we surface are a graceful `RateLimitNotice` when talk-capacity is exhausted and a quiet
failure `Toast`. The honesty/trust layer is dropped entirely (no block numbers, no "signed ≠ finalized",
no operator labels). This doc cites `01-information-architecture.md` (shell, breakpoints, sticky header,
scroll, modal routes), `02-design-system.md` (`--cg-*` tokens), `03-component-library.md` (component
props), `04-data-layer.md` (queries, mutations, hooks, caps, session states), and
`05-divergences-and-constraints.md` (D1–D12).

---

## 1. Purpose & route

| | |
|---|---|
| **Route** | `/` → `HomePage` (`src/app/page.tsx`, a Client Component; see `01-information-architecture.md` §3) |
| **Page component** | `HomePage` |
| **Default landing** | yes — the app boots here |
| **Auth** | reads are **public** (works `disconnected`); writes funnel to connect → bind per `04-data-layer.md` §5.2 |
| **Owns** | the `Timeline` + `TimelineTabs` composition, the inline home `Composer`, the new-posts pill, the home feed's keyboard nav, scroll-collapse of the composer, and the home data wiring |
| **Does NOT own** | `AppShell` / `LeftNav` / `RightRail` / `BottomTabBar` / `ComposeFab` chrome (owned by `01-information-architecture.md`); `PostCard` internals (`03-component-library.md` §1); the `Composer` family internals (`03-component-library.md` §7); the data seam, queries, mutations, hooks (`04-data-layer.md`) |

> **Static export note.** `/` is a fully static page; all data is fetched **client-side** from effects
> (PAPI ws + optional GraphQL `fetch`). No SSR, no server data fetching, no API routes
> (`04-data-layer.md` §8). The `AppShell` (with the persistent ws + `source.watch()` subscription)
> survives client nav; only `<main>{children}</main>` swaps (`01-information-architecture.md` §4).

---

## 2. ASCII wireframes

### 2.1 Desktop (≥ 1020px) — full 3-column

Per `01-information-architecture.md` §5.2, `LeftNav` and `RightRail` are `position: sticky; top:0;
height:100vh` and the **center column is the scroll container** (`overflow-y:auto; height:100vh`). The
home surface owns only the center column's contents.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  ┌─────────────────┐   ┌──────────────────────────────┐   ┌──────────────────────────┐     │
│  │  LeftNav        │   │  main (max 600px, SCROLLS)    │   │  RightRail (~350px)      │     │
│  │  (sticky)       │   │ ┌──────────────────────────┐ │   │ ┌──────────────────────┐ │     │
│  │  [cogno mark]   │   │ │ STICKY HEADER (blur 12px)│ │   │ │  🔍 Search cogno     │ │     │
│  │  ◉ Home         │   │ │  ┌────────┬────────────┐ │ │   │ └──────────────────────┘ │     │
│  │  ○ Explore      │   │ │  │For you │ Following  │ │ │ ← │ ┌──────────────────────┐ │     │
│  │  ○ Profile      │   │ │  └━━━━━━━━┴────────────┘ │ │   │ │ Who to follow        │ │     │
│  │  ○ Settings     │   │ └──────────────────────────┘ │   │ │  (•) Name   [Follow] │ │     │
│  │  ┌────────────┐ │   │ ┌──────────────────────────┐ │   │ │  (•) Name   [Follow] │ │     │
│  │  │   Post     │ │   │ │ Composer (inline)        │ │   │ │  (•) Name   [Follow] │ │     │
│  │  └────────────┘ │   │ │ (•) What's happening?    │ │   │ │  Show more →         │ │     │
│  │  [Account mini] │   │ │            [ Post ]      │ │   │ └──────────────────────┘ │     │
│  └─────────────────┘   │ ├──────────────────────────┤ │   │ (footer: theme · About)  │     │
│                        │ │ ⟂ Show 3 posts           │ │   └──────────────────────────┘     │
│                        │ ├──────────────────────────┤ │  ← new-posts pill (when live items)  │
│                        │ │ PostCard ────────────────│ │                                      │
│                        │ │ PostCard ────────────────│ │  ← hairline --cg-border dividers,    │
│                        │ │ PostCard ────────────────│ │    hover row tint --cg-bg-hover      │
│                        │ │ PostCard ────────────────│ │                                      │
│                        │ │  … infinite scroll …      │ │                                      │
│                        │ │ ┌──────────────────────┐ │ │                                      │
│                        │ │ │   ◌ loading more…     │ │ │  ← Spinner md (caps.pagination)      │
│                        │ │ └──────────────────────┘ │ │                                      │
│                        │ └──────────────────────────┘ │                                      │
│                        └──────────────────────────────┘                                      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

After the user scrolls the center column down past the composer, the inline `Composer` **collapses**
into a thin one-line "What's happening?" affordance pinned just under the tabs (X-exact); clicking it
re-expands it (or opens `ComposerModal`). See §6.4.

### 2.2 Tablet (688–1019px) — collapsed icon rail, no RightRail

`RightRail` is not rendered; the center column fills the remaining width (no 600px cap per
`01-information-architecture.md` §5.3). Search moves to `/explore`.

```
┌────────────────────────────────────────────────────────────────────┐
│  ┌──────┐   ┌──────────────────────────────────────────────────┐   │
│  │ Left │   │  main (fills width, SCROLLS)                     │   │
│  │ rail │   │ ┌────────────────────────────────────────────┐  │   │
│  │ [◈]  │   │ │ STICKY HEADER  [ For you │ Following ]      │  │   │
│  │ ◉    │   │ ├────────────────────────────────────────────┤  │   │
│  │ ○    │   │ │ Composer (inline)                          │  │   │
│  │ ○    │   │ ├────────────────────────────────────────────┤  │   │
│  │ ○    │   │ │ ⟂ Show 3 posts                             │  │   │
│  │ (+)  │   │ ├────────────────────────────────────────────┤  │   │
│  │ [av] │   │ │ PostCard ─────────────────────────────────│  │   │
│  └──────┘   │ │ PostCard ─────────────────────────────────│  │   │
│             │ │  … infinite scroll …                       │  │   │
│             │ └────────────────────────────────────────────┘  │   │
│             └──────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

### 2.3 Mobile (< 688px) — top bar + tabs + FAB + bottom tabs

The **document** scrolls (not a center column); the top bar + `TimelineTabs` are `position:sticky`, the
`BottomTabBar` + `ComposeFab` are `position:fixed` (`01-information-architecture.md` §5.4). The inline
desktop composer is **not** rendered on mobile — composing is the FAB.

```
┌───────────────────────────────┐
│ ┌───────────────────────────┐ │ ← sticky top bar (blur): (av) ◈ cogno   ⚙
│ │ (av)    ◈ cogno      ⚙    │ │
│ ├───────────────────────────┤ │
│ │   [ For you │ Following ] │ │ ← TimelineTabs pinned under bar (sticky)
│ ├───────────────────────────┤ │
│ │  ⟂ Show 3 posts           │ │ ← new-posts pill (full-width tap target)
│ ├───────────────────────────┤ │
│ │ PostCard ─────────────────│ │
│ │ PostCard ─────────────────│ │ ← document scrolls, single column, full bleed
│ │ PostCard ─────────────────│ │
│ │  … infinite / window …     │ │
│ │                       ( + )│ │ ← ComposeFab (fixed, above bottom bar)
│ ├───────────────────────────┤ │
│ │  ⌂      🔍      ◎      ⚙   │ │ ← BottomTabBar (fixed)
│ └───────────────────────────┘ │
└───────────────────────────────┘
```

---

## 3. Component composition

All names are canonical (`03-component-library.md`); reuse verbatim, do not redefine.

```
HomePage (src/app/page.tsx, 'use client')
└─ <main> (the surface; center column on desktop)
   ├─ HomeStickyHeader            ── sticky top:0, backdrop blur(12px) over --cg-header-bg (§6.1)
   │   └─ <TimelineTabs active={'for-you'|'following'} onChange=… />   ── 03 §22.1
   ├─ <Composer mode="post" variant="inline" … />                      ── 03 §7 (DESKTOP/TABLET only; §6.4)
   │     (collapses to one-line affordance on scroll; hidden on mobile <688px)
   ├─ <NewPostsPill count={pendingCount} onClick={flushPending} />     ── home-owned (§6.5)
   └─ <Timeline                                                        ── 03 §22.1
        posts={visiblePosts}
        viewer={viewer}
        loading={loading}
        hasMore={hasMore}            // caps.pagination
        onLoadMore={loadMore}
        onOpen / onReply / onQuote / onLike / onDownvote / onRepost / onShare / onAuthorOpen
        keyboardNavOwner            // j/k/n/l/r/t/Enter/.  (§8)
      >
        for each post → <PostCard variant="timeline" … />              ── 03 §1
           ├─ <PostCardHeader/>  ├─ <PostBody/>
           ├─ <QuotedPostEmbed/> (if post.quote)  OR  <PollCard/> (if post.isPoll)
           └─ <PostCardActions/>  (Reply · Repost · Quote · Like · Share)
        empty   → <EmptyState variant="feed" … />                      ── 03 §18
        loading → <Skeleton variant="post" count={8} />                ── 03 §19
        tail    → <Spinner size="md" />                                ── 03 §19
```

- The **`Composer`** here is opened in inline mode; the full-page / modal composer (`/compose`,
  `ComposerModal`, `ReplyComposer`, `QuoteComposer`, `PollComposer`) is owned by the compose surface
  (`09-surface-compose.md`) and triggered from `LeftNav` "Post" / `ComposeFab` / `PostCardActions` callbacks.
  This surface only mounts the **inline post composer** at the top of Home.
- `RightRail` (`SearchBar` + Who-to-follow) is owned by `01-information-architecture.md` §6.3 and is
  rendered by `AppShell`, **not** by `HomePage`. Home only supplies the center column. (Its data wiring
  via `WHO_TO_FOLLOW` is summarized in §5.6 for completeness because it sits beside the home feed.)

---

## 4. Tabs — For you / Following (semantics)

Per `05-divergences-and-constraints.md` D2/D8 and `03-component-library.md` §22.1:

| Tab | Semantics | Data | Notes |
|---|---|---|---|
| **For you** | Global **reverse-chronological** feed (newest post id first). **There is no ranking algorithm** — "For you" is just the global feed (state this divergence to the user nowhere; it just behaves like a normal feed). Optional **top-by-score** ordering is available when an indexer is configured. | `order:"recency"` (default) or `order:"score"`; see §5.2 | Default active tab. PAPI-direct OK (live `watch()` snapshot). |
| **Following** | Posts **authored by accounts the connected viewer follows** (via `Follow` edges). | `tab:"following"`, resolve `followEdges(who).following` then `filter:{ authorId:{ in: followees } }`; see §5.3 | **Requires `caps.follows`** → **indexer-only**. Hidden / disabled on PAPI-direct (§5.5). Empty states in §7. |

- The active tab is **client state** in `HomePage` (default `'for-you'`); switching tabs is **not** a
  route change (no query param, no navigation) — it swaps the `FeedQuery` and re-fetches/re-watches.
- Tab strip is sticky under the header (desktop) / under the top bar (mobile). Active tab gets the
  `--cg-accent` underline indicator (X-exact: a 4px-tall pill under the active label).
- On `disconnected`, the **Following** tab is still visible but its panel renders an `EmptyState`
  prompting connect (§7.2) — do **not** hide the tab when disconnected; only hide it when the active
  source is PAPI-direct (`caps.follows === false`), per §5.5.

---

## 5. Data bindings (cite `04-data-layer.md`)

All reads go through the `FeedSource` seam and the home hooks; **never** import a concrete reader.
Component view-models are the canonical `PostVM` / `AuthorVM` / `Viewer` (`03-component-library.md`
§0.4), assembled by the data layer from `CognoPost` (`04-data-layer.md` §2.1).

### 5.1 Source & hooks wiring

```ts
// HomePage
const { api, client } = useChain();                       // 04 §7.1
const graphqlUrl = useSettings().graphqlUrl;              // /settings config; may be ''
const source = useFeedSource(api, graphqlUrl);            // 04 §7.2 → FeedSource | null
const viewer: Viewer = useViewer();                       // derived in AppShell from useSigner+useIdentity (04 §5)

const [tab, setTab] = useState<'for-you' | 'following'>('for-you');
const [order, setOrder] = useState<'recency' | 'score'>('recency');

// live snapshot + optimistic overlay (so a pending card isn't clobbered by the next poll)
const { snapshot, ready, error } = useOptimisticFeed(source, pendingOverlay); // 04 §2.11 / §7.2

// the visible-id set drives the filled-heart / active-repost icons:
const viewerStates = useViewerStates(source, visibleIds, viewer.address);     // 04 §2.9 / §7.2
```

The home feed has two read modes depending on the active tab + reader, both behind the seam:

- **Live mode** (For you, default): `useOptimisticFeed` wraps `useFeed(source)` (`source.watch()`),
  which polls the indexer every 6 s or `watchEntries` on PAPI (`04-data-layer.md` §2.11). New items
  arriving in `watch()` are **buffered** behind the new-posts pill (§6.5) rather than injected, so the
  scroll never jumps.
- **Paged mode** (Following, or For-you "load more"): `useFeedPage(source, query, enabled)` for
  cursor pagination (`04-data-layer.md` §7.1), gated on `caps.pagination`.

### 5.2 For you — the `FEED` query (cite `04-data-layer.md` §2.2)

Reproduced verbatim from `04-data-layer.md` §2.2 (the canonical `FEED` constant in
`lib/graphql/queries.ts`):

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

Variables for **For you**:

| Variable | Value | Rationale |
|---|---|---|
| `first` | `30` (initial), `30` per page | X loads ~25–30 posts per window |
| `after` | `null` (first page), then `pageInfo.endCursor` | cursor pagination, gated `caps.pagination` |
| `orderBy` | `["ID_DESC"]` for `order:"recency"`; `["SCORE_DESC","ID_DESC"]` for `order:"score"` | `ID_DESC` is the stable default (post id == time order on one chain); `04-data-layer.md` §2.2 |
| `filter` | `{}` (top-level **and** replies appear, matching X "For you") | `04-data-layer.md` §2.2; do NOT add `parentId:{isNull:true}` on Home For-you |

> **No `deleted` field anywhere** (`04-data-layer.md` §1; `05-divergences-and-constraints.md` D10).
> Banned authors are flagged via `author.banned` and their posts **stay** (dimmed, not hidden).

Mapping `FEED` nodes → `CognoPost` → `PostVM` uses `nodeToPost` (`04-data-layer.md` §2.2). **u64
discipline:** `id`/`parentId`/`quote.id` → `BigInt`; `upWeight`/`downWeight`/`score`/`weight` →
`BigInt`; never `Number(...)` a u64/u128 (lovelace > 2^53). `PostVM.id` is the u64 as a **string**.

### 5.3 Following — followee resolution then `FEED`

The indexer has no single `followeeOf` filter (`04-data-layer.md` §2.2). The hook resolves the
followee set first, then pages `FEED`:

```ts
// useFollow(api, signer, source, viewer.address).following  →  Ss58[]   (FOLLOW_EDGES, 04 §2.10/§7.2)
const followees = followEdges.following;            // capped at 1000 (v1; note follow-up)
const query: FeedQuery = {
  tab: 'following',
  first: 30,
  after: cursor,
  order: 'recency',
  // resolved into FEED variables:
  //   orderBy: ["ID_DESC"]
  //   filter:  { authorId: { in: followees } }
};
```

`FOLLOW_EDGES` (cite `04-data-layer.md` §6 query table / §2.10) supplies `following`. If the viewer
follows **nobody**, render the `follows` empty state (§7.2) without issuing the `FEED` query. The
`in`-list is capped at **1000** accounts (Following timelines beyond that paginate the followee set —
out of v1 scope; note the follow-up). `order` is always `recency` for Following.

### 5.4 PAPI-direct fallback (For you only)

When `source.kind === 'papi'` (no GraphQL URL configured):

- **For you** works via `source.watch()` → `watchEntries`: a **single live capped snapshot** (the recent
  window), **no cursor pagination** (`caps.pagination === false`) and **no search** — `hasMore` is
  `false` and `Timeline` shows a quiet footer "Connect an indexer to load more"
  (`03-component-library.md` §22.1).
- Per-card tallies are read **lazily per visible card** via `social-reads.ts`
  (`readPostTally`/`readRepostCount`, `04-data-layer.md` §2.4) rather than eagerly for all rows, because
  the node has no batch endpoint. `caps.tallies === true` on PAPI-direct, so like/score counts still
  render (lazily).
- Viewer state (filled heart / active repost) is read per visible card via
  `readViewerPostState(api, id, who)` (`04-data-layer.md` §2.9), batched with `Promise.all`.
- **Following is unsupported** on PAPI-direct (`caps.follows === false`) → §5.5.

### 5.5 Capability gating (cite `04-data-layer.md` §2.3)

The home surface reads `source.caps` and hides what the active reader cannot honestly serve — **no
"reads: indexer" badge** (trust layer dropped); we simply hide the affordance:

| Home affordance | indexer (`graphql`) | PAPI-direct (`papi`) | Cap |
|---|:--:|:--:|---|
| For you feed (live) | ✅ (poll) | ✅ (`watchEntries`) | always |
| **Following tab** | ✅ | ❌ **hide the tab** (render only For you) | `follows` |
| "Show N posts" new-posts pill | ✅ | ✅ | always (both have `watch()`) |
| Infinite scroll / load more | ✅ | ❌ single window + quiet footer | `pagination` |
| Like / score counts on cards | ✅ eager | ✅ lazy per card | `tallies` |
| Poll bars (`PollCard`) | ✅ | ✅ (read `Polls`+`PollTally`) | `tallies` |
| Author display name / avatar on cards | ✅ | ❌ fallback to ss58 + identicon | `profiles` |
| Who-to-follow (RightRail) | ✅ | ❌ rail omits the block | `whoToFollow` |

> **Following-tab hide rule:** when `source.caps.follows === false`, `TimelineTabs` renders **only the
> "For you" tab** (no disabled/greyed "Following"); the home surface defaults `tab='for-you'` and
> ignores any persisted `'following'` selection. This is the same "hide what you can't serve" rule as
> the rest of the app — never a greyed control with an explanation.

### 5.6 RightRail data (who-to-follow) — adjacent, owned by `AppShell`

For completeness (the rail sits beside this feed): `RightRail` reads `WHO_TO_FOLLOW`
(`04-data-layer.md` §2.10) via `useWhoToFollow(source, viewer.address, 3)`, filtering out self +
already-followed client-side. Gated on `caps.whoToFollow` (indexer-only). PAPI-direct → the rail omits
the block (never an empty trends box). `HomePage` does **not** render the rail; `AppShell` does.

### 5.7 Viewer-relative state on cards (cite `04-data-layer.md` §2.9)

To fill the heart (you liked it) and the repost icon (you reposted), the surface batch-fetches the
viewer's own vote/repost over the visible post-id set via `useViewerStates`
(`VIEWER_STATES` indexer / `readViewerPostState` PAPI). Reproduced from `04-data-layer.md` §2.9:

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

Absence ⇒ `{ myVote: null, reposted: false }`. Optimistic writes (§6) update this state **immediately**;
this read is the **reconciliation source of truth** after `inBestBlock`.

---

## 6. Interactions → extrinsics (cite `04-data-layer.md` §3)

Every interaction on Home maps to **exactly one** extrinsic via `lib/chain/mutations.ts`
(`04-data-layer.md` §3.1). All social writes are **feeless + capacity-metered**; the optimistic delta
applies instantly, then confirms at `inBestBlock` or rolls back on error with a `Toast`
(`04-data-layer.md` §3.3). Gating per `04-data-layer.md` §5.2 (connect → bind → write).

| Interaction (Home) | Component / trigger | Mutation fn | Extrinsic | Arg shape | Cost |
|---|---|---|---|---|---|
| **Post** (inline composer) | `Composer` "Post" CTA | `submitPost` | `Microblog.post_message` | `{ text: Binary.fromText(s), parent: undefined }` | feeless + cap |
| **Reply** | `PostCardActions` Reply → `ReplyComposer` | `submitReply` | `Microblog.post_message` | `{ text, parent: Some(targetId:bigint) }` | feeless + cap |
| **Quote** | `PostCardActions` Quote → `QuoteComposer` | `submitQuote` | `Microblog.quote_post` | `{ text: Binary.fromText(s), quoted_id: bigint }` | feeless + cap |
| **Like** (heart) | `PostCardActions` Like | `submitVote('Up')` | `Microblog.vote` | `{ post_id: bigint, dir: { type:"Up" } }` | feeless + cap |
| **Unlike** | Like (active) → clear | `submitClearVote` | `Microblog.clear_vote` | `{ post_id: bigint }` | feeless + cap |
| **Downvote** (secondary) | `PostCardHeader` `[···]` overflow | `submitVote('Down')` | `Microblog.vote` | `{ post_id, dir: { type:"Down" } }` | feeless + cap |
| **Repost** (permanent) | `PostCardActions` Repost → confirm | `submitRepost` | `Microblog.repost` | `{ post_id: bigint }` | feeless + cap |
| **Follow / Unfollow** | RightRail / Who-to-follow `FollowButton` | `submitFollow` / `submitUnfollow` | `Microblog.follow` / `Microblog.unfollow` | `{ target: ss58 }` | feeless + cap |
| **Create poll** | `Composer` poll mode (`PollComposer`) | `submitCreatePoll` | `Microblog.create_poll` | `{ question: Binary.fromText(q), options: options.map(Binary.fromText) }` | feeless + cap |
| **Cast poll vote** | `PollCard` option | `submitPollVote` | `Microblog.cast_poll_vote` | `{ post_id: bigint, option: u8 }` | feeless + cap |

> **VoteDir encoding:** `{ type: "Up" }` / `{ type: "Down" }` (PAPI enum encoding, `04-data-layer.md`
> §3.1). **Like == on-chain UP vote**; un-like == `clear_vote`; **down-vote is the SECONDARY action** in
> the `[···]` overflow (`05-divergences-and-constraints.md` D2). The inline heart count = `upCount`; the
> weighted score (`upWeight − downWeight`, may be negative) is shown **only on `/post/[id]`**, never on
> Home cards.

### 6.1 Sticky header

Per `01-information-architecture.md` §8: `HomeStickyHeader` is `position:sticky; top:0;
z-index:var(--cg-z-sticky)` with `backdrop-filter: blur(var(--cg-header-blur))` over translucent
`--cg-header-bg` (X-exact glassy header). Contents:

- **Desktop:** the title row is minimal; the **`TimelineTabs`** strip (For you / Following) is the
  prominent sticky element (`01-information-architecture.md` §8 table, `/` row).
- **Mobile:** the top bar carries `(avatar) ◈ cogno (gear)`; **`TimelineTabs`** pins as the second
  sticky row beneath it.

### 6.2 New-post insertion from the inline composer (optimistic)

When the viewer posts from the inline `Composer` (`submitPost`):

1. **APPLY** — insert a **pending `PostCard`** (clientId, `PostVM.pending = true`, rendered at
   `opacity:0.6` per `02-design-system.md` optimistic grammar) at the **top of the feed**, above the
   pill. Clear the composer text.
2. **SUBMIT** `submitPost`; subscribe to the `TxUpdate` phase stream (`04-data-layer.md` §3.2).
3. **inBestBlock (ok)** — swap the pending clientId card for the **real id** extracted from
   `PostCreated` (`postId` in `TxUpdate`); fade `opacity:0.6 → 1` (`cg-like-pop`/fade-in, reduced-motion
   guarded). **Silent success** — no "Posted!" toast (`04-data-layer.md` §3.4).
4. **finalized** — no UI change (already shown at best-block; Twitter-speed).
5. **invalid / error** — **remove** the pending card, **restore** the composer text, raise a failure
   `Toast` (or `RateLimitNotice` toast for `ExhaustsResources`; §9).

> The pending card lives in the **optimistic overlay** (`04-data-layer.md` §2.11), keyed by clientId, so
> the next live `watch()` poll does not clobber it before it confirms. On confirm the overlay entry is
> dropped and the real row (now carried by `watch()`) takes over.

### 6.3 Like / Repost / Follow optimistic deltas (cite `04-data-layer.md` §3.3)

Applied instantly on click, reconciled from `viewerPostState`/tally after `inBestBlock`, rolled back on
error:

- **Like** → `myVote="Up"`, `upCount+1`, `upWeight += votingPower` (the viewer's `TalkStake.VotingPower`
  snapshot from `useIdentity`; **not** `AllowedStake`). If `votingPower === 0n` (bound, unstaked), the
  vote still registers (`myVote="Up"`, `upCount+1`) with **0** weight — the chain accepts a zero-weight
  vote (`05-divergences-and-constraints.md` D2/D12). Re-vote **replaces** (reverse prev weight, apply
  new). **Unlike** = `clear_vote` (`NotVoted` ⇒ rollback).
- **Repost** → `reposted=true`, `repostCount+1`; **permanent** — after success the Repost button is
  **disabled** (`AlreadyReposted` guard; never offer un-repost; `05-divergences-and-constraints.md` D3).
  Repost requires a confirm popover ("Repost — this can't be undone") before submitting.
- **Follow** (from the rail) → `following.add(target)`, optimistic; `unfollow` toggles back. The write
  path is **never** gated by reader caps — follow is a chain extrinsic available to any `bound` viewer
  even on PAPI-direct; only the **read** of follower/following counts is gated (`04-data-layer.md`
  §7.2).

### 6.4 Inline composer collapse-on-scroll

X collapses the inline composer once you scroll the timeline. Behavior (desktop/tablet only; mobile uses
the FAB):

- At scroll offset `0`, the inline `Composer` is **expanded** (avatar + growing textarea + `ByteCounter`
  + "Post" CTA, `03-component-library.md` §7).
- After the center column scrolls past a threshold (~the composer's own height), it **collapses** to a
  single-line affordance under the tabs: `(viewer avatar) What's happening?` with a small accent "Post"
  pill on the right. Clicking the collapsed bar **re-expands** it in place (or opens `ComposerModal` —
  pick re-expand-in-place to match X; `ComposerModal` remains the FAB/LeftNav path).
- Collapse is a pure CSS/scroll-position concern in the center scroll container; it must not steal focus
  or lose draft text. Under `prefers-reduced-motion`, collapse is instant (no height transition).

### 6.5 New-posts pill ("Show N posts")

When the live `watch()` snapshot gains **fresh top-of-feed items** while the user is scrolled (or even
at top), X **does not** auto-inject them; it shows a pill. Home behavior:

- New items from `watch()` are **buffered** in a `pendingCount` (not rendered into `Timeline`).
- `NewPostsPill` renders sticky at the top of the feed (just under the tabs): `⟂ Show N posts` (X shows
  stacked avatars + count; we show `Show {N} posts`). `02-design-system.md` accent fill (`--cg-accent` /
  `--cg-accent-contrast`), `--cg-radius-pill`, centered.
- **Click** → `flushPending()`: merge buffered items into the visible list, scroll the center column to
  top (smooth; instant under reduced-motion), reset `pendingCount=0`, hide the pill.
- The pill is **suppressed for the viewer's own optimistic post** (that one is injected directly per
  §6.2, not buffered) — only *other* accounts' new posts buffer behind the pill.
- The pill appears on both readers (both have `watch()`). On PAPI-direct, "fresh items" = new entries in
  the `watchEntries` window since last flush.

---

## 7. States (exhaustive)

The home surface must handle every state below. States compose with the §5.5 cap gating and the
§6 optimistic lifecycle.

### 7.1 For you tab states

| State | Render |
|---|---|
| **loading (initial)** | `Timeline` shows `Skeleton variant="post" count={8}` (`03-component-library.md` §19), container `aria-busy`. No tabs flicker — header + tabs render immediately. |
| **empty** (no posts on chain) | `EmptyState variant="feed"`: "Welcome to cogno-chain" / "This is the best place to see what's happening. Find some people to follow." + `[Explore]` CTA → `/explore` (`03-component-library.md` §18). |
| **populated** | the feed of `PostCard`s, hairline dividers, hover row tint. |
| **optimistic-pending** (own new post) | the pending card at `opacity:0.6` at top (§6.2). |
| **loading more (tail)** | `Spinner size="md"` at the list tail (`caps.pagination`); PAPI-direct shows the quiet "Connect an indexer to load more" footer instead. |
| **error** (feed fetch failed) | inline error row + a "Retry" button at the top of the list; keep any already-rendered cards. Raise no toast (this is a passive read failure, not a user action). On PAPI-direct ws drop, `useChain.status` drives a reconnect; show a slim "Reconnecting…" line (no honesty framing). |
| **rate-limited** (a write from this surface) | per-action: the failed write rolls back and a `RateLimitNotice` toast fires (§9); the feed itself is unaffected. |

### 7.2 Following tab states

| State | Render |
|---|---|
| **not-connected** (`disconnected`) | `EmptyState`: "Follow people to see their posts" / "When you connect and follow accounts, their posts show up here." + a `ConnectWalletButton` (`03-component-library.md` §20). The tab is **visible** but its panel prompts connect (do not hide the tab when disconnected — only when PAPI-direct, §5.5). |
| **connected, follows nobody** | `EmptyState variant="follows"`: "Not following anyone yet." + `[Find people to follow]` → `/explore`. (`useFollow.following` is empty ⇒ skip the `FEED` query entirely, §5.3.) |
| **loading** | `Skeleton variant="post" count={8}`. |
| **populated** | the followees' posts (recency). |
| **PAPI-direct** (`caps.follows===false`) | the **tab does not exist** (`TimelineTabs` renders For-you only; §5.5). |
| **error / rate-limited** | as §7.1. |

### 7.3 Per-card states

Owned by `PostCard` / `PostCardActions` (`03-component-library.md` §1/§3), but the home surface must pass
the data that drives them: `viewer.status` gate (`not-connected` → write affordances route to
`ConnectWalletButton`; `not-identity-bound` → route to the finish-setup bind; `ready` → enabled, per
`04-data-layer.md` §5.2), `viewerVote`/`viewerReposted` from §5.7, `post.pending` for optimistic cards,
and `post.author.banned` for the **dimmed** banned-author treatment (`--cg-text-muted`, posts **kept**,
never hidden; `05-divergences-and-constraints.md` D10).

### 7.4 Not-connected / not-bound write affordances (cite `04-data-layer.md` §5.2)

The inline `Composer` "Post" CTA and every `PostCardActions` write button gate on `viewer.status`:

- **`disconnected`** → the affordance shows/triggers `ConnectWalletButton` (or routes to `/welcome`);
  the action is **deferred** (no auto-replay after connect in v1 — note the follow-up).
- **`connected_unbound` / `not-identity-bound`** → the inline composer shows a "Finish setting up your
  account to post" inline prompt with a **Bind** button calling `useIdentity.bind(walletId)` (feeless
  **unsigned bare** `CognoGate.link_identity_signed`; `04-data-layer.md` §5.3). Action buttons route to
  the same finish-setup step.
- **`bound` / `bound_no_stake` / `bound_staked`** → full write. `bound_no_stake` can post **and** vote
  (votes carry 0 weight); a subtle "Add voting power" prompt may link to `/settings` — no nag, no
  honesty framing.

---

## 8. Accessibility & keyboard

The home surface **owns the feed keyboard nav** (`03-component-library.md` §0.5 explicitly delegates
`j/k/n/l/r/t/Enter/.` to this surface; cards expose `data-post-id`, `tabIndex`, and ref hooks). Match X's
shortcuts:

| Key | Action |
|---|---|
| `j` | move focus to the **next** post (down) |
| `k` | move focus to the **previous** post (up) |
| `n` | open the **composer** (inline expand on desktop, `ComposerModal`/FAB sheet on mobile) — "new post" |
| `Enter` / `o` | **open** the focused post → `/post/[id]` |
| `l` | **Like** the focused post (toggle up-vote) |
| `r` | **Reply** to the focused post (open `ReplyComposer`) |
| `t` | **Repost** the focused post (opens the permanent-repost confirm) |
| `.` | load new posts (**flush the new-posts pill**) and scroll to top |
| `/` | focus the `SearchBar` (desktop RightRail) or route to `/explore` (tablet/mobile) — owned by the shell, listed here for completeness |
| `g` then `h` | go Home (no-op when already on `/`) |

Focus & ARIA:

- The currently-focused post via `j/k` gets a **2px `--cg-accent` left-border marker** + the focus ring
  (`03-component-library.md` §1 "focus (row)"); `aria-current` is **not** set (it is not navigation).
  Manage a roving `tabIndex` (focused card `tabIndex=0`, others `-1`).
- `TimelineTabs` is a real `role="tablist"` with `role="tab"` buttons (`aria-selected`), arrow-key
  navigable; the panel below is `role="tabpanel"`.
- The new-posts pill is a real `<button>` with `aria-label="Show {N} new posts"`; it is **not** a focus
  trap and does not steal focus when it appears.
- Skeleton container `aria-busy="true"`; `Toaster` is `aria-live="polite"`; `RateLimitNotice` is
  `role="status"` (`03-component-library.md` §0.5/§17).
- All interactive elements are real `<button>`/`<a>`; icon-only buttons carry `aria-label`; toggles
  carry `aria-pressed` (like/repost). Keyboard shortcuts are **disabled while focus is in a text input**
  (the composer) so typing `n`/`l`/`j` types characters.
- Respect `prefers-reduced-motion`: optimistic fade-in, like-pop, skeleton shimmer, composer-collapse,
  and pill scroll-to-top collapse to instant/opacity-only.

---

## 9. Capacity → rate limit on Home (cite `04-data-layer.md` §4)

Talk-capacity is invisible until exhausted; **no `CapacityBattery`** (removed). On Home it surfaces two
ways, both producing the **same** Twitter-style copy:

1. **Proactive (inline composer)** — `useCapacity` + `draftStatus(view, byteLen, K)` gate the "Post" CTA
   (`04-data-layer.md` §4.1). The `Composer` shows a `RateLimitNotice variant="inline"` above its
   actions:
   - `ok` → CTA enabled, no notice.
   - `no_weight` → CTA disabled, "Lock ADA to start posting." → links to `/settings` vault (not a
     battery).
   - `too_long` → CTA disabled, "This is too long to post at your current capacity. Shorten it."
   - `charging` / `wait` → CTA disabled, **"You are over the rate limit. Try again shortly."** The CTA
     auto-re-enables when `useCapacity` estimates regeneration (poll each block; flip `ok`) — **no
     countdown / no N-blocks / no percentage is ever rendered.**
2. **Reactive (the race)** — if a feeless write is rejected at the pool by `CheckCapacity`
   (`ExhaustsResources`), the `TxUpdate` stream emits `error`; the optimistic delta **rolls back** and a
   `RateLimitNotice` **toast** (Toast kind `rate-limit`) fires with the exact same line:
   `"You are over the rate limit. Try again shortly."` (`stringifyError` `ExhaustsResources` branch,
   `04-data-layer.md` §4.2). This applies to like/repost/vote/poll/follow as well as post.

`ByteCounter` (`03-component-library.md` §8) measures **UTF-8 bytes** (`new TextEncoder().encode(s).length`)
against `MaxLength=512` for the post body and hard-blocks the CTA at >512 bytes
(`05-divergences-and-constraints.md` D1/D5).

---

## 10. Responsive behavior (cite `01-information-architecture.md` §5)

| Breakpoint | Home behavior |
|---|---|
| **Mobile < 688px** | Document scrolls. Sticky top bar `(av) ◈ cogno (gear)` + `TimelineTabs` pinned beneath. **No inline composer** — compose via `ComposeFab` (opens `ComposerModal` full-screen sheet). `BottomTabBar` (Home·Explore·Profile·Settings) + `ComposeFab` fixed. New-posts pill full-width tap target under the tabs. |
| **Tablet 688–1019px** | Collapsed icon `LeftNav`, **no `RightRail`**. Center column fills width (no 600px cap). Inline composer present + collapse-on-scroll. Search lives on `/explore`. |
| **Desktop ≥ 1020px** | Full 3-column. `RightRail` appears (`SearchBar` + Who-to-follow). Center column is the scroll container; inline composer + collapse-on-scroll. |
| **Desktop-wide ≥ 1280px** | Center column caps at **600px** (`--cg-col-feed`); rails reach max widths; container caps at `--cg-content-max`. |

- The **center column owns scroll** on desktop/tablet; the **document** owns scroll on mobile
  (`01-information-architecture.md` §4.3/§5.1). The new-posts-pill "scroll to top" targets the correct
  scroller per breakpoint.
- **Scroll restoration** (`01-information-architecture.md` §4.3): persist the home timeline's scroll
  offset (keyed by pathname in `AppShell`); returning from `/post/[id]` restores the prior offset (X
  lands you where you were). Forward nav into a thread scrolls `<main>` to top.

---

## 11. Implementation checklist (ordered)

- [ ] **Scaffold `HomePage`** (`src/app/page.tsx`, `'use client'`); render only the **center column**
      contents (header + tabs + inline composer + new-posts pill + `Timeline`). Do **not** render
      `LeftNav`/`RightRail`/`BottomTabBar`/`ComposeFab` (owned by `AppShell`,
      `01-information-architecture.md`).
- [ ] **Wire the source + hooks** (§5.1): `useChain` → `{ api, client }`; `useFeedSource(api, graphqlUrl)`;
      `useViewer()`; `useOptimisticFeed(source, pendingOverlay)`; `useViewerStates(source, visibleIds, who)`.
- [ ] **Build `HomeStickyHeader`** (§6.1): `position:sticky; top:0` + `backdrop-filter:blur(var(--cg-header-blur))`
      over `--cg-header-bg`; host `TimelineTabs`; mobile variant carries the wordmark + gear.
- [ ] **`TimelineTabs`** (`03-component-library.md` §22.1): `active:'for-you'|'following'`, `onChange`;
      client state in `HomePage` (default `for-you`); accent underline indicator; `role="tablist"`.
- [ ] **Hide the Following tab when `source.caps.follows === false`** (§5.5); ignore a persisted
      `'following'` selection on PAPI-direct.
- [ ] **For you read** (§5.2): page `FEED` with `orderBy:["ID_DESC"]` (or `["SCORE_DESC","ID_DESC"]` for
      `order:"score"`), `filter:{}`, `first:30`, cursor `after`; map via `nodeToPost`; **no `deleted`**;
      BigInt all u64/u128. PAPI-direct → `source.watch()` capped window, `hasMore:false` + quiet footer.
- [ ] **Following read** (§5.3): resolve `followEdges(who).following` (cap 1000), then `FEED` with
      `filter:{ authorId:{ in: followees } }`, `orderBy:["ID_DESC"]`; skip the query when `following`
      is empty (render the follows empty state).
- [ ] **Viewer-relative state** (§5.7): batch `VIEWER_STATES` (indexer) / `readViewerPostState` (PAPI)
      over the visible id set; map to `Map<bigint, ViewerPostState>`; feed `viewerVote`/`viewerReposted`
      into each `PostCard`; refetch on each write confirm.
- [ ] **Inline `Composer`** (§6.4): mount `mode="post"` at the top (desktop/tablet only, hidden < 688px);
      implement **collapse-on-scroll** (expanded at offset 0 → one-line "What's happening?" affordance →
      re-expand on click); preserve draft text + focus; reduced-motion = instant.
- [ ] **Optimistic new-post insertion** (§6.2): pending `PostCard` (clientId, `pending:true`, opacity
      0.6) at top via the optimistic overlay; swap clientId→real id from `PostCreated` at `inBestBlock`;
      remove + restore composer text + failure/rate-limit toast on error.
- [ ] **New-posts pill** (§6.5): buffer fresh `watch()` items into `pendingCount` (exclude the viewer's
      own optimistic post); render `NewPostsPill` (`Show {N} posts`, accent pill, sticky under tabs);
      click/`.` → flush + scroll-to-top + reset; works on both readers.
- [ ] **`Timeline`** (`03-component-library.md` §22.1): render `PostCard variant="timeline"`; hairline
      dividers + hover tint; `loading`→`Skeleton variant="post" count={8}`; `empty`→`EmptyState`;
      tail→`Spinner md` (gated `caps.pagination`, else "Connect an indexer to load more" footer).
- [ ] **Wire per-card interactions → mutations** (§6): `submitPost`/`submitReply`/`submitQuote`/
      `submitVote('Up'|'Down')`/`submitClearVote`/`submitRepost`/`submitCreatePoll`/`submitPollVote` with
      exact arg shapes (`Binary.fromText`, VoteDir `{type:"Up"|"Down"}`, `option:u8`); optimistic
      apply→confirm→rollback (`04-data-layer.md` §3.3). Like uses `votingPower` snapshot for weight.
- [ ] **Repost permanence** (§6.3): confirm popover → `submitRepost`; disable the button after success
      (`AlreadyReposted` guard); never offer un-repost.
- [ ] **Write gating** (§7.4 / `04-data-layer.md` §5.2): route write affordances on `viewer.status`
      (`disconnected`→`ConnectWalletButton`/`/welcome`; `not-identity-bound`→finish-setup bind via
      `useIdentity.bind`; `ready`→enabled). `bound_no_stake` may vote (0 weight).
- [ ] **Capacity → rate limit** (§9): `draftStatus` gates the Post CTA + inline `RateLimitNotice`
      (auto-re-enable on regen, never render a countdown); `ExhaustsResources` reactive → rollback +
      rate-limit `Toast`. `ByteCounter` UTF-8 bytes, hard-block at 512.
- [ ] **Empty/loading/error states** (§7) for both tabs, incl. Following's not-connected /
      follows-nobody / PAPI-direct-hidden cases.
- [ ] **Keyboard nav** (§8): own `j/k/n/Enter/o/l/r/t/.` for the feed (roving `tabIndex`, accent
      left-border focus marker); disable shortcuts while focus is in a text input; `prefers-reduced-motion`
      guards.
- [ ] **Scroll restoration** (§10): center column owns scroll (desktop/tablet) / document (mobile);
      persist+restore the home scroll offset on back-nav from `/post/[id]`.
- [ ] **Banned-author treatment** (§7.3): dim (`--cg-text-muted`) banned authors' cards; keep posts
      visible; never hide; **no `deleted` references** anywhere.
- [ ] **No honesty chrome anywhere on Home**: no block numbers, no finalized chips, no "signed ≠
      finalized", no operator/trusted-follower labels, no `CapacityBattery`/`AnchorStatus`/`HonestyBadge`
      (`00-overview.md` / `05-divergences-and-constraints.md` D5/D11).
- [ ] **Notifications HOOK (deferred):** leave a labeled comment near the tab/nav wiring noting that the
      indexer's `Voted`/`Reposted`/`Followed`/reply-`PostCreated`/quote events targeting the viewer make
      a future `/notifications` surface a clean follow-up (`03-component-library.md` §24); do **not**
      build a bell/badge.
- [ ] **Tests** (Vitest, MeshJS/PAPI mocked): `FEED` variable construction for both tabs/orders; the
      `nodeToPost`→`PostVM` bigint discipline on home rows; optimistic new-post insert/confirm/rollback;
      new-posts-pill buffering (own post excluded); Following-tab hide on `caps.follows===false`;
      `draftStatus`→CTA/`RateLimitNotice` mapping; keyboard nav focus movement.
