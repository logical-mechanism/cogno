# 10 — Surface: Explore & Search (`/explore`)

The search-first discovery surface, cloning X's `/explore` route. A full-width `SearchBar` sits at
the top; below it, the page has two modes. **Default mode** (no query) shows a "Latest" global
firehose `Timeline` (top-by-score over the recent window, with a recency toggle) and — on desktop —
a "Who to follow" rail; we have **no Trends primitive**, so the firehose + suggestions replace X's
"What's happening". **Query mode** (a term is present) runs an indexer substring search over post
bodies (`text: { includesInsensitive }`) and renders a result `Timeline` under a `People | Latest`
result-scope tab strip. Search is **indexer-only**: it requires `caps.search` (the GraphQL reader);
when the active `FeedSource.kind === 'papi'` we disable the input and render the
`search-unavailable` `EmptyState` instead of faking a client-side scan. The whole surface uses
optimistic UI for any like/repost/follow performed on a result card, surfaces capacity exhaustion as
a `RateLimitNotice`, and carries **no honesty/trust chrome**. See `01-information-architecture.md`
for the route+nginx contract, `02-design-system.md` for `--cg-*` tokens, `03-component-library.md`
for every component referenced here, and `04-data-layer.md` for the exact queries, `FeedCaps`, and
mutations.

---

## 1. Route, page component, and data dependency

| Field | Value |
|---|---|
| Route | `/explore` (and `/explore/` with `trailingSlash:true`) |
| Page component | `ExplorePage` (`src/app/explore/page.tsx`, a `'use client'` Client Component) |
| Owner doc | this doc (`10-surface-explore-search.md`) |
| Search term carrier | `?q=<term>` read **client-side** via `useSearchParams()` — never server-resolved (static export). `01-information-architecture.md` §6.3 pins this: `useSearchParams()` resolves client-side in a static export, so `/explore?q=foo` deep-links correctly through the nginx `try_files $uri $uri/ /404.html` SPA fallback. |
| Data | `source.page({ search })` for query mode and `source.page({ order })` for the default firehose; `source.whoToFollow(who, limit)` for the rail. **Search requires `caps.search`** (`04-data-layer.md` §2.3, §2.5). |
| Auth | Reads are **public** (anyone, even not-connected). Write affordances on result cards (Like/Repost/Quote/Reply/Follow) funnel to `/welcome` when the viewer is `not-connected` or `not-identity-bound` (`01` §auth-gating). |

`ExplorePage` is mounted inside the persistent `AppShell` (`01` §4.1); only `<main>{children}</main>`
swaps on client nav, so the `SearchBar` value and firehose subscription do **not** survive a route
change — they are page-local state, re-derived from `?q=` on mount.

---

## 2. Modes & state model

`ExplorePage` is a small state machine derived from the URL term `q` (from `useSearchParams()`) and
`feedSource.caps.search`:

```
                 caps.search === false
   ┌──────────────────────────────────────────────────────────┐
   │  ANY mode  ─────────────────────────────────►  NO-INDEXER  │  SearchBar disabled +
   └──────────────────────────────────────────────────────────┘  search-unavailable EmptyState
                                                                  (firehose still renders, see §5.4)

   caps.search === true:
        q === ''  ──────────────►  DEFAULT (firehose + who-to-follow)
        q !== ''  ──────────────►  QUERY  (People | Latest result tabs)
```

- **`q`** is the committed search term (mirrored to `?q=`). The `SearchBar`'s controlled `value` is a
  *separate* local `draft` string that debounces into `q` (300 ms) while typing, and commits
  immediately on Enter / submit (which also calls `router.replace('/explore?q=' + encoded)` so the
  URL reflects the term without stacking history — use `replace`, not `push`, for keystroke-driven
  term changes; a fresh navigation *into* `/explore?q=` from `SearchBar` elsewhere is a `push`).
- Clearing the `SearchBar` (`✕`) sets `draft=''`, `q=''`, and `router.replace('/explore')` → returns
  to **DEFAULT** mode.

### 2.1 Result-scope tabs (QUERY mode only)

A `TabStrip` (same visual component family as `TimelineTabs`; reuse its sticky-under-header styling)
with exactly two tabs:

| Tab | Meaning | Data | Caps |
|---|---|---|---|
| **Latest** (default) | Posts whose body matches the term. | `FEED` with `filter.text = { includesInsensitive: q }`, `orderBy: ["ID_DESC"]` (recency). | `caps.search` + `caps.pagination` |
| **People** | Authors whose `displayName` matches the term. | `SEARCH_PEOPLE` (see §3.3) — `authors(filter:{ displayName:{ includesInsensitive: q } })`. | `caps.search` + `caps.profiles` |

> **Why only these two.** X's `/explore` search has Top/Latest/People/Media/Lists. We have no media,
> no Lists, and "Top" (algorithmic) is meaningless on-chain — so **Latest** (recency) is the post
> result list and **People** is author-by-display-name. We deliberately omit a "Top" post tab here:
> score-ranked search is offered only as the *default* firehose ordering (§5.1), not as a per-term
> tab, to avoid implying a ranking model over query results. Note in code: a future `Top` tab could
> reuse `FEED` with `orderBy: ["SCORE_DESC","ID_DESC"]` + the search filter — left as a follow-up.

