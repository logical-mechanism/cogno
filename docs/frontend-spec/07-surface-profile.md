# 07 — Surface: Profile (`/u/[address]`)

This doc specifies the **Profile** surface — the per-account page at `/u/[address]`, a faithful
Twitter/X profile clone re-skinned with the cogno teal accent (`--cg-*` tokens from
`02-design-system.md`), dark-first. It renders X's profile chrome (sticky blurred header → banner →
overlapping avatar → name/handle/bio/counts → action button → sticky `ProfileTabs` → tab list of
`PostCard`s), with the on-chain divergences honored: there is **no banner field on-chain** (we use an
accent gradient), **no media tab** (the chain is text-only), `Profile.pinnedPostId` is rendered as a
pinned card at the top of the **Posts** tab, the handle is a **truncated ss58** (mono, copyable), the
avatar falls back to a **deterministic identicon**, profile edits are the **only fee-bearing** action
on this surface (everything else here is read), and a **banned** author is **dimmed but not removed**.
The page resolves its `address` param client-side (static-export constraint, see
`01-information-architecture.md`), reads via the `source.profile({ author })` seam from
`04-data-layer.md` (indexer full-fidelity; PAPI-direct degraded), and funnels write intent (Follow,
Edit profile, pin) through the standard gate to `/welcome` when not connected / not identity-bound.

---

## 1. Purpose & route

| | |
|---|---|
| **Route** | `/u/[address]` (the **ss58 account address**, prefix 42, is the stable id) |
| **Page component** | `ProfilePage` (`src/app/u/[address]/page.tsx`, `'use client'`) — see `01-information-architecture.md` §2 |
| **Owns** | `ProfileHeader`, `ProfileTabs`, the pinned-post marker, the `EditProfileModal` *trigger* (the modal itself is `12-surface-settings.md`-owned chrome, opened here via the `edit-profile` modal route), the **who-is-this-when-unbound** fallback |
| **Reuses** | `PostCard` (`03-component-library.md` §1), `Avatar` (§13), `DisplayName` (§14), `Handle` (§15, `copyable`), `FollowButton` (§12), `PostBody` (§4, for the linkified bio), `ByteCounter` (§8, inside `EditProfileModal`), `Timeline` (§22.1, the tab list body), `EmptyState` (§18), `Spinner`/`Skeleton` (§19), `Toaster`/`Toast` (§16), `RateLimitNotice` (§17 — only relevant for the **inline post actions** on tab cards, never for profile edits) |
| **Data seam** | `source.profile({ author })` + `source.followEdges(who)` (gated `caps.follows`) + the `PROFILE_BY_ACCOUNT` / `PROFILE_BY_IDENTITY` / `PROFILE_REPLIES` / `PROFILE_LIKES` / `ONE_POST` queries from `04-data-layer.md` §2.6 |
| **Divergences** | D1 (no media → no Media tab), D2 (Like = up-vote, on the tab cards), D6 (ss58 handle + identicon), D7 (identity-bound gate on Follow/Edit), D9 (profile edits fee-bearing → funding state), D10 (banned author dimmed not removed) — see `05-divergences-and-constraints.md` |

The profile shows **someone's account**: who they are (name/handle/bio/avatar), their reach
(follower/following counts + posting `weight`), their pinned post, and three tabs of their activity
(**Posts / Replies / Likes**). It is a **read surface** for everyone except the **owner**, for whom the
"Follow" button becomes **"Edit profile"** (or **"Set up profile"** when they have no profile yet) and
the pinned-post / pin controls become available.

---

## 2. ASCII wireframes

### 2.1 Desktop (≥ 1020px) — 3-column shell, profile in the 600px center column

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ LeftNav (275px) │              center column (--cg-col-feed 600px)              │ RightRail │
│  ◈ cogno         │ ┌──────────────────────────────────────────────────────────┐ │ (350px)   │
│  ⌂ Home          │ │ ←  Astra Nodewright                          [sticky hdr] │ │ ┌───────┐ │
│  🔍 Explore      │ │    342 posts                          blur(12px)/--cg-bg  │ │ │Search │ │
│  ○ Profile  ◀    │ ├──────────────────────────────────────────────────────────┤ │ └───────┘ │
│  ⚙ Settings      │ │██████████ banner: accent gradient, height 200px █████████ │ │ ┌───────┐ │
│                  │ │██████████ (no banner field on-chain — D-note) ███████████ │ │ │Who to │ │
│  ( Post )        │ │      ╭──────╮                                             │ │ │follow │ │
│                  │ │      │  AV  │ xl avatar (133px) overlaps banner ↑↓        │ │ │ ...   │ │
│  ┌────────────┐  │ │      │ 133px│                           [ Edit profile ] │ │ └───────┘ │
│  │ (av) @5CBE…│  │ │      ╰──────╯              (or [ Follow ] / [Following])  │ │  Theme    │
│  └────────────┘  │ │   Astra Nodewright                                        │ │  About    │
│                  │ │   @5CBE…oFC  ⧉                            (mono, copy ⧉)   │ │           │
│                  │ │   Building quiet machines. https://astra.example          │ │           │
│                  │ │   ── bio (≤256B, PostBody-linkified) ──                   │ │           │
│                  │ │   1,204 Following · 8,901 Followers   (linkable counts)   │ │           │
│                  │ ├──────────────────────────────────────────────────────────┤ │           │
│                  │ │  Posts        Replies        Likes        [ProfileTabs]   │ │           │
│                  │ │ ═══════                                   (sticky row 2)  │ │           │
│                  │ ├──────────────────────────────────────────────────────────┤ │           │
│                  │ │ 📌 Pinned                                                 │ │           │
│                  │ │ ┌──────────────────────────────────────────────────────┐ │ │           │
│                  │ │ │ (av) Astra · @5CBE…oFC · 2h        [···]              │ │ │           │
│                  │ │ │ The pinned post body…                                │ │ │           │
│                  │ │ │  💬 12    ⇄ 4    ♥ 88    ↗                            │ │ │           │
│                  │ │ └──────────────────────────────────────────────────────┘ │ │           │
│                  │ ├──────────────────────────────────────────────────────────┤ │           │
│                  │ │ ┌── PostCard (newest) ─────────────────────────────────┐ │ │           │
│                  │ │ │ … hairline-divided list of the author's posts …      │ │ │           │
│                  │ │ └──────────────────────────────────────────────────────┘ │ │           │
│                  │ │ ┌── PostCard ──────────────────────────────────────────┐ │ │           │
│                  │ │ └──────────────────────────────────────────────────────┘ │ │           │
│                  │ │                    [ Spinner — loading more ]            │ │           │
│                  │ └──────────────────────────────────────────────────────────┘ │           │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Mobile (< 688px) — single column, BottomTabBar, no rails

