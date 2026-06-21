# 03 — Component Library

This is the shared component kit that every chain-backed surface composes. It specifies **every**
reusable component from the canonical COMPONENT NAMES list — name, purpose, ASCII anatomy, a
TypeScript prop table, variants, all visual states, the design tokens it consumes, the exact data
bindings (GraphQL fields + the PAPI-direct fallback path and which `FeedCaps` gate it), the exact
extrinsics each interaction calls, and accessibility. The goal is a faithful **Twitter/X clone**
re-skinned with the cogno-chain wordmark and the cogno teal accent — match X's actual layout,
density, spacing rhythm, pill buttons, hairline dividers, hover row-highlight, and action-row icon
interactions; do **not** invent a "distinctive" look. We surface only two chain realities to the
user: a graceful **rate-limit** notice when talk-capacity is exhausted, and a quiet **failure
toast** on tx error. Everything else uses **optimistic UI** (the action shows immediately,
reconciles on confirmation, rolls back on failure).

> Token names, theme mechanics, type scale, and the `--cg-*` custom properties come from
> **02-design-system.md**. Routes, the static-export dynamic-route strategy, and the app shell
> (`AppShell`, `LeftNav`, `BottomTabBar`, `RightRail`) come from **01-information-architecture.md**.
> Per-surface composition (Home, Explore, Profile, Thread, Compose, Settings, Welcome) lives in
> **06-12** surface docs and references the components named here **verbatim**. The data seam
> (`FeedSource`, `FeedCaps`, hooks) and the optimistic-mutation layer are detailed in
> **04-data-layer.md**; this doc binds to them but does not redefine them.

---

## 0. Shared conventions (read first)

These rules apply to every component below; they are not repeated in each section.

### 0.1 Optimistic mutation contract

Every feeless write (`post_message`, `quote_post`, `vote`, `clear_vote`, `repost`, `follow`,
`unfollow`, `create_poll`, `cast_poll_vote`) is rendered **optimistically**:

1. On user intent, the component flips its local UI immediately (count +1, heart fills, button →
   "Following", post appears at top of the timeline as `pending`).
2. The submit goes through the data/state layer's `useMutation`-style helper (see
   **04-data-layer.md** → `useOptimisticAction`), which broadcasts the extrinsic and watches it
   to `inBestBlock`.
3. On `inBestBlock` success the optimistic value is **reconciled** (replaced by the canonical
   indexer/PAPI value on the next snapshot) — the UI does not visibly change if they agree.
4. On dispatch error, pool rejection, or timeout the optimistic value is **rolled back** and a
   failure `Toast` is raised (§ Toaster/Toast). The CheckCapacity pool rejection is special-cased to
   a `RateLimitNotice`, not a generic error toast (§ RateLimitNotice).

Components expose this via a small per-action state machine with the exact union:
`'idle' | 'pending' | 'ok' | 'error' | 'rate-limited'`. The canonical prop carrying it is
`actionState` (or a per-action variant like `likeState`, `repostState`). **No component reaches
into PAPI/GraphQL directly** — all writes go through props/callbacks supplied by the surface.

### 0.2 Identity / connection gating

Three gate states recur:

- **not-connected** — no Cardano wallet connected. Write affordances render but, on click, open the
  `ConnectWalletButton` flow / route to `/welcome` instead of submitting.
- **not-identity-bound** — wallet connected, derived posting account exists, but
  `CognoGate.link_identity_signed` has not been observed yet (no `IdentityLinked`). Write
  affordances are visible but **disabled** with a tooltip "Finish setup to post" linking `/welcome`.
- **ready** — identity bound. Stake (voting power) is a further sub-gate: vote/poll-vote weight is
  zero until `link_stake_signed`; these actions still submit (a zero-weight vote is valid) but the
  component shows a one-line "Add voting power" hint inline (see `PollCard`, `PostCardActions`).

The gate state is supplied to components via a single `viewer` prop (§ 0.4); components never
compute it.

### 0.3 Banned authors

After a `Revoked` event an author's `banned` flag is `true`. Posts stay (content is permanent).
A `PostCard` whose `post.author.banned === true` renders **dimmed** (`--cg-text-muted` body,
`opacity` per token) with a small "This account has been restricted" chip; the body remains readable (no
hard hide). There is **no** soft-delete: do not reference a `deleted` field anywhere (it was removed
from the schema — see **04-data-layer.md**; the current `queries.ts` still mentions it and must
be purged).

### 0.4 The `viewer` and `post` view-model shapes (canonical)

To keep prop tables terse, these two shapes are referenced everywhere:

```ts
// The connected user, derived once in AppShell and passed down via context/props.
export interface Viewer {
  status: 'not-connected' | 'not-identity-bound' | 'ready';
  address?: string;            // ss58 (prefix 42) of the derived posting account; the @handle source
  identityHash?: string;       // 0x beacon name; undefined until bound
  hasVotingPower: boolean;     // true once link_stake_signed observed (weight > 0)
  displayName?: string;        // viewer's own Profile.display_name (for composer avatar/name)
  avatar?: string;             // viewer's own Profile.avatar URL
}

// A post as the UI consumes it — assembled by the data layer from GraphQL Post or PAPI events.
export interface PostVM {
  id: string;                  // u64 as string
  author: AuthorVM;
  text: string;                // raw UTF-8; PostBody auto-links URLs, renders no media
  parentId: string | null;     // reply target (top-level reply parent); null = not a reply
  parent?: { id: string; author: AuthorVM } | null; // for "Replying to @x"
  quote?: PostVM | null;       // quoted post (for QuotedPostEmbed); null = not a quote
  blockHeight: number;
  timestamp: string | null;    // ISO; null on PAPI-direct (no timestamp) → show block height
  isPoll: boolean;
  poll?: PollVM | null;        // present iff isPoll
  upWeight: bigint; downWeight: bigint;
  upCount: number; downCount: number;
  score: bigint;               // upWeight - downWeight (may be negative)
  repostCount: number;
  // viewer-relative, hydrated from the viewer's own votes/reposts (optimistic-overridable):
  viewerVote: 'Up' | 'Down' | null;
  viewerReposted: boolean;
  pending?: boolean;           // true while this card is an optimistic not-yet-confirmed post
}

export interface AuthorVM {
  address: string;             // ss58 → the @handle (truncated) and identicon seed
  identityHash: string | null;
  banned: boolean;
  displayName: string | null;  // Profile.display_name; fallback to truncated address
  avatar: string | null;       // Profile.avatar URL; fallback to identicon
}

export interface PollVM {
  hostPostId: string;
  options: { index: number; label: string; weight: bigint; count: number }[];
  totalWeight: bigint;
  totalCount: number;
  viewerOption: number | null; // the option index the viewer cast, or null
}
```

These VMs are built in **04-data-layer.md**; components receive them ready-made.

### 0.5 Accessibility baseline

- All interactive elements are real `<button>`/`<a>` (never click-handlers on `<div>`), keyboard
  focusable, with a visible focus ring (`--cg-accent` outline, 2px, offset 2px).
- Icon-only buttons carry an `aria-label`. Toggle buttons carry `aria-pressed`.
- Live regions: the `Toaster` is `aria-live="polite"`; `RateLimitNotice` inline copy is
  `role="status"`.
- Feed keyboard nav (`j`/`k`/`n`/`l`/`r`/`t`/`Enter`/`.`) is owned by `Timeline`/surface, not the
  card — see **06-surface-home.md**; cards expose the necessary `data-post-id`, `tabIndex`, and ref
  hooks.
- Respect `prefers-reduced-motion`: the like-pop, optimistic fade-in, and skeleton shimmer collapse
  to instant/opacity-only.

---

## 1. PostCard — the load-bearing unit

### Purpose

One post in any list context (timeline, replies, profile, search, quote embeds are a separate
component). Renders header (avatar, display name, handle, relative time, overflow menu), the
optional "Replying to @x" line, the `PostBody`, an optional `QuotedPostEmbed` **or** `PollCard`, and
the `PostCardActions` row with live counts. Carries the optimistic-pending and banned-author
renderings. Clicking anywhere on the card (outside an interactive child) navigates to `/post/[id]`.

### Route context

Rendered inside `Timeline` on `/`, `/explore`, `/u/[address]`, and inside `ThreadView` on
`/post/[id]`. The card itself is route-agnostic; the surface passes `variant`.

### ASCII anatomy — desktop

```
┌──────────────────────────────────────────────────────────────────────┐
│ ( ) ⟵Avatar  DisplayName  @hand…le · 2h                          [···] │  ← PostCardHeader
│      ↳ Replying to @abcd…wxyz                                          │  ← reply context (if reply)
│      Body text with an auto-linked https://example.org URL and        │  ← PostBody
│      up to 512 bytes of UTF-8. No media ever.                         │
│      ┌────────────────────────────────────────────────────────────┐   │
│      │  QuotedPostEmbed  (if post.quote)  — compact nested card     │   │
│      └────────────────────────────────────────────────────────────┘   │
│      ┌────────────────────────────────────────────────────────────┐   │
│      │  PollCard (if post.isPoll) — option bars + vote             │   │
│      └────────────────────────────────────────────────────────────┘   │
│                                                                        │
│   ⟲ Reply 12     ↻ Repost 4     ❝ Quote 1     ♥ 38     ↗ Share        │  ← PostCardActions
└──────────────────────────────────────────────────────────────────────┘
   ▲ hover: whole row gets --cg-bg-hover; hairline --cg-border divider below
```

### ASCII anatomy — mobile (single column, full-bleed)

```
┌─────────────────────────────────────────┐
│ (•) DisplayName @ha…le · 2h        [···] │
│     ↳ Replying to @ab…yz                 │
│     Body text, wraps. 15px base.         │
│     ┌─────────────────────────────────┐  │
│     │ QuotedPostEmbed / PollCard      │  │
│     └─────────────────────────────────┘  │
│   ⟲12   ↻4   ❝1   ♥38            ↗      │  ← actions spread; Share right-aligned
└─────────────────────────────────────────┘
```