People search needs `caps.profiles` (indexer-only) in addition to `caps.search`; since both are
indexer-only and ship together, the People tab is simply present whenever `caps.search` is true.

---

## 3. Data bindings (exact queries — cite `04-data-layer.md`)

All queries below are owned/defined in `04-data-layer.md`; reproduced here for the implementer.

### 3.1 DEFAULT firehose — `FEED` (`04` §2.2, §2.5)

The empty-term default list is "top posts by score over the recent set" with a recency toggle:

```graphql
# 04-data-layer.md §2.2 — FEED (NO `deleted` field; enriched social + author profile)
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

Invoked through the seam as:

```ts
// DEFAULT — "Latest"/firehose (the explore default list)
source.page({ first: 25, order: "score" });   // orderBy ["SCORE_DESC","ID_DESC"] — top-of-window
// the "Most recent" sub-toggle (§5.1):
source.page({ first: 25, order: "recency" });  // orderBy ["ID_DESC"]
```

- No `filter.parentId` restriction (top-level + replies both surface, matching X explore).
- `nodeToPost` (`04` §2.2) maps each node → `CognoPost`; the surface then builds `PostVM`
  (`03-component-library.md` §0.4) per card.
- **`deleted` MUST NOT appear** anywhere — the field is removed (`04` §1; `05-divergences-and-constraints.md`
  D10). Banned authors come through `author.banned`; their posts stay visible, dimmed (§7.5).

### 3.2 QUERY mode → Latest tab — `FEED` with `$search` (`04` §2.5)

Same `FEED` query, with the search filter spliced in:

```ts
// QUERY / Latest tab
source.page({ first: 25, search: q, order: "recency" });
// → indexer builds filter: { text: { includesInsensitive: q } }, orderBy: ["ID_DESC"]
```

The substring filter is the canonical `text: { includesInsensitive: $q }` (`04` §2.5; `SearchBar`
behavior in `03` §21). Pagination via `pageInfo.endCursor` → `loadMore()` (gated `caps.pagination`).

### 3.3 QUERY mode → People tab — `SEARCH_PEOPLE` (`04` §6)

The people-search constant `SEARCH_PEOPLE` is defined in `04-data-layer.md` §6 (in
`lib/graphql/queries.ts`), mirroring `WHO_TO_FOLLOW` (`04` §2.10) but filtered by
display name:

```graphql
# 04-data-layer.md §6 — author search by display name (canonical name: SEARCH_PEOPLE)
query SearchPeople($q: String!, $first: Int!) {
  authors(
    filter: {
      and: [
        { banned: { equalTo: false } }
        { displayName: { includesInsensitive: $q } }
      ]
    }
    orderBy: FOLLOWER_COUNT_DESC
    first: $first
  ) {
    nodes { id displayName avatar weight followerCount }
  }
}
```

Exposed through the `FeedSource.searchPeople` method defined on the seam in `04` §2.1 (alongside
`whoToFollow`):

```ts
// 04 §2.1 — FeedSource.searchPeople (gated on caps.search && caps.profiles)
searchPeople(q: string, limit: number): Promise<Suggestion[]>;
```

- Returns `Suggestion[]` (`04` §2.1: `{ author, displayName?, avatar?, weight?, followerCount }`) so a
  `PersonResult` row can reuse the same shape the `RightRail` who-to-follow rows consume.
- PAPI-direct: `caps.search:false` ⇒ the method is never called (the People tab is unreachable).
- Self/already-followed are **not** filtered out of People results (unlike who-to-follow); search
  shows everyone, including the viewer.

### 3.4 Who-to-follow rail — `WHO_TO_FOLLOW` (`04` §2.10)

The desktop default-mode "Who to follow" rail reuses the canonical suggestion query:

```graphql
# 04-data-layer.md §2.10
query WhoToFollow($limit: Int!) {
  authors(filter: { banned: { equalTo: false }, postCount: { greaterThan: 0 } },
          orderBy: FOLLOWER_COUNT_DESC, first: $limit) {
    nodes { id displayName avatar weight followerCount }
  }
}
```

Via the seam: `source.whoToFollow(viewer.address ?? null, 5)`. The `useWhoToFollow` hook (`04` §7.2)
filters out the viewer + already-followed ids client-side using `followEdges(who).following`. Gated
on `caps.whoToFollow` (indexer-only); PAPI-direct omits the rail block (no empty state in the rail).

### 3.5 Viewer-relative state on result cards — `VIEWER_STATES`

Result `PostCard`s show the viewer's like/repost state (filled heart / active repost). Hydrate via
the batch `VIEWER_STATES` read through `useViewerStates(source, postIds, who)` (`04` §7.2), exactly as
the home `Timeline` does. On PAPI-direct, `useViewerStates` falls back to per-card
`readViewerPostState` (`04` §2.4). This is identical wiring to `06-surface-home.md`; do not
re-implement — pass the result `postIds` into the same hook.

### 3.6 FeedCaps gating table (cite `04` §2.3)

The affordances this surface lights up, by reader:

| Affordance | indexer (`graphql`) | PAPI-direct (`papi`) | Gated by |
|---|:--:|:--:|---|
| `SearchBar` input enabled | ✅ | ❌ disabled + hint | `caps.search` |
| Latest result list | ✅ | ❌ `search-unavailable` EmptyState | `caps.search` |
| People result tab | ✅ | ❌ tab hidden (no `caps.search`) | `caps.search` + `caps.profiles` |
| Result "load more" (cursor) | ✅ | n/a (no results) | `caps.pagination` |
| DEFAULT firehose | ✅ (page, score order) | ✅ (live snapshot, no order/cursor) | always (read) |
| Who-to-follow rail | ✅ | ❌ rail omitted | `caps.whoToFollow` |
| Like/Repost/Quote/Reply/Follow on cards | ✅ write | ✅ write | never gated by reader caps (`04` §7.2 hook→seam contract) |

> **No "reads: indexer" badge.** Per the dropped honesty layer (`00-overview.md`, `04` §2.3) we never
> render a "this needs the indexer" trust disclaimer in the chrome. The *only* place the indexer
> dependency is named is the `search-unavailable` `EmptyState` copy (a feature-dependency message that
> links Settings) and the disabled `SearchBar` `title`. Everything else just silently hides.

---

## 4. Extrinsics each interaction calls

The Explore surface itself issues **no novel extrinsics** — it composes the same action callbacks the
shared components own. Every write goes through `lib/chain/mutations.ts` (`04` §3) and is optimistic
(`04` §3.2/§3.3). For a result `PostCard` / `PersonResult` / who-to-follow row:

| Interaction (on a result/firehose card) | Extrinsic | Module fn (`04` §3) | Feeless? |
|---|---|---|---|
| Like (heart) | `Microblog(10).vote(post_id, { type: 'Up' })` | `submitVote(id, 'Up')` | feeless (capacity) |
| Un-like | `Microblog(10).clear_vote(post_id)` | `submitClearVote(id)` | feeless |
| Downvote (overflow `[···]`) | `Microblog(10).vote(post_id, { type: 'Down' })` | `submitVote(id, 'Down')` | feeless |
| Repost (confirm dialog, permanent) | `Microblog(10).repost(post_id)` | `submitRepost(id)` | feeless |
| Quote | `Microblog(10).quote_post(text, quoted_id)` | `submitQuote(text, id)` | feeless |
| Reply | `Microblog(10).post_message(text, Some(parent))` | `submitReply(text, parentId)` | feeless |
| Poll-card vote (firehose poll) | `Microblog(10).cast_poll_vote(post_id, option)` | `submitPollVote(id, option)` | feeless |
| Follow (People result / who-to-follow / card header) | `Microblog(10).follow(target)` | `submitFollow(target)` | feeless |
| Unfollow | `Microblog(10).unfollow(target)` | `submitUnfollow(target)` | feeless |

- Reply/Quote open the modal composer (`ReplyComposer`/`QuoteComposer` via `ModalRouteHost`,
  `01` §modal-routes); the composer owns submission. Explore just forwards `onReply(post)` /
  `onQuote(post)`.
- All these are **feeless/capacity-metered**. Capacity exhaustion at the pool (CheckCapacity) maps to
  a `RateLimitNotice` toast (`05` D5; `04` §3.2 `ExhaustsResources → "You are over the rate limit."`),
  never a generic error.
- **Search & firehose reads call no extrinsic.** Identity/stake binds and profile edits are **not**
  reachable from this surface (they live on `/welcome` and `/settings`).

---

## 5. Wireframes

### 5.1 Desktop — DEFAULT mode (`q === ''`), ≥1020px, 3-column

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│  LeftNav (275)        │  main (max 600)                          │  RightRail (350)          │
│  ◉ cogno              │ ┌──────────────────────────────────────┐ │ ┌───────────────────────┐ │
│  ⌂ Home               │ │ STICKY HEADER (backdrop-blur 12px)    │ │ │  Who to follow        │ │
│  🔍 Explore (active)  │ │ ┌──────────────────────────────────┐ │ │ │  (◐) Name  @ab…yz [+] │ │
│  ◯ Profile            │ │ │🔍 Search cogno-chain        (✕)  │ │ │ │  (◑) Name  @cd…wx [+] │ │
│  ⚙ Settings           │ │ └──────────────────────────────────┘ │ │ │  (◒) Name  @ef…uv [+] │ │
│  ( + Post )           │ └──────────────────────────────────────┘ │ │  Show more →          │ │
│  ──────────────       │  Latest        [ Top ⌄ | Most recent ]    │ └───────────────────────┘ │
│  (account widget)     │  ──────────────────────────────────────   │  ( About · ThemeToggle )  │
│                       │  ┌──────────────────────────────────────┐ │                           │
│                       │  │ PostCard  (firehose, top-by-score)    │ │   ▲ RightRail here repeats │
│                       │  │  (◐) Name @ab…yz · 3h          [···] │ │     the SearchBar at top   │
│                       │  │  Body text … URLs auto-linked.        │ │     too (X parity); on     │
│                       │  │  ⟲12  ↻4  ❝1  ♥38            ↗       │ │     /explore the page's    │
│                       │  ├──────────────────────────────────────┤ │     header SearchBar is the │
│                       │  │ PostCard  … (hairline divider)        │ │     primary one (autoFocus).│
│                       │  └──────────────────────────────────────┘ │                           │
│                       │  … infinite scroll … [ Spinner ]          │                           │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

- The sticky header on `/explore` is the **full-width `SearchBar`** (not `TimelineTabs`). Per `01`
  §sticky-header table: `position:sticky; top:0; backdrop-filter:blur(var(--cg-header-blur))` over
  `--cg-header-bg`.
- Under the header, a thin label row: `Latest` + a small inline order toggle `[ Top ⌄ | Most recent ]`
  (segmented control / dropdown). **Top** = `order:"score"` (the default explore ordering per `04`
  §2.5), **Most recent** = `order:"recency"`. This is the firehose, **not** the result-scope tabs
  (those appear only in QUERY mode).
- `RightRail` (desktop only) shows **Who to follow** (`source.whoToFollow`, §3.4) + footer
  (`ThemeToggle` + About). It also carries its own sticky `SearchBar` (X parity); but on `/explore`
  the page-header `SearchBar` is the focused/`autoFocus` one and they share the same `q` state. To
  avoid two competing inputs, the implementer MAY hide the rail's `SearchBar` on `/explore` only
  (recommended — one search box per surface) and keep the rail to just Who-to-follow + footer. Pick
  one; document it in a code comment. **Recommended: hide the rail SearchBar on `/explore`.**

### 5.2 Desktop — QUERY mode (`q !== ''`)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  main (max 600)                                                            │
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │ STICKY HEADER                                                          │ │
│ │ ┌──────────────────────────────────────────────────────────────────┐ │ │
│ │ │🔍 verdigris                                                  (✕)  │ │ │
│ │ └──────────────────────────────────────────────────────────────────┘ │ │
│ │  [ People ]  [ Latest ]      ← result-scope TabStrip (sticky, under)   │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
│  ── Latest (active) ─────────────────────────────────────────────────────  │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ PostCard — body contains "verdigris" (no in-card highlight required;  │ │
│  │ optional <mark> on the matched substring — see §8)                    │ │
│  │  ⟲2   ↻0   ❝0   ♥5             ↗                                      │ │
│  ├──────────────────────────────────────────────────────────────────────┤ │
│  │ PostCard … more results … [ Spinner / load more ]                     │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  (People tab active instead →)                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ PersonResult: (◐) DisplayName  @ab…yz   3 followers       [ Follow ]  │ │
│  │               bio (one line, linkified, truncated)                    │ │
│  ├──────────────────────────────────────────────────────────────────────┤ │
│  │ PersonResult: …                                                       │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Mobile — DEFAULT mode (<688px)

```
┌─────────────────────────────────────────┐
│ STICKY HEADER (blur)                     │
│ ┌─────────────────────────────────────┐ │
│ │ 🔍 Search cogno-chain          (✕) │ │  ← full-width SearchBar (no rail on mobile)
│ └─────────────────────────────────────┘ │
│  Latest   [ Top ⌄ | Most recent ]        │
├─────────────────────────────────────────┤
│ (◐) Name @ab…yz · 3h              [···] │  ← firehose PostCard, full-bleed
│     Body text, wraps. 15px base.         │
│   ⟲12  ↻4  ❝1  ♥38               ↗      │
├─────────────────────────────────────────┤
│ (◑) Name @cd…wx · 5h              [···] │
│   …                                      │
│                       … infinite scroll  │
├─────────────────────────────────────────┤
│        [ Who to follow (collapsed?) ]    │  ← OPTIONAL: a single inline "Who to follow"
│        (◐) Name @ef…uv        [ Follow ] │     card may be injected after the first ~10
├─────────────────────────────────────────┤     firehose rows (X parity); see §5.5
│ ⌂        🔍        ◎        ⚙            │  ← BottomTabBar (Explore active)
└─────────────────────────────────────────┘
        ⊕  ← ComposeFab (bottom-right, above the tab bar)