```
┌───────────────────────────────┐
│ ←  Astra Nodewright       [hdr]│  sticky, blur(12px); back-arrow + name + "342 posts" subtitle
├───────────────────────────────┤
│███ banner: accent gradient ███│  height ~120px on mobile
│███ (no banner field) █████████│
│   ╭──────╮                     │
│   │  AV  │  xl-ish (80px) avatar overlaps                 [ Edit profile ]  ← right-aligned pill
│   ╰──────╯                                                (or [Follow]/[Following])
│ Astra Nodewright               │
│ @5CBE…oFC  ⧉                    │  mono handle + copy
│ Building quiet machines.        │  bio (PostBody-linkified, wraps)
│ https://astra.example           │
│ 1,204 Following · 8,901 Foll.  │  counts (tap → inline list, Lists OUT of scope)
├───────────────────────────────┤
│ Posts   Replies   Likes  [tabs]│  sticky row 2 (scroll-snap, swipeable)
│ ═════                          │
├───────────────────────────────┤
│ 📌 Pinned                      │
│ ┌───────────────────────────┐ │
│ │ (av) Astra @5CBE… · 2h ···│ │
│ │ pinned body…              │ │
│ │ 💬12  ⇄4  ♥88  ↗          │ │
│ └───────────────────────────┘ │
├───────────────────────────────┤
│ ┌── PostCard ───────────────┐ │
│ └───────────────────────────┘ │
│ ┌── PostCard ───────────────┐ │
│ └───────────────────────────┘ │
│         [ Spinner ]           │
├───────────────────────────────┤
│  ⌂      🔍      ◎      ⚙       │  BottomTabBar (Home·Explore·Profile·Settings)
└───────────────────────────────┘     compose FAB floats bottom-right (not shown)
```

### 2.3 Self-view (owner) header variant

The header is identical except the action button is **"Edit profile"** (outline pill) when the owner
**has** a profile, or **"Set up profile"** (filled accent pill) when `displayName`/`bio`/`avatar` are
all empty (the no-profile-yet nudge). No `FollowButton` is rendered on your own profile (it returns
`null` on self per `03-component-library.md` §12).

### 2.4 Unbound / who-is-this fallback header variant