Layout matches X exactly: avatar in a left gutter (40px desktop / 40px mobile), everything else in
the right column; header is one line with middle-dot separators; the action row is a single row of
icon+count buttons with the Share icon pushed to the trailing edge.

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `post` | `PostVM` | yes | the post (§0.4). |
| `viewer` | `Viewer` | yes | gate + viewer-relative rendering. |
| `variant` | `'timeline' \| 'detail' \| 'reply' \| 'thread'` | no (`'timeline'`) | `detail` = the focused post on `/post/[id]`: larger body (`--cg-fs-md`), full timestamp, weighted-score line; `reply` indents under a parent in a thread; `thread` connects with the vertical thread line. |
| `onOpen` | `(id: string) => void` | yes | navigate to `/post/[id]` (row click). |
| `onReply` | `(post: PostVM) => void` | yes | opens `ReplyComposer` (modal). |
| `onQuote` | `(post: PostVM) => void` | yes | opens `QuoteComposer` (modal). |
| `onLike` | `(post: PostVM, next: boolean) => void` | yes | toggle upvote; see `PostCardActions`. |
| `onDownvote` | `(post: PostVM, next: boolean) => void` | yes | secondary downvote (from overflow menu). |
| `onRepost` | `(post: PostVM) => void` | yes | permanent repost; confirm then submit. |
| `onShare` | `(post: PostVM) => void` | yes | copy `/post/[id]` link → success toast. |
| `onAuthorOpen` | `(address: string) => void` | yes | navigate to `/u/[address]`. |
| `showThreadLine` | `boolean` | no (`false`) | draw the connecting vertical line (thread context). |
| `headerExtra` | `ReactNode` | no | slot for surface-specific badges (e.g. "Pinned" on profile). |
| `data-post-id` | `string` | (set internally from `post.id`) | for surface-level `j/k` nav. |

### Variants

- `timeline` — default dense row, relative time, row-click → detail, whole row hover-highlight.
- `detail` — the conversation's focused post: avatar+name stacked over body, larger `PostBody`,
  **absolute** timestamp ("3:14 PM · Jun 21, 2026"), a **weighted score line** under the body
  (`38 Likes · score +1.2M` — show the `score` BigInt humanized; this is the one place we expose the
  weighted up/down nature, per the divergence list), and a full-width action row.
- `reply` / `thread` — used inside `ThreadView`; render the "Replying to @x" line and the vertical
  thread connector (`showThreadLine`).

### Visual states