```

### 5.4 Mobile — QUERY mode

```
┌─────────────────────────────────────────┐
│ ┌─────────────────────────────────────┐ │
│ │ 🔍 verdigris                    (✕) │ │  ← committed term; ✕ clears → back to DEFAULT
│ └─────────────────────────────────────┘ │
│  [ People ]  [ Latest ]                  │  ← horizontally-scrollable TabStrip if needed
├─────────────────────────────────────────┤
│ Latest active: PostCard list …           │
│ People active: PersonResult list …       │
├─────────────────────────────────────────┤
│ ⌂        🔍        ◎        ⚙            │
└─────────────────────────────────────────┘
```

### 5.5 No-indexer (PAPI-direct, `caps.search === false`) — both modes

```
┌─────────────────────────────────────────┐
│ ┌─────────────────────────────────────┐ │
│ │ 🔍 Search needs the indexer    (✕) │ │  ← SearchBar DISABLED (aria-disabled, title=…)
│ └─────────────────────────────────────┘ │
│  Latest   [ Top? — n/a | Most recent ]   │  ← firehose still renders from the live snapshot
├─────────────────────────────────────────┤    (no score order, no cursor — single window)
│ (◐) Name @ab…yz · #1240           [···] │  ← timestamp null → show block height
│   …firehose PostCards from source.watch()│
├─────────────────────────────────────────┤
│   If the user taps the disabled bar:     │
│   ╭───╮                                  │
│   │ 🔍│   Search needs the indexer       │  ← EmptyState variant='search-unavailable'
│   ╰───╯   Connect an indexer endpoint in │
│           Settings to search.            │
│           [ Open settings ]              │
└─────────────────────────────────────────┘
```

> The firehose **does not require the indexer** — it renders from `source.watch()` on PAPI-direct
> (live snapshot, recency only, no cursor). Only *search* and *who-to-follow* are gated off.

---

## 6. Component composition (canonical names)

```
ExplorePage
├─ <main> (center column, max --cg-col-feed 600px)
│  ├─ <header sticky blur>
│  │   └─ SearchBar  (value=draft, onChange, onSubmit, searchEnabled=caps.search, autoFocus)
│  │   └─ {q === '' ? <FirehoseOrderToggle/>      // Top | Most recent (DEFAULT)
│  │                : <TabStrip People|Latest/> }  // result scope (QUERY)
│  └─ <section role="region">
│      ├─ DEFAULT:  Timeline(posts=firehose, viewer, loading, hasMore, onLoadMore, …actions)
│      ├─ QUERY/Latest: Timeline(posts=results, …)  // same Timeline, search results
│      ├─ QUERY/People: ExploreList(items=people)   // PersonResult rows (Avatar+DisplayName+Handle+FollowButton)
│      └─ states: Skeleton | EmptyState | RateLimitNotice(toast) | search-unavailable
└─ RightRail (desktop ≥1020, AppShell-mounted)
   └─ Who-to-follow card  (Avatar + DisplayName + Handle + FollowButton size='sm') · footer