When `/u/<addr>` resolves to an account that has **no identity bind and no posts** (a bare address —
e.g. someone followed a never-active account), the body collapses to the **who-is-this** fallback (§6):
identicon `Avatar` + truncated-ss58 `DisplayName` + the handle, an `EmptyState` ("This account hasn't
posted yet"), and `ProfileTabs` showing empty tabs.

---

## 3. Component composition

```
ProfilePage  ('use client', src/app/u/[address]/page.tsx)
├─ <ProfileResolver>                     // §5.1 — validate + resolve the address param
│   ├─ invalid ss58 → <ProfileNotFound>  // in-app 404 panel (NotFoundPage style)
│   └─ valid → ProfileBody(address)
└─ ProfileBody(address)
    ├─ sticky header row   : <BackArrow/> + <DisplayName author=.../> + "<postCount> posts" subtitle
    ├─ <ProfileHeader                              // 03-component-library.md §22.3 (props pinned there)
    │     author={author + bio,followerCount,followingCount,postCount,pinnedPostId}
    │     viewer={viewer}
    │     onEditProfile={() => openModal('edit-profile')}   // 01-IA §7.1 modal route
    │     onToggleFollow={...} />                            // delegates to FollowButton inside
    │   ├─ <Banner/>                  // accent gradient, NOT a chain field (§4.1)
    │   ├─ <Avatar size='xl' address src=author.avatar dim=author.banned />
    │   ├─ <FollowButton/> | "Edit profile" | "Set up profile"   // §4.4
    │   ├─ <DisplayName author/>  +  <Handle address copyable/>   // §4.2
    │   ├─ <PostBody text={author.bio} />    // linkified bio, NO media (§4.3)
    │   ├─ banned note (if author.banned) — neutral "restricted" line (§4.6, D10)
    │   └─ <FollowCounts following followers onOpen=.../>   // §4.5
    ├─ <ProfileTabs active onChange/>             // Posts / Replies / Likes (§5)
    └─ tab body:
        ├─ Posts   → [ <PinnedPostBlock/> if pinnedPostId ]  +  <Timeline posts=postsTab .../>
        ├─ Replies → <Timeline posts=repliesTab .../>        // parentId != null
        └─ Likes   → <Timeline posts=likesTab .../>          // author's Up-votes
    (modal, opened via 'edit-profile' route)
    └─ <EditProfileModal/>   // 03 §22.4 / 12-surface-settings.md — fee-bearing set_profile + pin/unpin
```

All leaf/shared components come **as specified** in `03-component-library.md`; this surface only
composes them and owns `ProfileHeader` / `ProfileTabs` / the pinned block / the resolver / the
who-is-this fallback. **Do not redefine** tokens, `PostCard`, `Avatar`, `FollowButton`, etc.

---

## 4. ProfileHeader anatomy & decisions

`ProfileHeader` props (from `03-component-library.md` §22.3):
`author: AuthorVM & { bio; followerCount; followingCount; postCount; pinnedPostId }`, `viewer`,
`onEditProfile`, `onToggleFollow`.

### 4.1 Banner — there is **no banner field on-chain**

X has a user-uploaded banner image. **cogno-chain has no banner field** (the Profile pallet exposes
only `display_name` / `bio` / `avatar`; avatar is a URL reference, not bytes — see D1/D9). **Decision:**
render a **deterministic accent banner** — a CSS gradient seeded from the address so each account has a
stable, distinct strip, with no network and no upload:

```css
/* height: 200px desktop / 120px mobile; behind the overlapping avatar */
.banner {
  height: 200px;
  background: linear-gradient(135deg, var(--cg-accent) 0%, var(--cg-bg-subtle) 100%);
  /* hue/angle offset derived from the address hash so banners differ per account */
}
```

> **One-line rationale:** a banner is pure decoration; rather than ship an empty grey bar (looks
> broken) or invent an off-chain upload (out of scope), seed an accent gradient from the address — it
> reads as "their color," matches the cogno teal brand, and is zero-cost/zero-network.

The avatar (`xl`, 133px desktop / ~80px mobile) **overlaps** the banner bottom edge by ~50% (X-exact),
sitting in the top-left of the header body with a `--cg-bg`-colored ring so it cuts cleanly out of the
banner.

### 4.2 DisplayName + Handle

- `DisplayName` (`03` §14) — `author.displayName` (`Profile.display_name`, ≤ 64B); **fallback to the
  truncated ss58** when null/empty. **Non-unique** (no usernames on-chain) — never treat as an id.
  **No verified badge** (the "verified" concept is dropped, D7).
- `Handle` (`03` §15) with **`copyable`** — `@` + middle-truncated ss58 (`@5CBE…oFC`) in
  `--cg-font-mono`, `--cg-text-secondary`. Click copies the **full address** → success `Toast`
  ("Address copied"). Full address lives in `title`/`aria-label`.

### 4.3 Bio

Render `author.bio` (`Profile.bio`, ≤ 256B) through **`PostBody`** (`03` §4) so URLs auto-link
(`--cg-accent`, `referrerPolicy="no-referrer"`), **no media, no @-mention links, no #hashtag links**,
XSS-safe node tree. Empty bio → render nothing (no placeholder line), except the owner's no-profile
state nudges via the **"Set up profile"** button (§4.4), not via bio placeholder text.

### 4.4 Action button (the load-bearing self-vs-other switch)

| Viewing | `viewer.status` | `author.address === viewer.address` | Button rendered | Behavior |
|---|---|---|---|---|
| Someone else | `ready` | no | **`FollowButton`** (Follow / Following / Unfollow-on-hover) | optimistic; `Microblog.follow(target)` / `Microblog.unfollow(target)` |
| Someone else | `not-connected` | no | `FollowButton` (Follow) | click routes to `/welcome` (gate, §7) |
| Someone else | `not-identity-bound` | no | `FollowButton` (Follow, **disabled** + tooltip "Finish setup to follow") | routes to `/welcome` finish-setup |
| **Yourself** | `ready` | yes, **has profile** | **"Edit profile"** (outline pill) | `onEditProfile()` → open the `edit-profile` modal route (§9) |
| **Yourself** | `ready` | yes, **no profile yet** | **"Set up profile"** (filled accent pill) | same modal, same target; the filled accent = a stronger nudge |

> *"No profile yet"* = `displayName`, `bio`, and `avatar` are **all** empty/null (the owner has never
> called `set_profile`). This is the only place the accent-filled variant is used; once they have any
> field set, it reverts to the outline "Edit profile".

`FollowButton` (`03` §12): edge state from `Follow{ id "<me>-<target>" }` existence (indexer) or the
viewer's `followEdges(viewer.address).following` set; PAPI-direct folds `Followed`/`Unfollowed`. The
button **returns `null` on self**, so the surface explicitly swaps in the Edit/Set-up button — the two
are mutually exclusive by `author.address === viewer.address`.

### 4.5 Follower / following counts

`<FollowCounts>` — two inline figures, X-exact: **"1,204 Following · 8,901 Followers"** (number in
`--cg-fw-bold` `--cg-text`, label in `--cg-text-secondary`).

- Lists surface is **OUT of scope** (`00-overview.md`), so clicking a count does **not** route to a
  dedicated `/u/<a>/followers` page. **Decision (chosen behavior): the counts are display-only** —
  non-interactive `<span>`s that show the follower/following totals (optionally rendered as a link
  stub pointing at the deferred list, but with no live target in v1).
- The **inline expandable follower/following LIST** (a list of `Avatar` + `DisplayName` + `Handle` +
  `FollowButton size='sm'` rows beneath the header) is **DEFERRED** — the Lists surface is out of
  scope, so enumerating the edges into a browsable list is **not built in v1**. Do not half-ship it;
  the counts stand alone.
- Counts come from `author.followerCount` / `author.followingCount` (indexer denormalized on
  `Author`). **PAPI-direct cannot serve these** (`caps.follows:false`) → **omit both counts entirely**
  (do not render "0 Followers" — render nothing) per `04-data-layer.md` §2.6.
- Numbers are formatted with thousands grouping (`Intl.NumberFormat`); they are plain JS `number`s on
  the indexer (`Int`), so no BigInt concern here (unlike `weight`/`score`, D12).

### 4.6 Banned author (D10)

When `author.banned === true` (an author the follower observed a `Revoked` event for):

- The header avatar + display name render **dimmed** (`--cg-text-muted` text, dimmed `Avatar` via the
  `dim` prop).
- A neutral, non-judgmental **"restricted" note** is shown after the handle (e.g. *"This account has
  been restricted."*) — copy is neutral, **no honesty/trust framing** (D10/D7).
- **Posts REMAIN visible** in all tabs (content is permanent; nothing is ever deleted) — the tab
  `PostCard`s render dimmed via `post.author.banned` (the `PostCard` already handles this, `03` §1).
- **`FollowButton` is still rendered** (you may still follow/unfollow a restricted account — the chain
  permits it; do not special-case).
- **PAPI-direct:** `banned` is best-effort (`PkhOf` absence) — surfacing may be partial (D10 capability
  note). Never hard-fail on it.

> **There is no `deleted` field anywhere** — remove every `Post.deleted` / `deleted:{equalTo:false}`
> reference from the profile queries (D10). Nothing is hidden; only authors get `banned`.

---

## 5. ProfileTabs & the three tab bodies

`ProfileTabs` (`03` §22.3): **Posts / Replies / Likes**. Props `active: 'posts'|'replies'|'likes'`,
`onChange`. Sticky second row under the header (`position: sticky`, below the back-arrow row), active
tab marked with the X-style accent **underline indicator** (`--cg-accent`, 4px, animated slide).

> **NO "Media" tab.** X has a Media tab; cogno-chain posts are **text-only ≤ 512 bytes with no media
> field** (D1) — a Media tab would always be empty and is **deliberately omitted**. Document this in a
> code comment at the `ProfileTabs` definition. (X's "Highlights" / "Articles" tabs are likewise out.)

Active tab is reflected in the URL via a **query param** (`?tab=replies` / `?tab=likes`; default
`?tab=posts` or no param), so a deep link to a tab is shareable (read client-side with
`useSearchParams()`; the static-export route is still `/u/[address]` — the tab is query state, not a
new route). Switching tabs `history.pushState`s the query without a full nav.

Each tab body is a **`Timeline`** (`03` §22.1) of `PostCard`s (hairline-divided, hover row-highlight,
windowed list), with the per-post action callbacks forwarded (Reply / Repost / Quote / Like / overflow
→ same handlers as the home timeline; the **inline post actions** here are the only place
`RateLimitNotice` can appear on this surface, when liking/reposting/replying from a profile card hits
`CheckCapacity`, D5).

### 5.1 Posts tab (default) — `PROFILE_BY_ACCOUNT`

Top-level authored content (posts + quotes + polls), newest-first, with the **pinned post hoisted to
the top**.

**Query** (`04-data-layer.md` §2.6, reproduced verbatim — **no `deleted` field**):

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

- **Filter:** `posts` filtered to **`parentId: { isNull: true }`** (top-level posts + quotes + polls;
  replies are excluded from Posts and live in the Replies tab — X-exact).
- The single `author { … }` block hydrates the entire `ProfileHeader` (display fields, counts,
  `weight`, `banned`, `identityHash`, `pinnedPostId`) **and** the Posts tab in one round-trip.
- **Pinned post:** `pinnedPostId` is a **bare string id**, **not validated on-chain**. Fetch that one
  post separately via `ONE_POST` (`04` §2.6 / the `getPost`/one-post query) and render it as a
  `<PinnedPostBlock>` (a `PostCard` with `headerExtra` = a "📌 Pinned" marker, `03` §1) **above** the
  `posts` list. **If the pinned id 404s or is not the author's** (id reused, deleted-from-window),
  **silently omit** the pinned block (no error). De-dupe: if the pinned post also appears in the first
  page of `posts`, suppress the duplicate in the list (render it only as the pinned block).
- **Pagination** (cursor) gated on `caps.pagination` (indexer true; PAPI-direct shows the first window
  + a quiet "Connect an indexer to load more" footer). `Timeline.onLoadMore` pages with `$after`.

### 5.2 Replies tab — `PROFILE_REPLIES`

The author's replies (posts where `parentId != null`), newest-first. Same `posts` shape, filter
**`parentId: { isNotNull: true }`**, `tab:"replies"` on the `FeedQuery` (`04-data-layer.md` §2.6).
X renders these as "replying to @x" cards; reuse `PostCard` (it already shows the "Replying to @x"
line from `post.parent`). The query selects the same node fields plus the parent for context:

```graphql
query ProfileReplies($ss58: String!, $first: Int!, $after: Cursor) {
  author(id: $ss58) {
    posts(first: $first, after: $after, orderBy: ID_DESC,
          filter: { parentId: { isNotNull: true } }) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes {
        id text parentId blockHeight isPoll
        upWeight downWeight upCount downCount score repostCount
        parent { id authorId author { id banned displayName avatar } }   # "Replying to @…"
        quote { id text author { id banned displayName avatar } }
      }
    }
  }
}
```

> If the indexer schema cannot filter the nested `posts` connection by `parentId`, fall back to the
> top-level `posts(filter:{ authorId:{equalTo:$ss58}, parentId:{ isNotNull:true } })` query form
> (same fields). The `FeedSource.profile({ author, tab:'replies' })` method owns which form it emits.

### 5.3 Likes tab — `PROFILE_LIKES`

Posts the author **up-voted** — the chain's **Up vote == Like** (D2). Query the author's `Vote` edges
where `dir == "Up"` and resolve each `post` (`04-data-layer.md` §2.6, reproduced):

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

- **Only `dir:"Up"`** appears in Likes — **down-votes are NOT likes** (they live in the post overflow,
  D2). One-line rationale: the heart == the up-vote, so "Likes" == the author's up-votes.
- Map each `votes.nodes[].post` → a `PostVM` and render as `PostCard`s (these cards show the **liked
  post's own author**, not the profile owner). Self-likes are allowed and appear here (D2).
- Newest-first by `Vote` id (`ID_DESC`).
- **Privacy note:** X Likes are private-ish; on-chain votes are **public** (the chain is transparent).
  We surface them as a normal tab — there is no on-chain privacy to honor, and hiding them would be
  dishonest about the data. No special framing.

### 5.4 PAPI-direct fallback (degraded tabs)

When `feedSource.kind === 'papi'` (no indexer), `source.profile` resolves the account, reads
`Microblog.ByAuthor` → posts; sets `banned` from `PkhOf` absence, `weight` from
`TalkStake.AllowedStake`, `identityHash` from `PkhOf`. It **cannot** serve
`displayName`/`bio`/`avatar`/`followerCount`/`followingCount` (`caps.profiles:false`,
`caps.follows:false`):

| Element | indexer (`graphql`) | PAPI-direct (`papi`) |
|---|---|---|
| display name / bio / avatar | from `Author` (folded `ProfileSet`) | **omit** → `DisplayName` falls back to truncated ss58, `Avatar` to identicon, bio hidden |
| follower / following counts | `followerCount`/`followingCount` | **omit both** (`caps.follows:false`) |
| Posts tab | `posts(parentId isNull)` | `ByAuthor` window (first window only; "load more" → connect-indexer footer) |
| **Replies tab** | `parentId isNotNull` | **hide the tab** (no reverse filter window guarantee) |
| **Likes tab** | `votes(dir Up)` | **hide the tab** (needs the `Vote` reverse index) |
| pinned post | `pinnedPostId` + `ONE_POST` | read `Profile.Profiles(account).pinned` via storage if available, else omit |
| banned dim | `Author.banned` | best-effort (`PkhOf` absence) |
| weight | `Author.weight` | `TalkStake.AllowedStake` |

> **Tab visibility is caps-driven:** when `caps.profiles === false`, `ProfileTabs` renders **only the
> Posts tab** (Replies/Likes hidden, not shown-then-errored). The data layer exposes this via
> `feedSource.caps`; the surface reads it and conditionally renders the tab strip. (See `04` §2.6 and
> the `FeedCaps` gating table.)

---

## 6. Who-is-this-when-unbound fallback (bare address)

`/u/<addr>` may resolve to an account with **no identity bind and no posts** — a bare ss58 that was
followed, or pasted into the URL, or that has no on-chain footprint. **Do not show an error** — show
the X "this account exists but is empty" treatment:

- Header: identicon `Avatar` (deterministic from the address) + truncated-ss58 `DisplayName` + the
  copyable `Handle`. No bio, no banner gradient variation beyond the address seed, **no counts**
  (omit), and the **"Set up profile"** button **only if it's the viewer's own address** (otherwise the
  Follow button, which is permitted on a no-post account — `target` is not existence-checked, D6/§4.4).
- Body: `ProfileTabs` with all three tabs **empty**; the Posts tab shows `EmptyState`:
  - **own address, no profile, no posts:** *"Set up your profile and post something."* (CTA → Edit
    profile / `/compose`).
  - **someone else, no posts:** *"@5CBE…oFC hasn't posted yet."* (no CTA).
- This is distinct from the **invalid-address** case (§5.1 / §10), which is an in-app 404, not an empty
  profile.

> **One-line rationale:** an address with no profile is still a real account (you can follow it, it may
> post later) — X shows the empty shell, not a 404, so we mirror that; only a *malformed* address is a
> 404.

---

## 7. Write affordances & the identity-bound gate

Everything the viewer can **write** from this surface, with its extrinsic and gate (gating per
`04-data-layer.md` §6 SessionState + `05-divergences-and-constraints.md` D7/D9):

| Action | Where | Extrinsic | Arg shape | Cost | Gate (`Viewer.status`) |
|---|---|---|---|---|---|
| Follow | header `FollowButton` (others) | `Microblog.follow(target: AccountId)` | `{ target: ss58 }` | **feeless** (capacity-metered, `FollowCost`) | `ready` → fire; `not-connected`→`/welcome`; `not-identity-bound`→disabled+tooltip |
| Unfollow | header `FollowButton` (Following→hover) | `Microblog.unfollow(target: AccountId)` | `{ target: ss58 }` | feeless | same |
| Edit profile | header "Edit profile" / "Set up profile" (self) | `Profile.set_profile(display_name, bio, avatar)` | `{ display_name: Binary.fromText, bio: Binary.fromText, avatar: Binary.fromText }` | **FEE-BEARING** signed | self + `ready`; needs a **funded** account (D9) |
| Clear profile | inside `EditProfileModal` | `Profile.clear_profile()` | `{}` | FEE-BEARING | same |
| Pin post | post `[···]` overflow (own post) / `EditProfileModal` pinned-post control | `Profile.pin_post(id: u64)` | `{ id: bigint }` | FEE-BEARING | self + `ready` + funded |
| Unpin | pinned-post `[···]` / `EditProfileModal` | `Profile.unpin_post()` | `{}` | FEE-BEARING | same |
| Like / Repost / Quote / Reply / Vote on a tab card | `PostCardActions` on tab `PostCard`s | `Microblog.vote`/`repost`/`quote_post`/`post_message`/`clear_vote` | per `04` §3 | **feeless** capacity-metered | `ready`; binds gate to `/welcome` |

**Gate funnel (write intent):** when `viewer.status !== 'ready'`, any write affordance routes to
`/welcome` (not connected → connect wallet → derive key → bind), per
`01-information-architecture.md` §6.4 and D7. `not-identity-bound` disables the control with a tooltip
("Finish setting up to follow / edit your profile").

**Feeless vs fee-bearing (the key profile divergence, D9):** Follow/Unfollow and the tab-card actions
are **feeless** (optimistic UI, silent success; rate-limit → `RateLimitNotice` if capacity exhausted).
**Edit profile / clear / pin / unpin are FEE-BEARING and signed** — they need a **funded** posting
account and are **NOT optimistic** (show a pending `Spinner` + success `Toast` "Profile saved"). On
insufficient balance they raise a **funding state** (§9.4), **never** a `RateLimitNotice` (rate-limit
is a capacity concept; this is a balance concept — keep them distinct, D5/D9).

---

## 8. FollowButton interaction (optimistic)

(Component spec `03` §12; this is the surface-level wiring.)

1. **Not following → Follow:** click → optimistically flip the button to **"Following"** and
   **+1** the header `followerCount`; submit `Microblog.follow(target)`. On `inBestBlock`: keep
   (silent). On invalid/error: roll back the label + decrement count + error `Toast`.
2. **Following → Unfollow:** hover shows "Unfollow" (`--cg-danger`); click → optimistically flip to
   **"Follow"** and **−1** count; submit `Microblog.unfollow(target)`. **No confirm** (X doesn't
   confirm unfollow). Rollback on error.
3. **Self:** `FollowButton` renders `null`; the Edit/Set-up button shows instead (§4.4).
4. Edge-state reconciliation: from `followEdges(viewer.address).following` (indexer
   `outgoingFollows` / `Follow{ id "<me>-<target>" }`); PAPI-direct folds `Followed`/`Unfollowed`. The
   optimistic overlay (keyed by `(viewer.address, target)`) is dropped once the real edge confirms.

`useFollow` (`04` §7 hooks) owns the mutation + optimistic overlay.

---

## 9. EditProfileModal flow (fee-bearing)

The modal is **`EditProfileModal`** (`03` §22.4 / `12-surface-settings.md`-owned chrome). This surface **opens
it** via the `edit-profile` **modal route** (`01-information-architecture.md` §7): clicking "Edit
profile" / "Set up profile" sets `modalStore = { kind: 'edit-profile' }` and `history.pushState`s the
shareable form; the standalone deep-link fallback is **`/settings/`** with the edit section focused
(edit-profile is a Settings concern). Esc / back / dim-click closes.

### 9.1 Fields & limits (ByteCounter, UTF-8 BYTES — D1/D9/D12)

| Field | Extrinsic arg | Limit (BYTES) | Const | Counter |
|---|---|---|---|---|
| Display name | `display_name` | **≤ 64** | `MaxName` | `ByteCounter` 64 |
| Bio | `bio` | **≤ 256** | `MaxBio` | `ByteCounter` 256 |
| Avatar URL/CID | `avatar` | **≤ 128** | `MaxAvatar` | `ByteCounter` 128 |

- `ByteCounter` (`03` §8) measures **UTF-8 bytes** (`new TextEncoder().encode(s).length`), **not
  characters** — hard-block the Save CTA at over-limit.
- **Avatar is a reference string, not image bytes** (a URL or IPFS CID, ≤ 128B). Validate it parses as
  a URL / CID; show a small live `Avatar` **preview** beside the field (the same sanitized `<img>` +
  identicon-onError fallback as `Avatar`, `03` §13). **No upload** (out of scope).
- A **"Pinned post" control** lives in the modal (`pin_post(id)` / `unpin_post()`); accept any u64,
  **warn softly** if it isn't one of the viewer's own posts (not validated on-chain — D9 / §11).

### 9.2 Pre-fill

Pre-fill from `initial: { displayName, bio, avatar, pinnedPostId }` (the viewer's current `Author`
fields). For the no-profile-yet owner all are empty (the "Set up profile" path opens the same modal
blank).

### 9.3 Submit (fee-bearing, signed, NOT optimistic)

- **Save** → `submitSetProfile(api, signer, name, bio, avatar)` → `Profile.set_profile(display_name,
  bio, avatar)` with `Binary.fromText` on each arg (`04` §3). Show a **`Spinner`** on the Save CTA
  while signing/broadcasting (these are signed + fee-bearing, so we do **not** optimistic-render the
  header). On `inBestBlock`: success **`Toast`** "Profile saved", close modal, **refetch the profile**
  (`source.profile`) so the header reflects the new fields. On error: keep the modal open, error
  `Toast`, do not close.
- **Clear** → `submitClearProfile` → `Profile.clear_profile()` (resets all three fields; confirm
  inline since it wipes everything).
- **Pin / Unpin** → `submitPinPost(id)` / `submitUnpinPost()` → `Profile.pin_post(id)` /
  `Profile.unpin_post()`; on success refetch + re-render the pinned block.

### 9.4 Funding (insufficient balance) — D9, **NOT a RateLimitNotice**

Profile/pin txs are **fee-bearing**. If the account is unfunded:

- Detect via a **pre-flight balance check** (the signer account's free balance vs the estimated fee,
  via `useBalance(api, ss58)` + the fee-estimate helper from `04-data-layer.md` §7.2) or the dispatch
  error (`InvalidTransaction::Payment` / insufficient balance).
- Show a **quiet "fund your account" state** inside the modal — a neutral hint ("Editing your profile
  needs a small balance. Add funds to continue."), **NOT** framed as honesty and **NOT** the
  `RateLimitNotice` (rate-limit is capacity; this is balance — keep them distinct). The "fund your
  posting account" requirement (and the exact funding mechanism — faucet / transfer) is **owned by
  `12-surface-settings.md`**; this surface just **surfaces the state** and links to Settings.
- The fee hint is a **quiet** one-liner ("this costs a small fee"), never an honesty/trust frame (D9).

---

## 10. Static-export address resolution (`/u/[address]`)

Per `01-information-architecture.md` §2, `output:'export'` cannot pre-render unknown ids:

- `src/app/u/[address]/page.tsx` exports a **placeholder** `generateStaticParams()` returning
  `[{ address: '_' }]` (one stub so the route compiles to `out/u/_/index.html`). **Never** set
  `dynamicParams = false`.
- nginx serves the SPA shell for any real id via `try_files $uri $uri/ /404.html` (the canonical
  fallback block). A deep link `/u/<real-ss58>/` boots the shell; the client resolver fetches by
  address.
- **Read the param client-side** with `useParams()`; **validate** it: length + base58 alphabet, then a
  real `decodeAddress(address)` in a `try/catch` inside the profile fetch.
  - **Invalid** ss58 → render `<ProfileNotFound>` (an in-app 404 panel mirroring `NotFoundPage`, not a
    real HTTP 404) with a "Go home" link. Do **not** attempt a chain read.
  - **Valid** → call `source.profile({ author: address })`.
- Self-detection: `address === viewer.address` (compare normalized ss58, prefix 42) drives the
  self-view header variant (§4.4). The `LeftNav`/`BottomTabBar` "Profile" item targets `/u/<me>/`
  (`01` §6).

---

## 11. UI states (exhaustive)

| State | Trigger | Rendering |
|---|---|---|
| **Loading (cold)** | `source.profile` in flight | `ProfileHeader` skeleton (`Skeleton` banner block + circle avatar + 2 text lines + count placeholders) + `Skeleton variant='post' count={6}` in the tab body. No layout shift when real data lands. |
| **Loaded** | resolved `Author` + first posts page | full header + pinned block + `Timeline`. |
| **Tab loading** | switching to Replies/Likes | tab body → `Skeleton variant='post' count={6}`; header stays mounted (no reflow). |
| **Empty — Posts** | `posts.totalCount === 0` | `EmptyState` — own profile: *"You haven't posted anything yet."* + Compose CTA; other: *"@5CBE…oFC hasn't posted yet."* |
| **Empty — Replies** | no replies | `EmptyState` *"No replies yet."* |
| **Empty — Likes** | no Up-votes | `EmptyState` — own: *"Posts you like show up here."*; other: *"@5CBE…oFC hasn't liked any posts yet."* |
| **Empty — bare/unbound account** | no profile + no posts (§6) | who-is-this fallback header + empty Posts `EmptyState`. |
| **Pinned present** | `pinnedPostId` resolves | `<PinnedPostBlock>` (📌 marker) above Posts list; de-duped from the list. |
| **Pinned dangling** | `pinnedPostId` 404s / not author's | **silently omit** the pinned block (no error). |
| **Banned author** | `author.banned === true` | dimmed header + neutral "restricted" note; posts **remain** (dimmed cards); Follow still permitted (D10). |
| **Error (profile fetch)** | network / indexer down | inline error panel in the body: *"Couldn't load this profile."* + a **Retry** button; if `kind==='graphql'` and it errors, the data layer may **fall back to PAPI-direct** (degraded, §5.4) rather than show the error — prefer that. |
| **Invalid address** | `decodeAddress` throws | `<ProfileNotFound>` in-app 404 (§10). |
| **Not connected** (viewer) | `viewer.status==='not-connected'` | reads work fully; Follow/Edit affordances route to `/welcome` (§7). |
| **Not identity-bound** (viewer) | `viewer.status==='not-identity-bound'` | reads work; Follow disabled+tooltip; Edit routes to finish-setup. |
| **Self, no profile** | own address, all fields empty | **"Set up profile"** filled-accent button + the no-profile nudge `EmptyState` on Posts (§4.4/§6). |
| **Edit pending** | `set_profile` broadcasting | Save CTA → `Spinner`, modal locked. |
| **Edit success** | `inBestBlock` | success `Toast` "Profile saved"; modal closes; header refetched. |
| **Edit insufficient balance** | unfunded | in-modal **funding state** (§9.4) → Settings; **not** a rate-limit. |
| **Optimistic follow pending** | `follow` in flight | button shows optimistic "Following" + bumped count (rolls back on error). |
| **Tab-card rate-limited** | a like/repost/reply from a tab card hits `CheckCapacity` | inline `RateLimitNotice` on that card (D5) — header/edit untouched. |

---

## 12. Responsive behavior

| Breakpoint | Layout |
|---|---|
| **Desktop ≥ 1020px** | 3-column shell (`LeftNav` 275 + center 600 + `RightRail` 350); profile in the center column; banner 200px; avatar `xl` 133px overlapping; counts inline; sticky header (back-arrow + name + "N posts") + sticky `ProfileTabs` row. |
| **Tablet 688–1019px** | collapsed icon `LeftNav` (88px), **no `RightRail`**; center column widens toward the 600px cap; banner ~160px; avatar ~110px. Header + tabs identical. |
| **Mobile < 688px** | single column, no rails; `BottomTabBar` (4 tabs) + compose FAB; banner ~120px; avatar ~80px; action button right-aligned on the name row; counts wrap; `ProfileTabs` is swipeable / scroll-snap; sticky header collapses to back-arrow + name + subtitle. |
| **Center column cap** | `--cg-col-feed` 600px max-width; container `--cg-content-max` 1265px. |
| **Tab strip** | sticky under the header at all breakpoints; on mobile, horizontal swipe between tabs is acceptable (X-like); the active underline indicator slides. |

The sticky header uses `backdrop-filter: blur(12px)` over translucent `--cg-bg` (`--cg-header-blur`),
`position: sticky; top: 0; z-index: var(--cg-z-sticky)` (`02` tokens). The banner scrolls **under** the
sticky header (X-exact: the header fades in over the banner as you scroll; the name in the header
appears once the big name scrolls past).

---

## 13. Accessibility

- **Landmarks:** the profile body is a `<main>`; the tab strip is a `role="tablist"` with each tab a
  `role="tab"` (`aria-selected`), tab bodies `role="tabpanel"` (`aria-labelledby` the tab). Arrow-key
  roving focus between tabs; `Enter`/`Space` activates.
- **Back arrow:** a real `<button aria-label="Back">`; `history.back()` if in-app history, else
  `router.push('/')` (`01` §7 uniform back behavior).
- **Handle copy:** the copyable `Handle` is a `<button aria-label="Copy address 5CBE…oFC">` (full
  address in the label/`title`); copy raises an `aria-live="polite"` `Toast`.
- **Avatar:** `alt = "{displayName or @handle} avatar"`; when it wraps a link to nothing (own avatar)
  it's decorative.
- **FollowButton:** `<button aria-pressed={isFollowing}>` with `aria-label` "Follow @handle" /
  "Following @handle, click to unfollow"; the hover label-swap is visual only (accessible name stable).
- **Counts:** each count link has an accessible name ("1,204 Following", "8,901 Followers"); when
  display-only (PAPI-direct hidden) they're omitted entirely (no empty announcements).
- **Banned note:** the "restricted" text is real text (`role="note"` optional), not color-only — never
  rely on dimming alone to convey banned (color-contrast independent).
- **Feed keyboard nav** in the tab body: the `Timeline` owns `j`/`k` (next/prev post), `Enter` (open
  post detail), `l` (like), `r` (reply), `t` (repost), `.` (overflow) — same as the home timeline (`03`
  §0.5 / `06-surface-home.md`); cards expose `data-post-id`, `tabIndex`, refs. `n` = new post
  (compose) works globally.
- **Focus:** visible `--cg-accent` focus ring (2px, offset 2px) on every interactive element; the
  `EditProfileModal` is focus-trapped, Esc-closes, restores focus to the trigger on close.
- **Reduced motion:** the tab-underline slide, optimistic fade-in, and skeleton shimmer collapse to
  instant/opacity-only under `prefers-reduced-motion` (`02` motion tokens).

---

## 14. Notifications hook (deferred — leave clean seam)

Notifications are **deferred** (`00-overview.md` / `03` §24). The profile surface touches several
events a future `/notifications` surface would fold; leave a labeled comment at the relevant call sites:

- A **`Followed{ follower, followee }`** where `followee === viewer.address` is a "new follower"
  notification — the `FollowButton` / `useFollow` path already emits/reads this edge.
- **`Voted{ id, who }`** / **`Reposted{ id, who }`** on the viewer's posts (surfaced from the tab
  cards) are like/repost notifications.
- Reply `PostCreated` where `parent.author === viewer` and quote `quote_post` where the quoted post's
  author === viewer are reply/quote notifications.

No bell badge or `/notifications` route is built now; do **not** invent one beyond a placeholder nav
slot if convenient. The data already exists (`Follow`, `Vote`, `Repost`, `Post.parent`, `Post.quote`).

---

## 15. Implementation checklist

Ordered; a dev can execute top-to-bottom. Reuse `02` tokens, `03` components, `04` queries verbatim.

- [ ] **Route scaffold:** create `src/app/u/[address]/page.tsx` (`'use client'`, `ProfilePage`) with a
      **placeholder `generateStaticParams()` → `[{ address: '_' }]`**; never `dynamicParams = false`
      (`01` §2 / §10).
- [ ] **Resolver (`ProfileResolver`):** read `useParams()`, validate the ss58 (base58 alphabet +
      length + `decodeAddress` try/catch). Invalid → `<ProfileNotFound>` in-app 404. Valid → proceed.
- [ ] **Self-detection:** compare normalized `address` to `viewer.address` (prefix 42) → self-view flag
      driving the action-button switch (§4.4).
- [ ] **Wire `source.profile({ author })`** (+ `source.followEdges(viewer.address)` gated
      `caps.follows`); handle `kind==='papi'` degradation (§5.4) — hide Replies/Likes tabs + counts +
      bio when `caps.profiles===false`.
- [ ] **`ProfileHeader`** (`03` §22.3): banner = **address-seeded accent gradient** (no chain field,
      §4.1); `xl` overlapping `Avatar` (identicon fallback, `dim` on banned); `DisplayName` (ss58
      fallback) + copyable `Handle`; `PostBody` bio; `FollowCounts` (omit on PAPI-direct); the
      self-vs-other action button (Follow / Following / **Edit profile** / **Set up profile**) per §4.4;
      banned "restricted" note (§4.6).
- [ ] **Sticky headers:** row 1 = back-arrow + `DisplayName` + "N posts" subtitle (`blur(12px)` over
      `--cg-bg`); row 2 = sticky `ProfileTabs`. Banner scrolls under (X fade-in).
- [ ] **`ProfileTabs`** (`03` §22.3): **Posts / Replies / Likes** — **no Media tab** (code comment
      explaining the omission, D1). URL tab state via `?tab=` + `history.pushState`; caps-gated tab
      visibility.
- [ ] **Posts tab:** `PROFILE_BY_ACCOUNT` (`04` §2.6, **no `deleted` field**), filter
      `parentId:{isNull:true}`; render `Timeline` of `PostCard`s; cursor pagination gated
      `caps.pagination`.
- [ ] **Pinned block:** fetch `pinnedPostId` via `ONE_POST`; render `<PinnedPostBlock>` (`PostCard` +
      "📌 Pinned" `headerExtra`) above the list; **silently omit** if it 404s / isn't the author's;
      de-dupe from the first page.
- [ ] **Replies tab:** `PROFILE_REPLIES`, filter `parentId:{isNotNull:true}`; `PostCard` shows
      "Replying to @x" from `post.parent`.
- [ ] **Likes tab:** `PROFILE_LIKES` — `votes(filter:{voterId:eq, dir:eq "Up"})` → resolved `post`
      (down-votes excluded); render each liked post's own author (D2).
- [ ] **Who-is-this fallback (§6):** no profile + no posts → identicon header + empty `EmptyState`s;
      own-address → "Set up profile" nudge; never a 404 (only invalid ss58 is a 404).
- [ ] **FollowButton wiring (§8):** `useFollow` optimistic toggle → `Microblog.follow` /
      `Microblog.unfollow`; bump/decrement header count; rollback + error `Toast`; `null` on self.
- [ ] **EditProfileModal trigger (§9):** open via the `edit-profile` modal route (`01` §7), standalone
      fallback `/settings/`. Pre-fill from `initial`. `ByteCounter` 64 / 256 / 128 (UTF-8 BYTES). Avatar
      preview (sanitized `<img>` + identicon onError). Pinned-post control. Submit
      `submitSetProfile`/`submitClearProfile`/`submitPinPost`/`submitUnpinPost` (fee-bearing, signed,
      `Spinner` + success `Toast` "Profile saved", refetch on success).
- [ ] **Funding state (§9.4):** pre-flight balance / `Payment` error → quiet in-modal "fund your
      account" state → Settings link; **NEVER** a `RateLimitNotice`.
- [ ] **Pin/unpin from a post `[···]`** (own posts): `Profile.pin_post(id)` / `unpin_post()`
      (fee-bearing); refetch the pinned block.
- [ ] **Gating (§7):** every write affordance funnels to `/welcome` when `not-connected`; disables +
      tooltips when `not-identity-bound` (D7).
- [ ] **Banned handling (D10):** dim header + neutral "restricted" note; keep posts visible (dimmed
      cards); Follow still permitted; **remove every `Post.deleted` reference** from the profile
      queries.
- [ ] **States (§11):** loading skeletons (header + cards), per-tab empty states, error panel with
      Retry (prefer PAPI-direct fallback over a hard error), invalid-address 404, optimistic-follow
      pending, edit pending/success/funding, tab-card rate-limit.
- [ ] **Responsive (§12):** banner/avatar sizes per breakpoint; `RightRail` only ≥1020; collapsed rail
      688–1019; bottom-tabs + FAB <688; swipeable tabs on mobile.
- [ ] **Accessibility (§13):** `tablist`/`tab`/`tabpanel` roles + roving focus; back-arrow button;
      copyable-handle button + `aria-live` toast; `FollowButton aria-pressed`; banned note as real text;
      `Timeline` feed-keyboard nav; reduced-motion guards; modal focus-trap.
- [ ] **Notifications hook (§14):** leave the labeled deferred comment at the follow / vote / repost /
      reply / quote sites; build no `/notifications` surface.
- [ ] **Smoke:** deep-link `/u/<real-ss58>/` cold (nginx SPA fallback → shell boots → client resolves);
      `/u/<me>/` shows Edit/Set-up; `/u/<malformed>/` → in-app 404; PAPI-direct (no indexer) shows
      Posts-only with identicon + ss58 fallback and omitted counts.
```