| State | Rendering |
|---|---|
| default | normal colors; hairline `--cg-border` bottom divider. |
| hover (row) | background `--cg-bg-hover`; cursor pointer; action icons keep default tint until individually hovered. |
| focus (row) | when reached via `j/k`, a 2px `--cg-accent` left-border marker + focus ring; `aria-current` not set (it's not nav). |
| pending-optimistic | `post.pending === true`: whole card at `opacity: 0.6`, a small inline `Spinner` next to the time, action buttons disabled, no row-click nav. Reconciles to default on confirmation; on error the card is removed and a failure toast fires. |
| banned author | `post.author.banned`: body in `--cg-text-muted`, a "This account has been restricted" chip after the handle; actions remain enabled (you may still reply to/like an old post). |
| error (this post failed to load media-less detail) | only relevant in `detail`: an inline `EmptyState` "Couldn't load this post." with a Retry. |

### Tokens consumed

`--cg-bg`, `--cg-bg-hover`, `--cg-border`, `--cg-text`, `--cg-text-secondary`, `--cg-text-muted`,
`--cg-accent` (focus/links), `--cg-radius-card`, `--cg-space-2..4`, `--cg-font-ui`, `--cg-fs-sm`
(body 15px / handle/time), `--cg-fs-md` (detail body), `--cg-fw-bold` (display name),
`--cg-z-overlay` (overflow menu).

### Data bindings

Built from `PostVM` (§0.4). The surface's `FeedSource` supplies it:

- **GraphQL path** (caps: full) — `Post{ id, text, parentId, blockHeight, timestamp, isPoll,
  upWeight, downWeight, upCount, downCount, score, repostCount, author{ id, identityHash, banned,
  displayName, avatar }, parent{ id, author{ id, displayName } }, quote{ …recursive PostVM fields } }`.
  Viewer-relative `viewerVote`/`viewerReposted` come from `votes(filter:{ voterId:{equalTo:$me}})`
  and `reposts(filter:{ reposterId:{equalTo:$me}})` joins (resolved in the data layer).
- **PAPI-direct fallback** (caps: `search:false, pagination:false`) — assembled from
  `Microblog` storage + decoded `PostCreated`/`Voted`/`Reposted` events. No `timestamp` → render
  block height (`#1234`) instead of relative time; counts come from a local fold. `quote`/`poll`
  hydrate from storage reads. The `score`/weighted line is available (weights are on `Voted`).

`PostBody` receives `post.text` only; it does its own URL auto-linking.

### Accessibility

- Card root is an `<article>` with `aria-labelledby` pointing at the display-name node; the row-click
  is an inner overlay `<a href="/post/[id]">` covering the non-interactive area (X's pattern) so the
  whole card is a real link without nesting buttons inside an anchor.
- Interactive children (`[···]`, action buttons, avatar/name links, embedded poll/quote) stop
  propagation so they don't trigger the row link.
- The overflow `[···]` is a `<button aria-haspopup="menu">` opening a `role="menu"`.

---

## 2. PostCardHeader

### Purpose

The single-line identity line: `Avatar` · `DisplayName` · `Handle` · `·` · relative time · trailing
`[···]` overflow menu button. (On `detail` variant, avatar+name stack and time moves below.)

### ASCII anatomy

```
(•)  Ada Lovelace   @5CBE…oFC · 2h                                  [···]
 ▲      ▲               ▲        ▲                                    ▲
Avatar  DisplayName    Handle  relative time                    overflow menu
```

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `author` | `AuthorVM` | yes | name/handle/avatar/banned. |
| `timestamp` | `string \| null` | yes | ISO; null → show `blockHeight`. |
| `blockHeight` | `number` | yes | fallback time display. |
| `absoluteTime` | `boolean` | no | `detail` variant → "3:14 PM · Jun 21, 2026". |
| `onAuthorOpen` | `(address: string) => void` | yes | name/handle/avatar → `/u/[address]`. |
| `menuItems` | `OverflowMenuItem[]` | yes | items for `[···]` (see §2.1). |

### §2.1 Overflow menu (`[···]`) items

The overflow menu is where chain-specific secondary actions live. Canonical item set on a `PostCard`:

- **Downvote / Remove downvote** — the SECONDARY weighted vote (`vote(post_id, Down)` /
  `clear_vote(post_id)`). Down is here, not in the main row, because the primary action is the Like
  (up). Shows a filled state when `viewerVote === 'Down'`.
- **Copy link to post** — same as Share; mirrors X.
- **View on indexer / View raw** (optional, surface-config) — deep link; silent, not framed as
  "honesty".
- Not present: Mute, Block, Report, Delete (out of scope / no on-chain moderation / content
  permanent).

`OverflowMenuItem = { id: string; label: string; icon?: ReactNode; danger?: boolean; checked?: boolean; onSelect: () => void; disabled?: boolean }`.

### States

default / hover (menu button tint → `--cg-accent`) / open (menu panel at `--cg-z-overlay`, click-out
+ `Esc` close, arrow-key roving focus) / banned (chip injected after handle).

### Tokens

`--cg-text` (name), `--cg-text-secondary` (handle/time), `--cg-fw-bold`, `--cg-fs-sm`, `--cg-bg-elevated`
(menu), `--cg-border`, `--cg-radius-card`, `--cg-z-overlay`, `--cg-overlay` (scrim on mobile sheet).

### Accessibility

Time is a `<time dateTime={iso} title={absolute}>`; relative label updated client-side. Menu is a
proper `role="menu"` with `aria-orientation="vertical"`; on mobile it presents as a bottom sheet.

---

## 3. PostCardActions — the action row

### Purpose

The row of action buttons under every post: **Reply**, **Repost**, **Quote**, **Like**, **Share**.
Each shows its live count (except Share). This is where most chain writes originate, all optimistic.

> X's actual order is Reply, Repost, Like, (Views), Share — we keep Reply, Repost, **Quote**, Like,
> Share. Quote is split out as its own affordance (rather than nested under Repost) because the chain
> models Repost and Quote as **distinct** extrinsics (`repost` vs `quote_post`) and Quote needs a
> composer. Repost's overflow ("Repost"/"Quote" combo menu, X-style) is **not** used — we show both
> as first-class icons for clarity.

### ASCII anatomy

```
  ⟲ 12        ↻ 4         ❝ 1        ♥ 38              ↗
  Reply       Repost      Quote      Like         Share (trailing)
  blue→teal   green       teal       red(♥)       teal
  hover tint  on-done     opens      pop+fill     copy→toast
              filled      QuoteComp  optimistic
```

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `post` | `PostVM` | yes | counts + viewer-relative flags. |
| `viewer` | `Viewer` | yes | gating (§0.2). |
| `onReply` | `(post) => void` | yes | open `ReplyComposer`. |
| `onRepost` | `(post) => void` | yes | confirm → `repost`. |
| `onQuote` | `(post) => void` | yes | open `QuoteComposer`. |
| `onLike` | `(post, next: boolean) => void` | yes | toggle upvote. |
| `onShare` | `(post) => void` | yes | copy link. |
| `likeState` | `'idle'\|'pending'\|'ok'\|'error'\|'rate-limited'` | no | optimistic state for Like. |
| `repostState` | same union | no | optimistic state for Repost. |
| `dense` | `boolean` | no | compact (used inside `QuotedPostEmbed` headers — usually actions hidden there). |

### Per-action spec

**Reply (`⟲`)** — opens `ReplyComposer` prefilled with the parent. Count = `post` reply count
(GraphQL `replies.totalCount`; PAPI-direct: local fold). No optimistic count bump here (the reply is
a new post; the count reconciles when the reply lands). Hover tint → `--cg-accent`.

**Repost (`↻`) — PERMANENT.** First click opens a tiny confirm popover ("Repost? This is permanent
and can't be undone.") with a single **Repost** button — because there is **no un-repost**
(`repost` only; `AlreadyReposted` on dup). On confirm: optimistic `viewerReposted = true`, icon turns
**filled `--cg-repost` (green)**, count +1, submit `Microblog.repost(post_id: u64)`. The button then
shows `aria-pressed="true"` and **disabled** (you cannot toggle off). On `AlreadyReposted`/error →
rollback + toast. No "Undo" affordance ever.

**Quote (`❝`)** — opens `QuoteComposer` (a `Composer` with the quoted post embedded). Submitting
calls `Microblog.quote_post(text, quoted_id)`. Count = number of quotes referencing this post
(GraphQL: a `quotedBy` count if available, else hidden). Optimistic: the quote appears as a new post
in the viewer's timeline; this row's quote count bumps on reconcile.

**Like (`♥`) — the primary action == on-chain UP vote.** Toggle:
- not-voted → click → optimistic `viewerVote='Up'`, heart **fills `--cg-like` (red)** with a
  **pop/scale animation** (`transform: scale(1.3)` → settle; reduced-motion: instant), count
  (`upCount`) +1, submit `Microblog.vote(post_id, dir: VoteDir.Up)`.
- already Up → click → optimistic clear, heart outline, count −1, submit
  `Microblog.clear_vote(post_id)`.
- If the viewer currently has a **Down** vote and clicks Like, the optimistic transition is
  Down→Up (the chain's `vote` replaces); count adjusts both tallies.
- Weight: the displayed count is `upCount` (number of likers), not weight. The weighted `score` is
  shown only in `detail` variant and `PollCard`. If `viewer.hasVotingPower === false`, the like still
  submits (zero-weight up vote is valid and still increments `upCount`); show a subtle one-time hint
  toast "Add voting power in Settings to make your votes count" (non-blocking).

**Share (`↗`)** — copies `${origin}/post/${post.id}` to clipboard, fires a success `Toast` "Copied
link to post." Trailing-aligned. On `detail` it may also expose a "Copy link" menu item; no external
share targets (out of scope: no media, no embeds).

### Visual states (per button)

| State | Reply | Repost | Quote | Like |
|---|---|---|---|---|
| default | outline icon, secondary tint | outline | outline | outline heart |
| hover | tint `--cg-accent`, faint circular bg | tint `--cg-repost` | tint `--cg-accent` | tint `--cg-like`, faint bg |
| active (pressed) | — | filled green, disabled, `aria-pressed` | — | filled red, pop, `aria-pressed` |
| focus | focus ring | focus ring | focus ring | focus ring |
| disabled | when not-identity-bound (tooltip) | same | same | same (Like only disabled when not-connected→opens welcome) |
| pending-optimistic | — | filled green + tiny spinner overlay until `ok` | — | filled red + spinner until `ok`; count already bumped |
| error | rollback + toast; button returns to pre-click | rollback (un-fill), toast | toast | rollback (un-fill/−1), toast |
| rate-limited | — | rollback + `RateLimitNotice` toast | — | rollback + `RateLimitNotice` toast |

### Tokens

`--cg-text-secondary` (default icons), `--cg-accent`/`--cg-accent-hover` (reply/quote hover),
`--cg-repost` (repost), `--cg-like` (heart), `--cg-radius-pill` (hover circle bg), `--cg-fs-sm`
(counts), `--cg-danger` (error), `--cg-space-2`.

### Data bindings

Counts from `PostVM` (GraphQL `replies.totalCount` / `repostCount` / `upCount` / quote count;
PAPI-direct local fold). `viewerVote` / `viewerReposted` drive filled states and are
optimistically overridden. Extrinsics: `Microblog.vote`, `Microblog.clear_vote`, `Microblog.repost`,
`Microblog.quote_post`, plus opening composers for reply/quote.

### Accessibility

Each is an icon `<button>` with `aria-label` including the count ("Like, 38" / "Reply, 12"). Like &
Repost are toggles → `aria-pressed`. Counts are visually adjacent text but folded into the label so
screen readers get one coherent name. Keyboard: `l`=like, `r`=reply, `t`=repost the focused post
(surface-owned hotkeys route to these callbacks).

---

## 4. PostBody

### Purpose

Render the post text. **Text only** — auto-link bare URLs and `https://` links; **no media**
(images/video/GIF are out of scope — there is no media field on-chain). Preserve line breaks; no
markdown.

### Anatomy / behavior

- Linkify `https?://…` runs into `<a target="_blank" rel="noopener noreferrer nofollow">` styled
  `--cg-accent`. Truncate the **visible** label of long URLs to host + 1 path segment + `…` (X-style)
  but keep the full `href`.
- No `@mention` linkification (handles are non-unique truncated ss58, not addressable text) — a
  literal `@5CBE…` in body is **not** auto-linked. Document this divergence in a comment.
- `#hashtag` is **not** linkified (no Topics surface — out of scope). Render as plain text.
- Respect the 512-byte ceiling implicitly (text is already valid); just render.
- `whiteSpace: pre-wrap`, `overflow-wrap: anywhere` so long unbroken strings wrap.

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `text` | `string` | yes | raw UTF-8 body. |
| `size` | `'base' \| 'lg'` | no (`base`) | `lg` for `detail` variant. |
| `dim` | `boolean` | no | banned-author dimming. |

### States

default / dim (banned). No interactive states beyond link hover (`--cg-accent-hover`).

### Tokens

`--cg-text` / `--cg-text-muted` (dim), `--cg-accent` (links), `--cg-fs-sm` / `--cg-fs-md`,
`--cg-font-ui`.

### Accessibility

Links are real anchors; external-link `rel` set. No `dangerouslySetInnerHTML` — build the React node
tree from parsed segments (XSS-safe).

---

## 5. QuotedPostEmbed

### Purpose

The compact nested card shown inside a `PostCard` when `post.quote` is set (a `quote_post` references
`quoted_id`). Mirrors X's quoted-tweet embed: bordered rounded box, smaller avatar+name inline, body,
no action row.

### ASCII anatomy

```
┌──────────────────────────────────────────────┐
│ (•) DisplayName  @ha…le · 1d                  │
│ Quoted post body, clamped to ~3 lines …       │
│ [ if the quoted post is itself a poll → a      │
│   tiny "Poll" chip, NOT a nested PollCard ]    │
└──────────────────────────────────────────────┘
   ▲ click → /post/[quoted.id]; hover → --cg-bg-hover
```

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `quoted` | `PostVM` | yes | the quoted post. |
| `onOpen` | `(id: string) => void` | yes | nav to quoted detail. |
| `maxLines` | `number` | no (`6`) | line-clamp. |

### Variants / states

- default / hover (`--cg-bg-hover`, `--cg-border` brightens slightly).
- banned quoted author → dim body + chip.
- **missing/unresolved quote** (quoted id not yet indexed or pruned): render a muted
  "This post is unavailable." stub box (do not crash).
- A quoted **poll**: show a "Poll" chip only — do not render an interactive `PollCard` inside an
  embed (avoids nested vote affordances); tapping opens the poll's detail.
- No `PostCardActions` inside an embed.

### Tokens

`--cg-border`, `--cg-radius-card`, `--cg-bg-elevated` (subtle), `--cg-bg-hover`, `--cg-text-secondary`
(handle/time), `--cg-fs-sm`.

### Data

`PostVM` of the quoted post (GraphQL `quote{ … }` join; PAPI-direct: storage read of `quoted_id`).
Recursion is bounded — embeds do not render their own nested quote (show "Quote" chip if the quoted
post is itself a quote).

### Accessibility

Whole box is a single `<a href="/post/[id]">`; inner name link is the same target (no nested
interactive). `aria-label="Quoted post by {name}"`.

---

## 6. PollCard

### Purpose

Render an on-chain poll (a host post with `isPoll`) inside its `PostCard` (and full on `detail`):
2–4 options as weighted percentage bars, a vote control per option, the viewer's choice highlighted,
total weight/count. **No countdown / no expiry** — polls never close on-chain; show an "Open" chip,
never a timer.

### ASCII anatomy — before voting

```
┌────────────────────────────────────────────────┐
│  ○ Option A                                      │  ← clickable option rows
│  ○ Option B                                      │
│  ○ Option C                                      │
│  ─────────────────────────────────────────────  │
│  0 votes · weighted        · Open                │  ← totals + "Open" (no timer)
└────────────────────────────────────────────────┘
```

### ASCII anatomy — after voting (results shown, bars filled)

```
┌────────────────────────────────────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░ Option A            58%  ✓   │  ← ✓ = your choice; bar = weighted %
│ ▓▓▓▓▓▓░░░░░░░░░░░░ Option B            27%       │
│ ▓▓▓░░░░░░░░░░░░░░░ Option C            15%       │
│ ─────────────────────────────────────────────   │
│ 1.4M weighted · 312 votes · Open                │
└────────────────────────────────────────────────┘
```

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `poll` | `PollVM` | yes | options/weights/counts/viewerOption (§0.4). |
| `hostPostId` | `string` | yes | the poll == its host post id. |
| `viewer` | `Viewer` | yes | gating + `hasVotingPower`. |
| `onVote` | `(option: number) => void` | yes | optimistic cast → `cast_poll_vote`. |
| `voteState` | `'idle'\|'pending'\|'ok'\|'error'\|'rate-limited'` | no | optimistic state. |
| `compact` | `boolean` | no | inside timeline card (bars slightly tighter). |

### Behavior

- **Percentages are WEIGHTED**: each option's `%` = `option.weight / poll.totalWeight` (BigInt
  division → render to 0 or 1 decimal). When `totalWeight === 0`, render all bars empty and show
  "weighted —". Also surface raw `count` per option in the option's `aria-label`/tooltip so a viewer
  can distinguish "many small-weight voters" from "one whale".
- **Vote**: clicking an option (when not yet voted, or to **change** vote) optimistically sets
  `viewerOption`, recomputes bars locally (best-effort: add the viewer's voting weight to the chosen
  option, subtract from prior), and submits `Microblog.cast_poll_vote(post_id: hostPostId, option:
  u8)`. **Re-cast replaces** (chain semantics) — changing your vote is allowed; there is no
  clear-poll-vote extrinsic, so once voted the viewer can only **switch** options, not unvote (state
  this divergence; mirror it in the UI by not offering an "remove vote").
- Results (bars + %) are shown **after** the viewer has voted, OR always on `detail` (X reveals
  results after voting; for an expiry-less chain poll we reveal on `detail` regardless so the data is
  inspectable). Pre-vote in timeline: show clickable option rows without bars.
- **No expiry**: replace X's "1d left / Final results" with a static "Open" chip. Never render a
  countdown.
- Zero voting power: options still vote (zero-weight cast is valid and increments `count` not
  `weight`); show inline hint "Your vote has no weight yet — add voting power in Settings."

### Visual states

| State | Rendering |
|---|---|
| not-voted | radio-style clickable option rows, no bars. |
| voted | filled weighted bars, `%` labels, `✓` on `viewerOption`, totals line. |
| pending (just cast) | chosen option row shows a spinner; bars use the optimistic local recompute. |
| ok | reconciled to indexer weights (silent). |
| error / rate-limited | rollback `viewerOption` + bars; toast (`RateLimitNotice` for capacity). |
| not-connected | clicking an option routes to `/welcome`. |
| not-identity-bound | options disabled + "Finish setup to vote" tooltip. |

### Tokens

`--cg-accent` (filled bar `--cg-accent` at reduced opacity; `viewerOption` bar full `--cg-accent`),
`--cg-bg-elevated` (bar track), `--cg-border`, `--cg-radius-input` (option rows), `--cg-text-secondary`
(totals), `--cg-fs-sm`, `--cg-space-2`.

### Data bindings

- GraphQL: `Poll{ id, options:[PollOption{ index, label, weight, count }], votes:[PollVote{ voterId,
  option, weight }] }`. `viewerOption` from the viewer's `PollVote`. `totalWeight`/`totalCount` summed
  (or `Poll`-level aggregate if present).
- PAPI-direct: fold `PollCreated` + `PollVoted` events / read poll storage; weights from `PollVoted{
  weight }`.

Extrinsic: `Microblog.cast_poll_vote(post_id, option)`.

### Accessibility

A `role="radiogroup"` with `aria-label` = the poll question; each option `role="radio"` with
`aria-checked` reflecting `viewerOption`; the weighted `%` and `count` are in each option's
accessible name ("Option A, 58 percent, 312 votes, your choice"). Bars are decorative
(`aria-hidden`).

---

## 7. Composer (base) + ComposerModal

### Purpose

The text-entry surface for creating a post. The base `Composer` is reused by the `/compose` page, the
`ComposerModal` overlay (opened from the LeftNav "Post" button / mobile FAB), `ReplyComposer`,
`QuoteComposer`, and (with poll fields) `PollComposer`. Includes the viewer `Avatar`, a growing
textarea, the `ByteCounter` ring, optional context (reply-to / quoted embed / poll options), a
"Post" pill CTA, and `RateLimitNotice` when capacity is exhausted.

### ASCII anatomy — base composer

```
┌──────────────────────────────────────────────────────────┐
│ (•)  What's happening?                                    │  ← avatar + textarea (placeholder)
│      |                                                     │
│      [ optional: Replying to @x  /  QuotedPostEmbed  /     │
│        poll option inputs (PollComposer) ]                 │
│                                                            │
│  ┌──────── toolbar ────────┐            (◔)   [  Post  ]   │  ← ByteCounter ring + CTA pill
│  │ [▦ Poll]  (Anything else │            383   (disabled   │
│  │  X has is OUT of scope)  │            left   until valid)│
│  └─────────────────────────┘                               │
│  [ RateLimitNotice — only when capacity exhausted ]        │
└──────────────────────────────────────────────────────────┘
```

`ComposerModal` is the same `Composer` centered in a dialog over a `--cg-overlay` scrim, with a close
`✕`, opened as a route-intercepting modal from anywhere (the static-export modal pattern is in
**01-information-architecture.md**; `/compose` is also a real page for deep-links/no-JS).

### Props (Composer base)

| Prop | Type | Required | Notes |
|---|---|---|---|
| `viewer` | `Viewer` | yes | avatar/name + gating. |
| `mode` | `'post' \| 'reply' \| 'quote' \| 'poll'` | yes | drives context block + extrinsic. |
| `replyTo` | `PostVM` | when `mode='reply'` | shows "Replying to @x"; sets `parent=Some(id)`. |
| `quoted` | `PostVM` | when `mode='quote'` | renders `QuotedPostEmbed`; sets `quoted_id`. |
| `pollDraft` | `PollDraft` | when `mode='poll'` | option inputs (see `PollComposer`). |
| `placeholder` | `string` | no | defaults per mode ("What's happening?" / "Post your reply" / "Add a comment" / poll question). |
| `maxBytes` | `number` | no (`512`) | hard limit; `80` for each poll option (handled in `PollComposer`). |
| `submitState` | `'idle'\|'pending'\|'ok'\|'error'\|'rate-limited'` | yes | drives CTA + `RateLimitNotice`. |
| `onSubmit` | `(draft: ComposerDraft) => void` | yes | surface wires the extrinsic. |
| `onCancel` | `() => void` | for modal | close. |
| `autoFocus` | `boolean` | no | focus textarea on mount (modal: true). |
| `capacityHint` | `{ remaining: number; costOfThis: number } \| null` | no | optional pre-flight: if `remaining < costOfThis`, pre-disable + show inline `RateLimitNotice` before submit. |

`ComposerDraft = { mode; text: string; parentId?: bigint; quotedId?: bigint; pollOptions?: string[] }`.

### ByteCounter (sub-component, see §8)

X's circular countdown ring, but counting **UTF-8 BYTES not characters** (the chain limit is 512
bytes). Hard-block at the limit; warn near it.

### Behavior

- Textarea auto-grows; Enter inserts newline; **⌘/Ctrl+Enter submits** (X parity).
- The **Post** CTA pill is disabled when: empty (after trim) for post/quote; for reply, empty too;
  for poll, when fewer than 2 non-empty options or the question is empty; when over the byte limit;
  when `submitState==='pending'`; when `viewer.status !== 'ready'` (then the CTA label becomes
  "Finish setup" and routes to `/welcome` instead).
- Submit calls the right extrinsic via `onSubmit`:
  - `post` → `Microblog.post_message(text, parent: None)`
  - `reply` → `Microblog.post_message(text, parent: Some(replyTo.id))`
  - `quote` → `Microblog.quote_post(text, quoted_id: quoted.id)`
  - `poll` → `Microblog.create_poll(question: text, options: pollOptions)`
- **Optimistic**: on submit, the modal/page closes immediately and the new post appears at the top of
  the relevant timeline as a `pending` `PostCard`; reconciled when `PostCreated` lands; on error the
  pending card is removed and a failure `Toast` (or `RateLimitNotice`) fires AND the composer text is
  **restored** (re-open the composer with the draft so the user doesn't lose it).

### Visual states

| State | Rendering |
|---|---|
| empty/idle | placeholder, CTA disabled, ByteCounter ring empty (`--cg-text-muted`). |
| typing | ring fills with `--cg-accent`; CTA enabled when valid. |
| near limit (≤ 32 bytes left) | ring turns `--cg-danger`-ish amber, remaining-count number shown. |
| at/over limit | ring full red; further input **blocked** (truncate paste at the byte boundary, never split a multibyte char); CTA disabled. |
| pending | CTA shows inline `Spinner`, disabled; (in modal) the modal closes optimistically rather than spinning — choose ONE: **modal closes + optimistic card**; the inline `/compose` page may show a brief pending state. |
| rate-limited | `RateLimitNotice` banner inside the composer; CTA re-enabled after a short backoff; text preserved. |
| error | failure toast + text preserved + composer re-opened. |
| not-connected | CTA label "Connect wallet" → `ConnectWalletButton` flow. |
| not-identity-bound | CTA label "Finish setup" → `/welcome`; textarea read-only. |

### Tokens

`--cg-bg-elevated` (modal surface), `--cg-overlay` (scrim), `--cg-border`, `--cg-radius-card`,
`--cg-radius-pill` (CTA), `--cg-accent`/`--cg-accent-hover`/`--cg-accent-contrast` (CTA fill + label),
`--cg-text-muted` (placeholder), `--cg-danger` (over-limit), `--cg-z-overlay`, `--cg-space-3..5`.

### Data

Writes only (no read binding). Pre-flight capacity from `useCapacity` (see **04-data-layer.md**) →
`capacityHint`. Viewer avatar/name from `Viewer`.

### Accessibility

Modal is `role="dialog" aria-modal="true"` with focus trap, `Esc` to close (confirm if dirty),
labelled by a visually-hidden "Compose post". Textarea has an accessible label; the ByteCounter
remaining-count is announced via an `aria-live="polite"` only when ≤ 20 bytes remain (avoid spam).
CTA disabled state uses `aria-disabled` + a tooltip explaining why.

---

## 8. ByteCounter

### Purpose

X's circular character-count ring, re-tuned to count **UTF-8 BYTES** against the 512-byte
`MaxLength` (or 80 for poll options, 64 name / 256 bio / 128 avatar for profile fields when reused).
Hard-blocks at the limit.

### ASCII anatomy

```
   ╭───╮            ╭───╮            ╭───╮
   │ ◔ │  far       │ ◑ │  near      │ ●12 │  over (shows -N bytes, red)
   ╰───╯  --cg-      ╰───╯  amber    ╰───╯  --cg-danger
          accent ring        ring
```

Near the limit (≤ 32 bytes remaining) it shows the **remaining** number beside the ring; over the
limit it shows a negative count in `--cg-danger` and the ring is full red.

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `value` | `string` | yes | current text. |
| `maxBytes` | `number` | yes | limit (512 default). |
| `warnAt` | `number` | no (`32`) | bytes-remaining threshold to start showing the number. |
| `size` | `'sm' \| 'md'` | no | sm in reply/poll-option rows. |

It computes bytes with `new TextEncoder().encode(value).length` (NOT `value.length`). Exposes a
derived `over: boolean` and `remaining: number` to the parent via an `onMeasure?(m)` callback so the
`Composer` can gate the CTA off the same measurement.

### States

under (accent ring) / near (amber + number) / at-limit (full ring) / over (red + negative number).

### Tokens

`--cg-accent` (ring fill), `--cg-text-muted` (ring track), `--cg-danger` (over), `--cg-fs-sm`.

### Accessibility

`role="progressbar"` with `aria-valuemin/max/now` (in bytes) and `aria-label="N of 512 bytes used"`;
the over-limit state adds `aria-invalid`.

---

## 9. ReplyComposer

### Purpose

A `Composer` in `mode='reply'`. Opened by `PostCardActions` Reply, or inline at the top of a
`ThreadView`. Shows the "Replying to @x" context line above the textarea; submit sets
`parent=Some(parentId)`.

### ASCII anatomy

```
┌────────────────────────────────────────────────┐
│ Replying to @5CBE…oFC                           │
│ (•) Post your reply                             │
│      |                                          │
│                                   (◔)  [ Reply ] │
└────────────────────────────────────────────────┘
```

### Props

Same as `Composer` with `mode='reply'` fixed and `replyTo: PostVM` required. CTA label = "Reply".

### Behavior / states

Identical to `Composer`; extrinsic `Microblog.post_message(text, parent: Some(replyTo.id))`.
Optimistic: the reply appears at the top of the thread's reply list as a `pending` `PostCard` and the
parent's Reply count bumps on reconcile. On a thread page the inline variant stays open after a
successful reply (cleared textarea), matching X's "reply again" affordance.

### Tokens / data / a11y

Inherit from `Composer`. Context line "Replying to @x" uses `--cg-text-secondary`, the @handle is a
link to `/u/[address]`.

---

## 10. QuoteComposer

### Purpose

A `Composer` in `mode='quote'` with the quoted post rendered as a (non-interactive) `QuotedPostEmbed`
below the textarea. Submit calls `quote_post`.

### ASCII anatomy

```
┌────────────────────────────────────────────────┐
│ (•) Add a comment                               │
│      |                                          │
│   ┌───────────────────────────────────────────┐ │
│   │ QuotedPostEmbed (read-only, no actions)   │ │
│   └───────────────────────────────────────────┘ │
│                                   (◔)  [ Post ] │
└────────────────────────────────────────────────┘
```

### Props

`Composer` with `mode='quote'` fixed, `quoted: PostVM` required. CTA label "Post".

### Behavior

Extrinsic `Microblog.quote_post(text, quoted_id: quoted.id)`. A quote is a normal feed post that
references `quoted_id`; optimistic insert at top of the viewer's timeline; the quoted post's quote
count bumps on reconcile. Embedded `QuotedPostEmbed` is read-only (`onOpen` no-op or disabled inside
the composer). Empty comment is allowed by the chain (text can be 0 bytes), but to mirror X we still
require ≥1 non-whitespace byte before enabling the CTA — OR allow empty (decide: **require non-empty**
for a quote, rationale: a zero-comment quote is indistinguishable from a repost; nudge users to
Repost instead).

### Tokens / data / a11y

Inherit from `Composer` + `QuotedPostEmbed`.

---

## 11. PollComposer

### Purpose

A `Composer` in `mode='poll'`: the question reuses the 512-byte textarea; below it, **2–4** option
inputs (each ≤ 80 bytes), with add/remove controls. Submit calls `create_poll`. Polls have **no
expiry** field (none on-chain) — do **not** render a duration picker.

### ASCII anatomy

```
┌────────────────────────────────────────────────┐
│ (•) Ask a question…                             │
│      |                                          │
│   ┌──────────────────────────────────────────┐  │
│   │ Option 1  [____________________] (◔)80    │  ← each option has its own ByteCounter(80)
│   │ Option 2  [____________________] (◔)80    │
│   │ Option 3  [____________________] (◔)80  ✕  │  ← removable (3rd/4th)
│   │            [ + Add option ]  (max 4)       │  ← disabled at 4
│   └──────────────────────────────────────────┘  │
│   (no expiry / no "Poll length" — polls are open)│
│                                   (◔)  [ Post ] │
└────────────────────────────────────────────────┘
```

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `viewer` | `Viewer` | yes | gating. |
| `pollDraft` | `PollDraft` | yes | `{ question: string; options: string[] }`. |
| `onChange` | `(d: PollDraft) => void` | yes | controlled. |
| `submitState` | union | yes | optimistic state. |
| `onSubmit` | `(d: ComposerDraft) => void` | yes | builds `create_poll` args. |

Constraints enforced in-component: `2 ≤ options.length ≤ 4` (MaxPollOptions=4); each option ≤ 80
bytes (MaxPollOptionLen=80) via its own `ByteCounter('sm', 80)`; question ≤ 512 bytes. The two
mandatory option inputs cannot be removed (no `✕`); options 3 and 4 are removable. "+ Add option" is
disabled at 4. Empty trailing options are allowed in the UI but **must be trimmed/validated** to
≥ 2 non-empty before the CTA enables; do not submit empty option strings (decide: drop empty options
client-side, then require the result has ≥ 2).

### Behavior / states

Extrinsic: `Microblog.create_poll(question: text, options: string[])` (Vec<Vec<u8>>). Emits
`PostCreated` + `PollCreated`; optimistic insert of the new poll post (`isPoll=true`) at top of
timeline with an empty `PollCard` (0 votes, "Open"). All other states inherit `Composer`.

| State | Rendering |
|---|---|
| < 2 non-empty options | CTA disabled, hint "Add at least 2 options." |
| any option > 80 bytes | that option's ByteCounter red, CTA disabled. |
| 4 options | "+ Add option" disabled. |
| pending/ok/error/rate-limited | as `Composer`. |

### Tokens

Inherit `Composer`; option inputs use `--cg-radius-input`, `--cg-border`, `--cg-bg`.

### Accessibility

Each option input has a label "Choice {n}"; remove button `aria-label="Remove choice {n}"`; the
add button announces remaining capacity. The whole option set is a `<fieldset>` with a
visually-hidden legend "Poll choices".

---

## 12. FollowButton

### Purpose

Toggle following an account. Optimistic. Matches X exactly: shows **"Follow"** (filled accent pill)
when not following; **"Following"** (outline pill) when following; on hover while following it morphs
to **"Unfollow"** in `--cg-danger` red.

### ASCII anatomy

```
 not following:   [  Follow  ]   (filled --cg-accent, --cg-accent-contrast text)
 following:       [ Following ]   (outline; hover → [ Unfollow ] red)
 pending:         [   …       ]   (spinner, disabled)
```

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `target` | `string` | yes | ss58 of the account to follow. |
| `isFollowing` | `boolean` | yes | current edge state (optimistically overridable). |
| `viewer` | `Viewer` | yes | gating; hide/disable on own profile. |
| `state` | `'idle'\|'pending'\|'ok'\|'error'\|'rate-limited'` | no | optimistic state. |
| `onToggle` | `(target: string, next: boolean) => void` | yes | follow/unfollow. |
| `size` | `'sm' \| 'md'` | no | `sm` in `RightRail` who-to-follow / lists; `md` on `ProfileHeader`. |

### Behavior

- Not following → click → optimistic "Following", submit `Microblog.follow(target: AccountId)`.
- Following → hover shows "Unfollow" red; click → optimistic "Follow", submit
  `Microblog.unfollow(target)`. (No confirm dialog — X doesn't confirm unfollow.)
- `target` is **not** existence-checked on-chain (you can follow an account with no posts); the UI
  permits it.
- Self: when `target === viewer.address`, render **nothing** (or an "Edit profile" button if used on
  `ProfileHeader` — the surface decides; the button itself returns null on self).
- not-connected → routes to `/welcome`. not-identity-bound → disabled + tooltip.

### Visual states

| State | Rendering |
|---|---|
| follow (default) | filled `--cg-accent` pill, `--cg-accent-contrast` text. |
| follow hover | `--cg-accent-hover`. |
| following (default) | transparent bg, `--cg-border` outline, `--cg-text` label "Following". |
| following hover | red: `--cg-danger` border + text, label "Unfollow", faint red bg. |
| pending | spinner, disabled, keeps optimistic label. |
| focus | focus ring. |
| disabled (not-bound) | reduced opacity + tooltip. |
| error/rate-limited | rollback label, toast. |

### Tokens

`--cg-accent`, `--cg-accent-hover`, `--cg-accent-contrast`, `--cg-border`, `--cg-text`, `--cg-danger`,
`--cg-radius-pill`, `--cg-fw-bold`, `--cg-fs-sm`.

### Data

Edge state from GraphQL `Follow{ id "<me>-<target>" }` existence (or the viewer's `outgoingFollows`);
PAPI-direct: fold `Followed`/`Unfollowed`. Extrinsics `Microblog.follow` / `Microblog.unfollow`.

### Accessibility

`<button aria-pressed={isFollowing}>` with `aria-label` "Follow @handle" / "Following @handle, click
to unfollow". The hover label swap is visual only; the accessible name stays stable per state.

---

## 13. Avatar

### Purpose

Circular avatar. Uses `Profile.avatar` URL if present; otherwise a **deterministic identicon/blockie
derived from the ss58 address** (so every account has a stable visual even with no profile). No
upload (out of scope).

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `address` | `string` | yes | ss58; identicon seed. |
| `src` | `string \| null` | no | `Profile.avatar` URL; null → identicon. |
| `size` | `number \| 'sm'\|'md'\|'lg'\|'xl'` | no | px or token sizes (sm 32 / md 40 / lg 48 / xl 80 for `ProfileHeader`). |
| `dim` | `boolean` | no | banned-author dimming. |
| `onClick` | `() => void` | no | nav to `/u/[address]`. |

### Behavior

- Identicon is generated client-side deterministically from `address` (a blockies-style or
  jdenticon hash → SVG/canvas). Must be pure + stable (no network). Same seed → same image always.
- `src` images: render in an `<img>` with `loading="lazy"`, `referrerPolicy="no-referrer"`, and an
  **onError fallback to the identicon** (broken/abuse URL must not break layout). Avatar URLs are
  arbitrary user input — never inject as CSS `url()` without sanitization; prefer `<img>` so the
  browser sandboxes it. Document this as a safety note.

### States

default / hover (subtle ring `--cg-border`) / dim (banned) / loading (skeleton circle) / broken-src
(→ identicon).

### Tokens

`--cg-bg-elevated` (skeleton), `--cg-border` (ring), `--cg-radius-pill` (fully round).

### Accessibility

`alt` = "{displayName or @handle} avatar"; when used as a link, the wrapping `<a>` carries the label
and the `<img alt="">` is decorative.

---

## 14. DisplayName

### Purpose

Render an account's display name. Uses `Profile.display_name`; **falls back to the truncated ss58
address** when no profile is set (names are non-unique; this is fine). Bold, `--cg-text`.

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `author` | `AuthorVM` | yes | name + address + banned. |
| `as` | `'span' \| 'a'` | no | `a` → link to `/u/[address]`. |
| `truncate` | `boolean` | no (`true`) | ellipsis at container width. |

### Behavior

`label = author.displayName?.trim() || truncateSs58(author.address)`. Banned authors keep their name
but get the "This account has been restricted" chip rendered by the **parent** header (not here). Sanitize:
display names are user input — render as text (no HTML).

### Tokens

`--cg-text`, `--cg-fw-bold`, `--cg-fs-sm`.

### Accessibility

When `as='a'`, real anchor to the profile; `title` shows the full ss58 for disambiguation.

---

## 15. Handle

### Purpose

The "@handle" — a **truncated ss58 address in monospace**. There are no unique usernames on-chain, so
the handle is the account address abbreviated (`@5CBE…oFC`). Secondary tint.

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `address` | `string` | yes | ss58 (prefix 42). |
| `truncate` | `'middle' \| 'none'` | no (`'middle'`) | middle-ellipsis (`5CBE…oFC`). |
| `as` | `'span' \| 'a'` | no | `a` → `/u/[address]`. |
| `copyable` | `boolean` | no | click-to-copy full address → toast. |

### Behavior

`@` prefix + `truncateSs58(address, { head: 4, tail: 4 })`. Monospace (`--cg-font-mono`). `copyable`
adds a copy affordance (used on `ProfileHeader`). Full address in `title`.

### Tokens

`--cg-text-secondary`, `--cg-font-mono`, `--cg-fs-sm`.

### Accessibility

`title`/`aria-label` carry the full address. Copy action raises a `Toast`.

---

## 16. Toaster / Toast

### Purpose

The global notification surface for the two chain realities we surface (tx pending/success/error and
rate-limit) plus incidental confirmations (link copied). Bottom-center on mobile, bottom-left or
bottom-center on desktop (match X's snackbar placement: bottom-center, accent-tinted for success).

### ASCII anatomy

```
                ┌──────────────────────────────────────────┐
                │ ✓  Your post was sent.                    │  success (accent)
                └──────────────────────────────────────────┘
                ┌──────────────────────────────────────────┐
                │ ⟳  Posting…                               │  pending (optional; usually silent)
                └──────────────────────────────────────────┘
                ┌──────────────────────────────────────────┐
                │ ⚠  Something went wrong. Try again.   ⤺   │  error (with Retry)
                └──────────────────────────────────────────┘
                ┌──────────────────────────────────────────┐
                │ ⏳ You're over the rate limit. Try again   │  rate-limit (distinct copy)
                │    shortly.                               │
                └──────────────────────────────────────────┘
```

### Components

- **Toaster** — the singleton container (`aria-live="polite"`, `aria-atomic="false"`), mounted once
  in `AppShell`. Stacks up to N (e.g. 3) toasts, newest on top; auto-dismiss after a timeout
  (success ~3s, error ~6s, rate-limit ~5s; pending persists until resolved or replaced).
- **Toast** — one notification.

### Toast props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `id` | `string` | yes | dedupe + dismiss key. |
| `kind` | `'success' \| 'pending' \| 'error' \| 'rate-limit' \| 'info'` | yes | drives color/icon/copy. |
| `message` | `string` | yes | already-localized copy. |
| `action` | `{ label: string; onClick: () => void }` | no | e.g. "Retry", "View". |
| `duration` | `number \| null` | no | ms; `null` = sticky (pending). |
| `onDismiss` | `(id) => void` | yes | manual close. |

### Behavior

- The optimistic-mutation layer raises toasts: **error** on dispatch failure, **rate-limit** on
  CheckCapacity pool rejection (distinct copy — never the generic error), **success** sparingly
  (X mostly stays silent on success because the optimistic UI already shows the result; we follow
  that — emit success only for non-visible outcomes like "Copied link", "Profile saved"). Pending
  toasts are generally **suppressed** in favor of the optimistic card; expose them only for
  fee-bearing/long ops (profile save, vault lock).
- Rate-limit copy: **"You're over the rate limit. Try again shortly."** (no battery, no
  capacity numbers, no "talk-capacity" jargon — per the locked decisions). May include a soft
  countdown if the next-regen estimate is cheaply known, otherwise just the generic line.
- Dedupe by `id` so a burst of failures doesn't stack identical toasts.

### Visual states / variants

| kind | accent | icon |
|---|---|---|
| success | `--cg-accent` | ✓ |
| pending | `--cg-text-secondary` | spinner |
| error | `--cg-danger` | ⚠ |
| rate-limit | amber (`--cg-warning`) | ⏳ |
| info | `--cg-bg-elevated` neutral | ℹ |

### Tokens

`--cg-bg-elevated`, `--cg-border`, `--cg-text`, `--cg-accent`, `--cg-danger`, `--cg-radius-card`,
`--cg-z-overlay` (above content, below modals or above — define stacking in 02), `--cg-space-3`.

### Accessibility

Container `aria-live="polite"` (errors may use `assertive` via a second `role="alert"` region).
Action button is a real `<button>`. Auto-dismiss pauses on hover/focus. Respect reduced-motion (fade
not slide).

---

## 17. RateLimitNotice

### Purpose

The dedicated, graceful surfacing of exhausted talk-capacity — the **one** capacity reality we show.
Appears inline (inside the `Composer`, or as a `Toast` of kind `rate-limit`). Twitter-style copy, no
battery, no jargon. This is raised when a feeless extrinsic is rejected at the pool by the
`CheckCapacity` tx extension, or pre-emptively when `capacityHint.remaining < costOfThis`.

### ASCII anatomy (inline, in composer)

```
┌──────────────────────────────────────────────────────────┐
│ ⏳ You're over the rate limit. You can post again shortly. │
└──────────────────────────────────────────────────────────┘
```

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `variant` | `'inline' \| 'toast'` | yes | inline (composer) vs toast. |
| `retryInSeconds` | `number \| null` | no | optional soft countdown if cheaply known. |
| `onRetry` | `() => void` | no | re-attempt the action. |

### Behavior

- Copy is generic and reassuring: "You're over the rate limit. Try again shortly." If
  `retryInSeconds` is known (capacity regen estimate from `useCapacity`), append "You can post again
  in ~Ns." — but never expose units/numbers of "capacity".
- Inline variant sits inside the `Composer` below the CTA and keeps the user's text intact; the CTA
  re-enables when capacity is estimated to have recovered (or after a short fixed backoff).
- Toast variant is just `Toast kind='rate-limit'` (§16) raised by the mutation layer for non-composer
  actions (like/repost/vote/poll/follow). The **same component/copy** backs both so the message is
  consistent everywhere.

### States

shown / counting-down (if `retryInSeconds`) / dismissed.

### Tokens

`--cg-bg-elevated`, `--cg-border`, `--cg-text-secondary`, the rate-limit accent (`--cg-warning`),
`--cg-radius-input`, `--cg-fs-sm`.

### Accessibility

`role="status"` (polite) so it's announced without stealing focus. The countdown is not a focus trap.

---

## 18. EmptyState

### Purpose

The friendly placeholder when a list/section has no data (empty timeline, no replies, no search
results, profile with no posts, no follows). Matches X's centered illustration+headline+subtext
pattern (we use a simple icon + headline + optional CTA, no marketing illustration).

### ASCII anatomy

```
            ╭───╮
            │ ✦ │            ← optional icon
            ╰───╯
        Nothing here yet
   When you follow people, their
   posts will show up here.        ← subtext
        [  Explore  ]              ← optional CTA
```

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `title` | `string` | yes | headline. |
| `description` | `string` | no | subtext. |
| `icon` | `ReactNode` | no | small glyph. |
| `action` | `{ label; onClick }` | no | CTA pill. |
| `variant` | `'feed' \| 'search' \| 'profile' \| 'replies' \| 'follows' \| 'generic'` | no | preset copy/icon. |

### Preset copy (canonical strings)

- `feed` (For You/Following empty) — "Welcome to cogno-chain" / "This is the best place to see what's
  happening. Find some people to follow." + `[Explore]`.
- `search` — "No results for \"{q}\"" / "Try different keywords." (search requires the indexer; if
  `caps.search === false`, show the `not-available` variant instead — see below).
- `profile` — "@{handle} hasn't posted yet."
- `replies` — "No replies yet" / "Be the first to reply."
- `follows` — "Not following anyone yet."
- `search-unavailable` (when on PAPI-direct, `caps.search===false`) — "Search needs the indexer." /
  "Connect an indexer endpoint in Settings to search." + `[Open settings]`. This is the honest cap
  message, framed as a feature dependency, NOT an honesty disclaimer.

### Tokens

`--cg-text-secondary` (subtext), `--cg-text` (title), `--cg-accent` (CTA), `--cg-radius-pill`,
`--cg-space-4..6`.

### Accessibility

`role="status"` region; CTA is a real button/link.

---

## 19. Spinner / Skeleton

### Purpose

Loading affordances. **Skeleton** = shimmering placeholder rows matching the shape of the content
that's loading (timeline post rows, profile header) — X uses skeletons heavily. **Spinner** = small
inline indeterminate spinner for button-pending and tail-of-list "loading more".

### ASCII anatomy — skeleton post row

```
┌──────────────────────────────────────────┐
│ ▓▓▓  ▓▓▓▓▓▓▓▓  ▓▓▓▓                        │  ← avatar + name + handle blocks
│      ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓           │  ← body lines
│      ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                        │
│      ▓▓   ▓▓   ▓▓   ▓▓                      │  ← action row blocks
└──────────────────────────────────────────┘
```

### Skeleton props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `variant` | `'post' \| 'profileHeader' \| 'pollCard' \| 'line' \| 'avatar' \| 'thread' \| 'person'` | yes | shape preset. |
| `count` | `number` | no (`1`) | repeat (e.g. 8 post rows for an initial timeline). |
| `width` | `string` | no | for `line`/`avatar`. |

### Spinner props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `size` | `'sm' \| 'md'` | no | sm in buttons, md in list-tail. |
| `label` | `string` | no | sr-only ("Loading"). |

### Behavior / states

- Skeleton shimmer is a subtle gradient sweep (base `--cg-bg-subtle` → highlight `--cg-bg-hover-solid`);
  under `prefers-reduced-motion` it's a static block (no sweep).
- Used for: initial timeline load (8× `post`), thread load, profile header, poll load, "loading more"
  at the bottom of an infinite scroll (`Spinner md`), and button-pending (`Spinner sm` inside CTAs).
- Skeletons must match the **real** row height to avoid layout shift on hydrate.

### Tokens

`--cg-bg-elevated`, `--cg-bg-hover`, `--cg-radius-card`, `--cg-radius-pill` (avatar skeleton),
`--cg-accent` (spinner).

### Accessibility

Skeleton container `aria-busy="true"` + `aria-hidden` on the shimmer blocks; an sr-only "Loading"
label. Spinner has `role="status"` + sr-only label. Do not announce per-row.

---

## 20. ConnectWalletButton

### Purpose

The entry to the Cardano wallet → derive posting key → bind identity flow. Appears in `LeftNav`
(when not connected), in the empty-states, and as the gate fallback for any write attempted while
`not-connected`. Routes to / drives `/welcome`.

### ASCII anatomy

```
not connected:   [  ⬡ Connect wallet  ]   (filled accent pill)
connecting:      [  …  Connecting       ]   (spinner)
connected,       [  ⬡ Finish setup     ]   (accent; routes to /welcome bind step)
 not bound:
connected+bound: (replaced by the account chip / Avatar in LeftNav — button not shown)
```

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `viewer` | `Viewer` | yes | drives label/target. |
| `state` | `'idle'\|'connecting'\|'binding'\|'error'` | no | flow progress. |
| `onConnect` | `() => void` | yes | open CIP-30 wallet picker (MeshJS). |
| `onContinueSetup` | `() => void` | yes | route to `/welcome` bind step. |
| `size` | `'sm'\|'md'` | no | nav vs inline. |

### Behavior

- not-connected → "Connect wallet" → MeshJS CIP-30 picker → derive sr25519 posting key from the
  CIP-8 signature (via `useSigner`; key never stored).
- connected but not-identity-bound → "Finish setup" → `/welcome` to submit
  `CognoGate.link_identity_signed` (FEELESS unsigned bare tx). Optional stake bind
  (`link_stake_signed`) is a secondary step on `/welcome`.
- The actual bind extrinsic building lives in `/welcome` (see **11-surface-onboarding-auth.md**); this button
  only initiates/continues.
- error → inline error + Retry; never blocks the rest of the app (reading works unauthenticated).

### States

idle / connecting (spinner, disabled) / binding (spinner) / error (red text + retry) / hidden (when
fully ready, the LeftNav shows the account chip instead).

### Tokens

`--cg-accent`, `--cg-accent-contrast`, `--cg-accent-hover`, `--cg-radius-pill`, `--cg-danger`,
`--cg-fw-bold`.

### Accessibility

Real `<button>`; the wallet picker is a modal `role="dialog"`. Announce connection result via a
`Toast`.

---

## 21. SearchBar

### Purpose

The global search input (in `RightRail` on desktop, and the `/explore` header on mobile). Substring
search over post bodies — **indexer-only** (gated on `caps.search`). Submitting navigates to
`/explore?q=…` (or runs the query inline on explore).

### ASCII anatomy

```
┌────────────────────────────────────┐
│ 🔍  Search cogno-chain         (✕)  │  ← icon, input, clear-when-text
└────────────────────────────────────┘
```

### Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `value` | `string` | yes | controlled. |
| `onChange` | `(v: string) => void` | yes | |
| `onSubmit` | `(v: string) => void` | yes | nav to `/explore?q=` or run query. |
| `searchEnabled` | `boolean` | yes | = `feedSource.caps.search`. |
| `placeholder` | `string` | no | "Search cogno-chain". |
| `autoFocus` | `boolean` | no | on `/explore`. |

### Behavior

- Debounced live results on `/explore`; Enter commits and updates the URL `?q=`.
- The GraphQL filter is `text: { includesInsensitive: $q }` (the canonical substring filter — see
  data layer); maps onto `FEED`'s `filter` arg.
- When `searchEnabled === false` (PAPI-direct, no indexer): the input is **disabled** with
  placeholder "Search needs the indexer" and clicking shows the `search-unavailable` `EmptyState`/a
  one-line hint linking Settings. No fake client-side search over the partial PAPI feed.
- Clear (`✕`) resets and (on explore) returns to the default explore list.

### States

empty / typing (clear button appears) / disabled (no indexer) / focus (accent ring) / loading
(spinner in the field while a query is in flight).

### Tokens

`--cg-bg-elevated` (field), `--cg-border`, `--cg-text`, `--cg-text-muted` (placeholder), `--cg-accent`
(focus), `--cg-radius-pill`, `--cg-fs-sm`.

### Accessibility

`role="search"` wrapper; `<input type="search">` with a label "Search cogno-chain"; clear button
`aria-label="Clear search"`. Disabled state sets `aria-disabled` + a `title` explaining the indexer
dependency.

---

## 22. Supporting / referenced components (specified here for completeness)

These appear in the canonical list and are composed by surfaces; the heavy ones (`AppShell`,
`LeftNav`, `BottomTabBar`, `RightRail`, `Timeline`, `TimelineTabs`, `ProfileHeader`, `ProfileTabs`,
`ThreadView`, `ExploreList`, `ThemeToggle`, `EditProfileModal`) are **owned by surface docs**
(01/06-12/etc.) but their reusable props are pinned here so this kit is the single source of prop
names.

> `NewPostsPill` (06-surface-home.md), `FirehoseOrderToggle` + `PersonResult`
> (10-surface-explore-search.md), and `ProgressDots` + `WalletPicker` (11-surface-onboarding-auth.md)
> are **surface-OWNED** components — they are NOT registered in this shared kit.

### 22.1 Timeline + TimelineTabs

- **Timeline** — a virtualized/windowed list of `PostCard`s. Props: `posts: PostVM[]`,
  `viewer: Viewer`, `loading: boolean`, `hasMore: boolean`, `onLoadMore(): void` (cursor pagination,
  gated on `caps.pagination`; PAPI-direct shows the first window only + a quiet "Connect an indexer
  to load more" footer), the per-post action callbacks (forwarded to `PostCard`), and the
  keyboard-nav owner (`j/k/n/l/r/t/Enter/.`). Empty → `EmptyState variant='feed'`. Loading →
  `Skeleton variant='post' count={8}`. Tail → `Spinner`.
- **TimelineTabs** — the "For you / Following" tab strip (sticky under the header). Props:
  `active: 'for-you' | 'following'`, `onChange`. "For you" = global newest-first feed (no algo —
  reverse-chron; note the divergence: there is no ranking model, "For you" is just the global feed).
  "Following" = posts from accounts the viewer follows (GraphQL filter on `authorId in
  viewer.following`; PAPI-direct: client-side filter of the window). When not-connected, "Following"
  shows an `EmptyState` prompting connect.

### 22.2 RightRail

The desktop right column: `SearchBar` (sticky top) + a "Who to follow" card (a few `Avatar` +
`DisplayName`/`Handle` + `FollowButton size='sm'` rows). Props: `viewer`, `suggestions:
AuthorVM[]` (a cheap heuristic — most-followed or most-recent authors from the indexer; PAPI-direct:
recently-seen authors). Hidden below the tablet breakpoint. Suggestions are best-effort; if none,
omit the card (no empty state needed in the rail).

### 22.3 ProfileHeader + ProfileTabs

- **ProfileHeader** — `xl` `Avatar`, `DisplayName`, `Handle` (copyable), bio (`PostBody`-style
  linkified, 256B), follower/following counts (link to lists — but Lists surface is OUT of scope, so
  these are just counts/inline lists on the profile), and either `FollowButton` (others) or an
  "Edit profile" button opening `EditProfileModal` (self). Props: `author: AuthorVM & { bio; followerCount; followingCount; postCount; pinnedPostId }`, `viewer`, `onEditProfile`, `onToggleFollow`.
- **ProfileTabs** — **Posts / Replies / Likes** (NO **Media** tab — there is no media on-chain;
  document the omission). Props: `active: 'posts'|'replies'|'likes'`, `onChange`. "Likes" = posts the
  viewer up-voted (the chain's up-vote == Like); GraphQL via the author's `votes(dir:Up)` → posts.

### 22.4 EditProfileModal

Fee-bearing profile edit. Fields: `display_name` (≤ 64B, `ByteCounter` 64), `bio` (≤ 256B,
`ByteCounter` 256), `avatar` (≤ 128B URL/IPFS CID — a **reference string, not image bytes**;
validate it's a URL/CID, show a small live `Avatar` preview). A "Pinned post" control
(`pin_post(id)` / `unpin_post()`). Submit calls `Profile.set_profile(display_name, bio, avatar)`
(FEE-BEARING — surface a real "this costs a small fee" only as a quiet hint, NOT an honesty frame).
Props: `viewer`, `initial: { displayName; bio; avatar; pinnedPostId }`, `onSave`, `onClear`
(`clear_profile`), `onPin`, `onUnpin`, `state`. Because these are fee-bearing + signed (not
optimistic-feeless), show a pending `Spinner` on Save and a success `Toast` "Profile saved." Pinned
id is **not** validated on-chain — accept any u64, warn softly if it isn't one of the viewer's posts.

### 22.5 ThreadView

Owned by **08-surface-thread.md**; composes a `detail`-variant `PostCard` for the root + an inline
`ReplyComposer` + a list of reply `PostCard`s with `showThreadLine`. Props pinned: `root: PostVM`,
`replies: PostVM[]`, `viewer`, action callbacks, `loading`. Uses the `thread(rootId)` `FeedSource`
method (both readers support it — `caps.threads === true` for both).

### 22.6 ThemeToggle

Switches `[data-theme="dark"]` ↔ `[data-theme="light"]` (default dark). Persists to `localStorage`
(`cg-theme`), respects `prefers-color-scheme` on first load only. Props: `theme: 'dark'|'light'`,
`onToggle`. Lives in `/settings` and (optionally) the `LeftNav` footer. An optional "dim" third theme
is explicitly **not** required (mention only). See 02 for the token values per theme.

### 22.7 AppShell / LeftNav / BottomTabBar

Layout scaffolding owned by **01-information-architecture.md**; pinned here only so cards/composer
know their host:

- **AppShell** mounts the `Toaster`, the `ComposerModal` route-intercept slot, the theme attribute,
  and the 3-column → collapsed-rail → bottom-tab responsive grid.
- **LeftNav** (desktop left rail) — logo wordmark (cogno-chain, accent), nav items (Home, Explore,
  Profile, Settings), the big **Post** CTA (opens `ComposerModal`), and the account chip / `ConnectWalletButton`.
- **BottomTabBar** (mobile) — Home / Explore / (compose FAB) / Profile / Settings; the compose **FAB**
  is the floating accent circle opening `ComposerModal`.

---

## 23. Divergences honored (summary)

| Twitter/X | cogno-chain UX in this kit | Rationale |
|---|---|---|
| 280 chars, char ring | **512 BYTES**, `ByteCounter` measures UTF-8 bytes, hard block | on-chain `MaxLength=512` bytes |
| Like = simple heart | **Like = on-chain weighted UP vote**; heart fills + pop; count = upCount | chain has weighted up/down |
| (no downvote) | **Downvote** = secondary, in the `[···]` overflow; weighted | chain supports it; keep it subtle |
| Retweet (un-retweetable) | **Repost is PERMANENT** — confirm popover, filled green, no undo | `repost` only; `AlreadyReposted` |
| Quote nested under Repost | **Quote = its own action**, opens `QuoteComposer` → `quote_post` | distinct extrinsic |
| Poll has a countdown / closes | **No expiry** — "Open" chip, no timer; results inspectable on detail; can switch but not unvote | no on-chain poll expiry / no clear-poll-vote |
| @username links, media, GIFs | **@handle = truncated ss58 (mono, not linkified)**; **no media** anywhere; URLs auto-link | non-unique addresses; no media field |
| Algorithmic "For you" | **"For you" = global reverse-chron**; "Following" = followed authors | no ranking model |
| Server-driven, instant | **Static export SPA**; optimistic UI + indexer/PAPI reconcile; rate-limit instead of fee error | feeless capacity-metered chain |
| Honesty/trust labels (this app, historically) | **DROPPED entirely** — pure Twitter mimicry, only rate-limit + failure toast surface chain reality | locked design decision |

---

## 24. NOTIFICATIONS HOOK (deferred — leave clean seam)

Notifications are **deferred** (no surface authored). The indexer already emits everything a future
notifications surface needs; leave this clean hook for the follow-up:

- A future `NotificationItem` component + `/notifications` surface would fold these indexer events
  **targeting the viewer**: `Voted{ id, who }` where the post's author == viewer (a like/downvote on
  your post), `Reposted{ id, who }` (repost of your post), `Followed{ followee == viewer }` (new
  follower), reply `PostCreated` where `parent.author == viewer`, and quote `quote_post` where the
  quoted post's author == viewer.
- The data shapes already exist (`Vote`, `Repost`, `Follow`, `Post.parent`, `Post.quote`); a
  notifications reader would filter by the viewer's `address`/`identityHash`. No new component is
  built now; surfaces should not invent a bell badge yet beyond a placeholder nav slot if convenient.

---

## 25. Implementation checklist

Foundational tokens/IA come first; build the kit bottom-up (leaf components before composites).

- [ ] Confirm tokens exist in **02-design-system.md** (`--cg-*`); add any missing
      (`--cg-like`, `--cg-repost`, `--cg-warning` if used for rate-limit, `--cg-overlay`).
- [ ] Implement `Avatar` (identicon generator: pure, deterministic from ss58; `<img>` fallback with
      onError→identicon; `referrerPolicy="no-referrer"`; sanitized src).
- [ ] Implement `DisplayName` (name || truncated ss58; sanitized text; optional link).
- [ ] Implement `Handle` (mono middle-truncated ss58; `title` full; optional copy).
- [ ] Implement `Spinner` and `Skeleton` (variants: post / profileHeader / pollCard / line / avatar /
      thread / person; reduced-motion static).
- [ ] Implement `ByteCounter` (TextEncoder byte count; ring; near/over states; `onMeasure`).
- [ ] Implement `Toaster` + `Toast` (singleton in `AppShell`; kinds success/pending/error/rate-limit/
      info; dedupe; auto-dismiss; reduced-motion).
- [ ] Implement `RateLimitNotice` (inline + toast variants; generic copy; optional soft countdown;
      `role="status"`).
- [ ] Implement `EmptyState` (variant presets incl. `search-unavailable`).
- [ ] Implement `PostBody` (URL auto-link only; no media; no @mention/#hashtag links; XSS-safe node
      tree; dim variant).
- [ ] Implement `QuotedPostEmbed` (read-only nested card; missing-quote stub; poll→chip; recursion
      bound).
- [ ] Implement `PollCard` (weighted % bars; vote/cast_poll_vote; switch-not-unvote; "Open" chip;
      zero-weight hint; radiogroup a11y).
- [ ] Implement `FollowButton` (Follow/Following/Unfollow-on-hover red; optimistic; self→null;
      `aria-pressed`).
- [ ] Implement `PostCardHeader` (avatar/name/handle/time/overflow menu; downvote + copy-link items;
      banned chip).
- [ ] Implement `PostCardActions` (Reply/Repost(confirm,permanent,green)/Quote/Like(pop,red)/Share;
      per-action optimistic state; counts; a11y labels with counts).
- [ ] Implement `PostCard` (header + reply-context + body + quote/poll + actions; variants
      timeline/detail/reply/thread; pending dim; banned dim; row-link overlay; `data-post-id`).
- [ ] Implement `Composer` base (textarea autogrow; ByteCounter; CTA gating; ⌘/Ctrl+Enter; optimistic
      close+insert; text-preserve on error/rate-limit; capacity pre-flight).
- [ ] Implement `ComposerModal` (route-intercept dialog; focus trap; Esc-with-dirty-confirm; scrim).
- [ ] Implement `ReplyComposer` (mode=reply; "Replying to @x"; parent=Some(id); stays open on
      thread).
- [ ] Implement `QuoteComposer` (mode=quote; embedded read-only `QuotedPostEmbed`; require non-empty;
      quote_post).
- [ ] Implement `PollComposer` (2–4 option inputs ≤80B each; add/remove; drop-empty validation;
      create_poll).
- [ ] Implement `ConnectWalletButton` (connect/finish-setup/binding/error; routes to `/welcome`).
- [ ] Implement `SearchBar` (indexer-gated on `caps.search`; disabled-with-hint when PAPI-direct;
      `includesInsensitive` filter; `?q=` nav).
- [ ] Wire every write callback to the shared optimistic-mutation layer (**04-data-layer.md**):
      idle→pending→ok/error/rate-limited, with rollback + Toast/RateLimitNotice.
- [ ] Map CheckCapacity pool rejections to `RateLimitNotice`, all other dispatch errors to error
      `Toast` (distinct copy).
- [ ] Verify every component renders correctly in BOTH `[data-theme="dark"]` and `[data-theme="light"]`.
- [ ] Verify keyboard a11y end-to-end (focus rings, `aria-pressed` toggles, menu roving focus, dialog
      focus trap, live regions) and `prefers-reduced-motion`.
- [ ] Purge every `deleted` field reference from queries/components (schema field removed; nothing is
      ever deleted — only authors are `banned`).
- [ ] Leave the notifications hook (§24) — do NOT build a bell surface; ensure indexer event shapes
      remain accessible for the follow-up.
```