```

Components reused (do not redefine — `03-component-library.md`):

- **`SearchBar`** (`03` §21) — full-width on this route; `searchEnabled = feedSource.caps.search`;
  `autoFocus` on `/explore`; disabled state shows placeholder "Search needs the indexer" + `title`.
- **`Timeline`** (`03` §22.1) — the result/firehose list of `PostCard`s; owns `j/k/n/l/r/t/Enter/.`
  keyboard nav, `EmptyState`, `Skeleton variant='post' count={8}`, and tail `Spinner`. Pass
  `hasMore`/`onLoadMore` gated on `caps.pagination`.
- **`PostCard`** (`03` §1, variant `'timeline'`) — each result/firehose post; row-click → `/post/[id]`;
  carries `PostCardActions` (Like/Repost/Quote/Reply/Share) + overflow `[···]` (Downvote, Copy link).
- **`ExploreList`** (surface-owned here) — the People-tab list container of **`PersonResult`** rows.
  **`PersonResult`** is a **surface-local component** (owned by this surface, NOT registered in the
  shared `03-component-library.md` kit). A `PersonResult` row = `Avatar` (md) + `DisplayName` +
  `Handle` (mono, copyable) + one-line linkified bio + `FollowButton`. It is the same row the
  `RightRail` who-to-follow uses, at a larger size; factor a shared `<PersonRow>` (or reuse the rail
  row component) — note it.
- **`FirehoseOrderToggle`** — a **surface-local component** (owned by this surface, NOT in the shared
  `03-component-library.md` kit): the DEFAULT-mode `Top | Most recent` order toggle (§5.1).
- **`FollowButton`** (`03` §FollowButton) — on each `PersonResult` and who-to-follow row; returns
  `null` for self; `Follow → submitFollow`, `Unfollow → submitUnfollow`; optimistic (`04` §7.2).
- **`EmptyState`** (`03` §18) — variants: `search` ("No results for \"{q}\"" / "Try different
  keywords."), `search-unavailable` ("Search needs the indexer." / "Connect an indexer endpoint in
  Settings to search." + `[Open settings]`), `feed` (firehose empty — rare; "Nothing here yet").
- **`Skeleton`** (`03` §19, `variant='post' count={8}`) — initial firehose/result load; tail `Spinner`
  for "loading more".
- **`RateLimitNotice`** (`03` §17, `variant='toast'`) — raised on CheckCapacity pool rejection from any
  card action (Like/Repost/etc.).
- **`Toaster`/`Toast`** — error toast + rollback on write failure (`04` §3.3).
- **`ThemeToggle`**, **About** — `RightRail` footer (desktop), unchanged.

---

## 7. Every UI state

### 7.1 SearchBar states (`03` §21)

| State | Render |
|---|---|
| empty | placeholder "Search cogno-chain", no clear button. |
| typing | clear `✕` appears; debounced (300 ms) → updates `q` + `?q=`. |
| disabled (PAPI-direct) | `aria-disabled`, greyed, placeholder "Search needs the indexer", `title="Connect an indexer endpoint in Settings to enable search."`; click → `search-unavailable` EmptyState in the results area. |
| focus | `--cg-accent` 2px ring (`--cg-focus-ring`). |
| loading | small `Spinner` inside the field while a `page({search})` / `searchPeople` call is in flight. |

### 7.2 DEFAULT firehose states

| State | Render |
|---|---|
| loading (initial) | `Skeleton variant='post' count={8}` under the order toggle. |
| ready | `Timeline` of firehose `PostCard`s; infinite scroll (`caps.pagination`) or single window (PAPI-direct). |
| empty (no posts on-chain) | `EmptyState variant='feed'` — "Nothing here yet" / "Be the first to post." (rare). |
| loading more | tail `Spinner`. |
| PAPI-direct (no cursor) | render the live `source.watch()` window; **no** "load more" — show the quiet "Connect an indexer to load more" footer (`03` §22.1 Timeline behavior). Order toggle's **Top** option is disabled/hidden (no score order without the indexer); **Most recent** is the only ordering. |
| error (firehose query failed) | inline `EmptyState variant='generic'` "Couldn't load posts." + Retry; do NOT toast. |

### 7.3 QUERY mode states (Latest + People)

| State | Render |
|---|---|
| loading | Latest → `Skeleton count={8}`; People → `Skeleton variant='person' count={6}` (the `person` variant is defined in `03` §19). |
| results | Latest → `Timeline` of result `PostCard`s; People → `ExploreList` of `PersonResult` rows. |
| no results (Latest) | `EmptyState variant='search'` — "No results for \"{q}\"" / "Try different keywords." |
| no results (People) | `EmptyState variant='search'` with people-flavored subtext — "No people found for \"{q}\"" / "Display names are set in profiles." |
| no indexer | `search-unavailable` EmptyState (§7.4); the People tab is hidden entirely (no `caps.search`). |
| loading more | tail `Spinner` (Latest only; People search is a single ranked window — no cursor in `SEARCH_PEOPLE`; note: people pagination is a follow-up). |
| error | inline `EmptyState variant='generic'` "Couldn't run that search." + Retry. |

### 7.4 No-indexer state (`caps.search === false`)

- `SearchBar` **disabled** (§7.1).
- The **results area** (when the user attempts a search / the bar is focused) shows
  `EmptyState variant='search-unavailable'` with `[Open settings]` → `router.push('/settings/')`.
- The **firehose still renders** (PAPI-direct live snapshot, §7.2) — Explore is not blank without an
  indexer; only the *search* and *who-to-follow* affordances disappear.
- The **People tab and Who-to-follow rail are hidden** (no `caps.search`/`caps.whoToFollow`).

### 7.5 Write-affordance states on result/firehose cards

Inherited from `PostCard`/`PostCardActions`/`FollowButton` + `Viewer.status` (`03` §0.4):

| Viewer.status | Result-card actions |
|---|---|
| `not-connected` | Like/Repost/Quote/Reply/Follow each route to `/welcome` on click (no inline error). Reads/scroll fully available. |
| `not-identity-bound` | same funnel to `/welcome` (the bind step). |
| `ready` (bound) | actions live; optimistic apply → reconcile → rollback+toast on failure. Down-vote/poll-vote require votes weight 0 OK (vote allowed at weight 0; `05` D2). |
| capacity exhausted | the feeless action's pool rejection → `RateLimitNotice` toast; optimistic change rolls back. |

**Banned author** (`author.banned === true`, `05` D10): the `PostCard` / `PersonResult` renders the
author dimmed (`--cg-text-muted`) with the neutral "restricted" note; **posts stay visible** in
results/firehose — never filtered out, never `deleted` (the field does not exist).

### 7.6 Optimistic & toast grammar (cite `04` §3, `02` §optimistic-UI)

- Like/Repost/Quote/Reply/Follow on a card apply instantly (heart fills, count bumps, Follow→Following)
  at the optimistic visual grammar (`02`: pending opacity 0.6 → 1 on confirm; fade + `--cg-danger`
  toast on failure).
- A **Quote** issued from a result card optimistically inserts a pending `PostCard` into the *home*
  timeline (not the explore results) — the explore list is unchanged except the quoted card's quote
  count bumps on reconcile (`03` §quote behavior).
- Success is silent for feeless actions; only failure (error or rate-limit) toasts.
- **No block numbers, no "finalized" chips, no honesty marginalia** anywhere on this surface (`05`
  D11; `00-overview.md`).

---

## 8. Responsive behavior (breakpoints from `01` §responsive)

| Width | Layout |
|---|---|
| **Mobile** `< 688px` | Single column. Full-width `SearchBar` in the sticky header (no `RightRail`). `BottomTabBar` (Explore tab active) + `ComposeFab`. QUERY `TabStrip` is horizontally scrollable if cramped. Optional inline "Who to follow" card injected after ~10 firehose rows (§5.3) since there's no rail. |
| **Tablet** `688–1019px` | Collapsed icon `LeftNav`, **no `RightRail`**. `SearchBar` full-width in the header; Who-to-follow is **not** shown (no rail) — it's indexer-only and rail-only, so it's simply absent at this width (acceptable; it reappears at ≥1020). |
| **Desktop** `≥ 1020px` | 3-column. Center column caps at `--cg-col-feed` 600px. `RightRail` (350px) shows Who-to-follow + footer. Page-header `SearchBar` is the primary; rail `SearchBar` hidden on `/explore` (§5.1 recommendation). |
| **Desktop-wide** `≥ 1280px` | Same; `--cg-content-max` 1265px container; rails reach max widths. |

- The QUERY `TabStrip` and the DEFAULT order toggle both sit **inside** the sticky header block
  (`position:sticky; top:0`), under the `SearchBar`, so they stay pinned while results scroll
  (X parity).
- `PostCard` internal layout (avatar gutter, single-line header, action row) is fully specified in
  `03` §1 and is identical here — do not restyle per surface.

---

## 9. Accessibility

- **SearchBar:** wrapper `role="search"`; `<input type="search">` with an accessible label
  "Search cogno-chain"; clear button `aria-label="Clear search"`; disabled state `aria-disabled` +
  `title` (the indexer hint). `autoFocus` on `/explore` mount (so keyboard users land in the field).
- **Result-scope `TabStrip`:** `role="tablist"`; each tab `role="tab"`, `aria-selected`; the result
  region `role="tabpanel"` `aria-labelledby` the active tab. Left/Right arrow keys move between
  People/Latest (standard tab pattern); `Home`/`End` jump to first/last.
- **Order toggle (DEFAULT):** a labeled segmented `radiogroup` (`role="radiogroup"`, options
  `role="radio"` Top/Most recent) — not a `tablist` (it's a sort, not a content scope).
- **`Timeline` keyboard nav:** owned by `Timeline` (`03` §22.1) — `j`/`k` move focus between result
  cards, `n` = new post (opens `Composer`), `Enter`/`o` = open focused post (`/post/[id]`), `l` =
  like, `r` = reply, `t` = repost, `.` = overflow menu. Each `PostCard` exposes `data-post-id`,
  `tabIndex`, and a ref hook; focus follows `j/k`. (Same contract as the home timeline in
  `06-surface-home.md` — reuse it.)
- **`/` (slash) focuses search:** add the X global shortcut — pressing `/` anywhere on `/explore`
  (outside an input) focuses the `SearchBar`. Document as a surface-level keydown handler; ignore when
  a modal/composer is open.
- **EmptyState:** `role="status"`; the `search-unavailable` and `search` empty states are announced.
  The in-flight search `Spinner` sets `aria-busy` on the results region.
- **Live region:** result count changes announce politely ("12 results for verdigris") via an
  `aria-live="polite"` visually-hidden summary node, so screen-reader users hear the new count after a
  query commits.
- **PersonResult / FollowButton:** `FollowButton` carries `aria-pressed` (Following state) and an
  accessible label "Follow @handle" / "Following @handle"; `Handle` is copy-on-click with an
  `aria-label` exposing the full ss58.
- **Reduced motion:** the like-pop, optimistic fade-in, and skeleton shimmer collapse to instant per
  `prefers-reduced-motion` (`02` §motion; `03` §0.5).

---

## 10. Deferred — Notifications hook

Per the project decision, **Notifications are deferred** (`00-overview.md`; not authored). Leave a
labeled hook in `ExplorePage`/`AppShell` integration **only** as a comment: a future
`/notifications` surface (and a bell in `LeftNav`/`BottomTabBar`) would fold the indexer events
`Voted`, `Reposted`, `Followed`, reply-`PostCreated` (where `parentId` is one of my posts), and
`quote` (where `quote.id` is one of my posts) via a `useNotifications(who)` hook (`04` §7.2 seam
name). No notifications affordance ships on `/explore`. **Do not** build the surface; just keep the
comment so the follow-up is a clean add.

---

## 11. Implementation checklist (ordered)

- [ ] **Route scaffold.** Create `src/app/explore/page.tsx` (`'use client'`) → `ExplorePage`, mounted
      inside `AppShell` (`01` §4.1). Confirm `trailingSlash:true` + nginx SPA fallback already cover
      `/explore` and `/explore?q=` deep links (`01` §6.3) — no `generateStaticParams` needed (no
      dynamic segment).
- [ ] **Mode machine.** Read `q` from `useSearchParams()`; derive `DEFAULT | QUERY | NO-INDEXER` from
      `q` + `feedSource.caps.search` (§2). Keep a local `draft` string distinct from committed `q`;
      debounce (300 ms) draft→q with `router.replace('/explore?q=' + encoded)`; Enter commits
      immediately; `✕` clears to DEFAULT (`router.replace('/explore')`).
- [ ] **Mount `SearchBar`** (`03` §21) full-width in the sticky header; wire `value=draft`,
      `onChange`, `onSubmit`, `searchEnabled = feedSource.caps.search`, `autoFocus`. Implement the
      disabled (PAPI-direct) rendering + `title`.
- [ ] **Add `/` global focus shortcut** (focus `SearchBar` on `/` keydown when no input/modal active).
- [ ] **DEFAULT firehose.** Wire `useFeedPage(source, { first:25, order: orderToggle }, true)` (`04`
      §7) → `Timeline`. Build the order toggle (`role="radiogroup"`: **Top** = `order:"score"`,
      **Most recent** = `order:"recency"`); disable **Top** on PAPI-direct (no score order). Handle
      `caps.pagination` (load-more vs single window + "connect an indexer to load more" footer).
- [ ] **QUERY / Latest tab.** Wire `useFeedPage(source, { first:25, search:q, order:"recency" }, q!=='' && caps.search)`
      → `Timeline` of result `PostCard`s; cursor `loadMore` gated `caps.pagination`. Confirm the
      filter resolves to `text:{ includesInsensitive:q }` (`04` §2.5).
- [ ] **QUERY / People tab.** Use `SEARCH_PEOPLE` (`04` §6, in `lib/graphql/queries.ts`) via the
      `FeedSource.searchPeople(q, limit)` seam method (`04` §2.1; gated `caps.search && caps.profiles`;
      PAPI-direct throws/unreachable). Build `ExploreList` of `PersonResult` rows (factor a shared `PersonRow` with
      the who-to-follow row). Wire `FollowButton` → `submitFollow`/`submitUnfollow` (`04` §3).
- [ ] **Result-scope `TabStrip`** (People | Latest), sticky under the `SearchBar`, default **Latest**;
      hide the whole strip in DEFAULT mode; hide the **People** tab when `!caps.search`. Implement the
      `role="tablist"`/`role="tab"`/`role="tabpanel"` a11y + arrow-key nav.
- [ ] **Viewer states on cards.** Reuse `useViewerStates(source, postIds, viewer.address)` (§3.5) for
      both firehose and Latest results → filled-heart / active-repost. Same wiring as the home timeline
      — do not re-implement.
- [ ] **RightRail Who-to-follow** (desktop ≥1020): `useWhoToFollow(source, viewer.address ?? null, 5)`
      (`04` §2.10/§7.2); filter self + already-followed client-side; omit the block on PAPI-direct
      (`caps.whoToFollow:false`). Hide the rail's own `SearchBar` on `/explore` (one search box per
      surface — §5.1). Mobile: optionally inject one inline Who-to-follow card after ~10 firehose rows.
- [ ] **EmptyStates.** `search` (no results, both Latest + People-flavored), `search-unavailable`
      (PAPI-direct, `[Open settings]` → `/settings/`), `feed` (firehose empty). Copy strings verbatim
      from `03` §18.
- [ ] **Loading/skeletons.** `Skeleton variant='post' count={8}` for firehose/Latest;
      `Skeleton variant='person'` (`03` §19) for People; tail `Spinner` for load-more; field `Spinner`
      while a query is in flight.
- [ ] **Optimistic writes + toasts.** Forward `onLike/onDownvote/onRepost/onQuote/onReply/onPollVote`
      from result cards to `lib/chain/mutations.ts` (`04` §3); optimistic apply → reconcile via
      `useViewerStates`/tally → rollback + `Toast`/`RateLimitNotice` on failure (`04` §3.2/§3.3).
      Map CheckCapacity rejection → `RateLimitNotice` ("You are over the rate limit. Try again
      shortly.").
- [ ] **Auth funnel.** Gate every write affordance on `Viewer.status`: `not-connected` /
      `not-identity-bound` → `router.push('/welcome')` on click; reads stay public (`01` §auth-gating).
- [ ] **Banned-author rendering.** Dim `author.banned` authors (`--cg-text-muted` + "restricted"
      note); keep their posts/results visible. Confirm **no `deleted` reference** anywhere on this
      surface (`04` §1; `05` D10).
- [ ] **Responsive.** Verify <688 (full-width SearchBar, BottomTabBar+FAB, scrollable TabStrip),
      688–1019 (collapsed rail, no RightRail), ≥1020 (3-col + Who-to-follow), ≥1280 (max container).
- [ ] **Accessibility pass.** `role="search"`, tab/tablist/tabpanel + arrow nav, radiogroup order
      toggle, `aria-live` result-count summary, `Timeline` `j/k/n/l/r/t/Enter/.` reuse, reduced-motion.
- [ ] **Notifications hook comment** only (no surface) — list the indexer events (`Voted`/`Reposted`/
      `Followed`/reply-`PostCreated`/quote) and `useNotifications(who)` seam name (§10).
- [ ] **No honesty chrome.** Confirm zero trust badges / block numbers / "needs indexer" disclaimers
      except the single `search-unavailable` EmptyState + the disabled `SearchBar` `title`.
