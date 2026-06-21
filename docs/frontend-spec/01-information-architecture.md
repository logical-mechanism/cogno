# 01 — Information Architecture & Routing

This doc is the **routing and navigation contract** that every other surface in the cogno-chain
frontend spec depends on. It owns the full route map, the three-breakpoint X-style navigation shell
(desktop 3-column / tablet collapsed-icon rail / mobile top bar + bottom tab bar + compose FAB), the
`LeftNav` / `BottomTabBar` / `RightRail` item sets, the sticky-header pattern per surface, modal-route
behavior, and — the single most load-bearing decision in this file — **how a Next 14
`output: 'export'` static SPA serves dynamic deep links (`/post/[id]`, `/u/[address]`) for ids that did
not exist at build time, including the exact nginx `location` block.** We clone X/Twitter's IA and
chrome faithfully; we surface no honesty/trust marginalia (see the LOCKED DESIGN DECISIONS). Tokens,
PostCard internals, and per-surface data wiring belong to sibling docs; this doc pins *where things
live and how you get to them*.

---

## 0. Ground truth (verified against the repo)

The frontend is `app/`, a **Next.js 14 App Router** project configured for **static export**. Verified
in `app/next.config.js`:

```js
const nextConfig = {
  output: "export",          // → app/out/, no server, no SSR, no API routes
  reactStrictMode: true,
  images: { unoptimized: true },
  trailingSlash: true,       // every route is a DIRECTORY with index.html  (/post/ → /post/index.html)
};
```

Deploy is `npm run build && sudo rsync -a --delete out/ /var/www/cogno/` → nginx static webroot.
There is **no server**. Anything requiring a server (SSR `getServerSideProps`, API routes, Next
Image optimization, middleware) is **forbidden**. The data layer is the **`FeedSource` seam**
(`app/src/lib/feed/source.ts`): an interface with `kind: 'papi' | 'graphql'`, a `caps: FeedCaps`
(`{ search, pagination, threads, revocation }`), and `watch() / page() / thread() / profile()`.
`makeFeedSource(api, graphqlUrl)` returns the GraphQL reader (full caps) when an indexer URL is
configured, else the PAPI-direct reader (no `search`, no `pagination`). **Routing decisions in this
doc must never assume a server and must degrade gracefully to the PAPI-direct reader.**

> The repo today ships a single `src/app/page.tsx` (the whole app is one page). This spec **replaces
> that** with the multi-route App Router tree below. The `trailingSlash: true` and `images.unoptimized`
> settings stay; do not touch them.

---

## 1. Route map

All routes are **canonical** (from the shared vocabulary) and must work as a **static SPA on nginx**.
Each route below lists: the path, the page component it mounts, what it renders, which sibling doc
fully specifies the surface, and its data dependency (which `FeedSource` method / which caps gate it).

| Route | Mounts | Renders | Spec doc | Data dependency |
|---|---|---|---|---|
| `/` | `HomePage` | Home timeline with `TimelineTabs` = **For you / Following**. Default landing. | `06-surface-home.md` | `source.watch()` (For you); Following filtered by `outgoingFollows` graph. PAPI-direct OK (no search needed). |
| `/explore` | `ExplorePage` | `SearchBar` (global) + `ExploreList` (recent/active posts, who-to-follow). Search results render here. | `10-surface-explore-search.md` | `source.page({ search })` — **requires `caps.search`** (GraphQL). Without indexer: show recent posts only + a "search needs the indexer" inline note in Settings, never a trust badge. |
| `/post/[id]` | `PostDetailPage` | Single post + full `ThreadView` (ancestors + conversation), weighted score, replies. **Dynamic, client-resolved.** | `08-surface-thread.md` | `source.thread(BigInt(id))`. PAPI-direct OK (`caps.threads` true on both). |
| `/u/[address]` | `ProfilePage` | `ProfileHeader` + `ProfileTabs` (**Posts / Replies / Likes** — NO Media tab). ss58 address is the stable id. **Dynamic, client-resolved.** | `07-surface-profile.md` | `source.profile({ author })`. PAPI-direct OK. |
| `/compose` | `ComposePage` | Full-page `Composer`. Also the **fallback target** for the compose/quote/reply modal overlays. | `09-surface-compose.md` | Writes only: `Microblog.post_message` / `quote_post` / `create_poll`. |
| `/settings` | `SettingsPage` | Endpoints (node ws + indexer URL), `ThemeToggle`, wallet/identity, profile edit (`EditProfileModal` inline), vault/stake. | `12-surface-settings.md` | Reads config + chain account state; writes `Profile.*`, identity/stake binds, vault txs. |
| `/welcome` | `WelcomePage` | Onboarding/auth: connect wallet → derive posting key → bind identity. Shown to not-connected / not-bound users (see §6.4 gating). | `11-surface-onboarding-auth.md` | `useSigner` (derive sr25519), `CognoGate.link_identity_signed` (FEELESS unsigned bare tx). |
| `/_not-found` (404) | `NotFoundPage` | Friendly "this page doesn't exist" + link Home. Also the **SPA-fallback document** (see §3). | this doc | none |

### 1.1 Route segment list (App Router file tree)

```
src/app/
  layout.tsx              ← root: <html>, theme <body data-theme>, fonts, ChainProvider, AppShell
  page.tsx                ← /            HomePage
  not-found.tsx           ← /_not-found  NotFoundPage  (Next renders this into out/404.html)
  explore/
    page.tsx              ← /explore     ExplorePage
  post/
    [id]/
      page.tsx            ← /post/[id]   PostDetailPage   (see §2 — needs generateStaticParams stub)
  u/
    [address]/
      page.tsx            ← /u/[address] ProfilePage      (see §2 — needs generateStaticParams stub)
  compose/
    page.tsx              ← /compose     ComposePage
  settings/
    page.tsx              ← /settings    SettingsPage
  welcome/
    page.tsx              ← /welcome     WelcomePage
```

Every `page.tsx` is a **Client Component** (`"use client"` at the top). There is no server data
fetching anywhere; the chain/indexer reads happen in the browser via the `FeedSource` and PAPI client
mounted by `ChainProvider` in `layout.tsx`. (`AppShell`, `ChainProvider`, the navigation rails, and the
modal-route host are defined in §4 and §5 of this doc; their visual styling is in
`02-design-system.md` / `03-component-library.md §22.7`.)

---

## 2. Static export of dynamic routes — the core decision

**Problem.** `output: 'export'` pre-renders routes to static HTML at build time. A dynamic segment
(`/post/[id]`, `/u/[address]`) requires `generateStaticParams()` to enumerate **every** id, which Next
then bakes to `out/post/<id>/index.html`. We cannot enumerate post ids or account addresses — they are
created **after** the build, on-chain, forever. A naive build either errors ("Page `/post/[id]` is
missing `generateStaticParams()`") or only ships the handful of ids known at build time, 404-ing every
real deep link.

**Decision (do this).** Ship dynamic segments as **client-resolved routes** with a **single
build-time placeholder param**, and add an **nginx SPA fallback** so any real deep link is served the
app shell, which then reads the param from the URL **client-side** and fetches by id. Concretely:

1. **`generateStaticParams` returns a single throwaway placeholder**, so the build succeeds and emits
   the route's JS bundle + a placeholder HTML doc:

   ```ts
   // src/app/post/[id]/page.tsx
   export function generateStaticParams() {
     // Static export needs ≥1 param to emit the route bundle. The real id is read
     // client-side from the URL; this placeholder is never a real post and 404s gracefully
     // if hit directly. Deep links to real ids are served via the nginx SPA fallback (doc 01 §3).
     return [{ id: "_" }];
   }
   ```

   Same for `u/[address]/page.tsx` with `return [{ address: "_" }];`.

2. **The page reads the param client-side, never from props.** Because the HTML on disk is the
   placeholder doc, the component must NOT trust any baked param. It reads the live param from
   `next/navigation`:

   ```tsx
   "use client";
   import { useParams } from "next/navigation";
   import { notFound } from "next/navigation";

   export default function PostDetailPage() {
     const { id } = useParams<{ id: string }>();
     // Validate: id must be a base-10 u64. Placeholder "_" or junk → in-app not-found state.
     if (!/^\d+$/.test(id)) return <NotFoundInline kind="post" />;
     // …source.thread(BigInt(id)) … (see 08-surface-thread.md)
   }
   ```

   For `/u/[address]`: validate the param is a plausible ss58 string (length + base58 alphabet; do a
   real `decodeAddress` try/catch in the profile fetch — see `07-surface-profile.md`). Invalid → in-app
   not-found state, **not** a hard 404 (we never reach the server).

3. **nginx `try_files` SPA fallback** rewrites any unmatched deep link to the app shell so the browser
   loads the JS, hydrates, and step 2 runs. See §3 for the exact block. This is the piece that makes
   `https://cogno.example/post/918273/` resolve even though no `out/post/918273/index.html` exists.

**Why this over the alternatives:**

- *Catch-all `[...slug]` single route:* also viable, but it collapses all routing into one component
  and loses the clean per-route bundle split + `next/link` ergonomics. We keep typed `[id]` / `[address]`
  segments because every sibling doc references those exact routes; the placeholder+param trick gives us
  static-export compatibility without a god-route.
- *Hash routing (`/#/post/918273`):* works with zero nginx config but produces ugly, non-shareable
  URLs that break X-parity and SEO/preview. Rejected.
- *Query-param routing (`/post?id=918273`):* keeps clean static files but diverges from the canonical
  `/post/[id]` path contract every doc uses. Rejected.

> **Build-output note.** With `trailingSlash: true`, the placeholder emits `out/post/_/index.html` and
> `out/u/_/index.html`. These are harmless artifacts; nginx never serves them for real ids (real ids
> miss on disk and hit `try_files`). Do **not** rely on them. Do **not** add `dynamicParams = false`
> (it would make every non-placeholder id 404 at the framework level instead of falling through to the
> SPA shell).

---

## 3. nginx config — the SPA fallback (REQUIRED, load-bearing)

The static export lands in `/var/www/cogno/` (per the deploy command). Because every route is a
directory with `trailingSlash: true` (`/explore/` → `/explore/index.html`), the fallback must try the
exact file, then the directory's `index.html`, and **only then** fall through to the SPA shell so
client-resolved dynamic routes work. Use Next's emitted **`404.html`** (from `not-found.tsx`) as the
fallback document — it already mounts the full `AppShell`, so the client router takes over and resolves
the real route. (If you prefer the home document as the fallback, `/index.html` also works; `404.html`
is cleaner because it carries the correct status semantics while still booting the SPA.)

```nginx
server {
  listen 443 ssl http2;
  server_name cogno.example;

  root /var/www/cogno;          # rsync target of app/out/
  index index.html;

  # Long-cache immutable hashed assets (Next emits /_next/static/** with content hashes).
  location /_next/static/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files $uri =404;
  }

  # HTML must NOT be cached hard — a redeploy must be picked up immediately.
  location ~* \.html$ {
    add_header Cache-Control "no-cache";
    try_files $uri =404;
  }

  # Main resolver. Order matters:
  #   1) exact file on disk            (/_next/..., /favicon.ico, /robots.txt)
  #   2) directory index               (/explore/  -> /explore/index.html)         [trailingSlash:true]
  #   3) the SPA shell                 (/post/918273/ -> /404.html -> client router resolves it)
  location / {
    try_files $uri $uri/ /404.html;
  }

  # Deep-link convenience: a user pasting /post/918273 WITHOUT the trailing slash.
  # trailingSlash:true means there is no /post/918273/index.html; let it fall through to the shell.
  # (No special block needed — step 3 of `try_files` already catches it. Documented here so a future
  #  editor does not "fix" it with a 301 to the non-existent trailing-slash directory.)
}
```

**Acceptance for the fallback (state this in the impl checklist):** after deploy, `curl -sI
https://cogno.example/post/999999999/` returns `200` and serves the shell HTML (NOT a bare nginx 404),
and the browser then renders the in-app post-detail (or its not-found state if the id truly doesn't
exist on-chain). Same for `/u/<any-ss58>/`.

---

## 4. App shell & client navigation

### 4.1 Mount order (root layout)

```
src/app/layout.tsx  (Server Component shell — emits <html>/<body>, NO data fetch)
  └─ <body data-theme="dark">                  ← default theme; ThemeToggle flips data-theme (doc 02)
       └─ <Providers>            ("use client") ← ChainProvider + FeedSourceProvider + ToasterProvider
            └─ <AppShell>        ("use client") ← the persistent 3-column / rail / tab chrome
                 ├─ <LeftNav/>            (desktop ≥1020px) / <BottomTabBar/> (mobile <688px)
                 ├─ <main>{children}</main>  ← the active route's page component
                 ├─ <RightRail/>          (desktop ≥1020px only)
                 ├─ <ComposeFab/>         (mobile only — floating compose button)
                 ├─ <ModalRouteHost/>     ← renders compose/quote/reply/edit overlays (see §5.4)
                 └─ <Toaster/>            ← optimistic-UI + error toasts (doc 02)
```

`layout.tsx` itself is a Server Component (it can be, since it fetches nothing) but everything inside
`<Providers>` is client. **The shell persists across navigations** — only `<main>{children}</main>`
swaps — so the PAPI ws connection, the live `source.watch()` subscription, scroll position of the
rails, and the connected wallet/identity state all survive client-side route changes. This is the X
behavior: the rails never reload.

### 4.2 Client-side navigation

- **Use `next/link` (`<Link href>`) for all in-app navigation.** With static export + the App Router,
  `next/link` does client-side route transitions: it swaps `<main>` without a full document reload, so
  the shell, ws connection, and live feed subscription persist. The browser URL updates to the real
  path; on a hard refresh of that URL, the nginx fallback (§3) re-boots the shell and the client
  resolver re-fetches.
- **Programmatic nav** (e.g. after a successful compose, jump to the new `/post/<newId>/`) uses
  `useRouter().push()` from `next/navigation`. Always push **with a trailing slash** to match
  `trailingSlash: true` and avoid a redirect bounce: `router.push(\`/post/${id}/\`)`.
- **Active-link detection** uses `usePathname()` (from `next/navigation`) to set the active state on
  `LeftNav` / `BottomTabBar` items (filled icon + bold label, X-style). Treat `/` as active only on
  exact match; treat `/u/<me>/` as the Profile tab active state.
- **Prefetch:** `next/link` prefetch is a no-op gain on static export (route bundles are already on the
  CDN/nginx); leave default. Do not add custom prefetch logic.

### 4.3 Scroll restoration

The App Router restores scroll on back/forward by default, but with a persistent shell + an infinite
timeline you must be deliberate:

- **Forward navigation** (click into `/post/<id>/`): scroll the `<main>` column to top.
- **Back navigation** to a timeline: restore the prior scroll offset. Persist the home timeline's
  scroll offset in a ref keyed by pathname inside `AppShell`, and restore it on `popstate` — X does
  this so returning from a thread lands you exactly where you were. (Implementation detail lives in
  this doc (01) + `03-component-library.md §22.7`; this doc only mandates the behavior and that the timeline owns its own
  scroll container, not the document — see §5.1.)
- The **document/body does not scroll**; the **center column** is the scroll container on desktop
  (rails are `position: sticky`). On mobile the document scrolls under a sticky top bar + fixed bottom
  tab bar. This split is what lets the rails stay put while the timeline scrolls (X-exact).

---

## 5. Navigation model per breakpoint (X-exact)

### 5.1 Breakpoints (exact px)

These mirror X's responsive grid. **Pin these values in `02-design-system.md` as tokens and reference
them; this doc is the source of truth for the layout switch points.**

| Name | Range | Layout |
|---|---|---|
| **Mobile** | `< 500px` | Single column, full-bleed. Top bar (logo + avatar) + `BottomTabBar` + compose FAB. No rails. |
| **Mobile-wide** | `500–687px` | Same as Mobile but timeline gets comfortable side padding. Still bottom tabs + FAB. |
| **Tablet (collapsed rail)** | `688–1019px` | `LeftNav` collapses to an **icon-only rail** (icons, no labels; the "Post" button becomes a round accent icon button). Main column. **No `RightRail`.** No bottom tabs. |
| **Desktop** | `≥ 1020px` | Full **3-column**: `LeftNav` (icons **+ labels** + full-width pill "Post" button) │ main column │ `RightRail` (`SearchBar` + Who-to-follow). |
| **Desktop-wide** | `≥ 1280px` | Same 3-column; `LeftNav` and `RightRail` reach their max widths, center column caps at `600px` (X's canonical timeline width). |

Center timeline column is a fixed **600px** max-width on desktop (X-exact); it grows to fill on
tablet/mobile. The hairline divider, hover row highlight, and sticky header all live on this column.

> The single hard switch users feel is **688px** (rail collapses, bottom tabs disappear ↔ appear) and
> **1020px** (`RightRail` appears/disappears). Implement with CSS container/media queries; no JS layout
> branching beyond what `AppShell` needs to mount/unmount `RightRail`, `BottomTabBar`, and `ComposeFab`.

### 5.2 Desktop (≥1020px) — 3-column

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  (centered max-width ~1280px container; columns flex within)                               │
│                                                                                            │
│  ┌─────────────────┐   ┌──────────────────────────────┐   ┌──────────────────────────┐    │
│  │  LeftNav        │   │  main  (max 600px)           │   │  RightRail (~350px)      │    │
│  │  (sticky, h100) │   │  (THE scroll container)      │   │  (sticky, h100)          │    │
│  │                 │   │                              │   │                          │    │
│  │  [cogno mark]   │   │ ┌──────────────────────────┐ │   │ ┌──────────────────────┐ │    │
│  │                 │   │ │ sticky header            │ │   │ │ SearchBar            │ │    │
│  │  ◉ Home         │   │ │  Home  [For you|Following]│ │   │ │  🔍 Search cogno     │ │    │
│  │  ○ Explore      │   │ │  (backdrop-blur)         │ │   │ └──────────────────────┘ │    │
│  │  ○ Profile      │   │ ├──────────────────────────┤ │   │ ┌──────────────────────┐ │    │
│  │  ○ Settings     │   │ │ Composer (inline, home)  │ │   │ │ Who to follow        │ │    │
│  │                 │   │ ├──────────────────────────┤ │   │ │  • DisplayName  [Follow]│  │    │
│  │  ┌────────────┐ │   │ │ PostCard ───────────────│ │   │ │  • DisplayName  [Follow]│  │    │
│  │  │   Post     │ │   │ │ PostCard ───────────────│ │   │ │  • DisplayName  [Follow]│  │    │
│  │  └────────────┘ │   │ │ PostCard ───────────────│ │   │ │  [Show more]         │ │    │
│  │                 │   │ │  …infinite, hairline      │ │   │ └──────────────────────┘ │    │
│  │  [Account mini] │   │ │   dividers, hover tint    │ │   │ (footer: theme · about)  │    │
│  │  avatar+@handle │   │ └──────────────────────────┘ │   └──────────────────────────┘    │
│  └─────────────────┘   └──────────────────────────────┘                                    │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- `LeftNav` and `RightRail` are `position: sticky; top: 0; height: 100vh`. They do **not** scroll with
  the timeline.
- The **main column is the scroll container** (`overflow-y: auto; height: 100vh`). Its sticky header
  uses `position: sticky; top: 0` with `backdrop-filter: blur(12px)` over a translucent `--cg-bg`
  (X-exact glassy header).

### 5.3 Tablet (688–1019px) — collapsed icon rail

```
┌────────────────────────────────────────────────────────────────────┐
│  ┌──────┐   ┌──────────────────────────────────────────────────┐   │
│  │ Left │   │  main  (fills remaining width, no max-600 cap)   │   │
│  │ rail │   │                                                  │   │
│  │ icons│   │  ┌────────────────────────────────────────────┐  │   │
│  │      │   │  │ sticky header  Home [For you|Following]     │  │   │
│  │ [◈]  │   │  ├────────────────────────────────────────────┤  │   │
│  │ ◉    │   │  │ Composer (inline)                          │  │   │
│  │ ○    │   │  ├────────────────────────────────────────────┤  │   │
│  │ ○    │   │  │ PostCard ─────────────────────────────────│  │   │
│  │ ○    │   │  │ PostCard ─────────────────────────────────│  │   │
│  │ (+)  │   │  │  …                                          │  │   │
│  │      │   │  └────────────────────────────────────────────┘  │   │
│  │ [av] │   │                                                  │   │
│  └──────┘   └──────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
        ▲ icon-only LeftNav            ▲ NO RightRail at this width
        ▲ "Post" is a round (+) accent icon button (no label)
```

- `RightRail` is **not rendered** below 1020px. Search moves to the **Explore** route (the
  `SearchBar` lives at the top of `/explore`), so search is still reachable — there's just no rail to
  host it. (`10-surface-explore-search.md` owns the `/explore` `SearchBar` placement.)
- `LeftNav` item labels are hidden; only icons show; the big "Post" pill becomes a round accent FAB-style
  icon button **inside the rail** (X-exact tablet behavior). The Account mini-widget at the bottom
  becomes avatar-only.

### 5.4 Mobile (<688px) — top bar + bottom tabs + FAB

```
┌───────────────────────────────┐
│  ┌─────────────────────────┐  │  ← sticky top bar (backdrop-blur)
│  │ (av)   ◈ cogno     ⚙    │  │     left: your Avatar (opens a slim left drawer w/ Profile/Settings)
│  └─────────────────────────┘  │     center: wordmark · right: settings gear (or contextual)
│  ┌─────────────────────────┐  │
│  │  [For you | Following]  │  │  ← TimelineTabs pinned under the bar on Home
│  ├─────────────────────────┤  │
│  │ PostCard ──────────────│  │
│  │ PostCard ──────────────│  │  ← document scrolls (single column, full bleed)
│  │ PostCard ──────────────│  │
│  │  …                      │  │
│  │                    ( + )│  │  ← ComposeFab: fixed bottom-right accent circle, opens /compose modal
│  ├─────────────────────────┤  │
│  │  ⌂      🔍      ◎      ⚙ │  │  ← BottomTabBar (fixed): Home · Explore · Profile · Settings
│  └─────────────────────────┘  │
└───────────────────────────────┘
```

- **`BottomTabBar`** is `position: fixed; bottom: 0` with 4 items (see §6.2). The active item is filled
  + accent-tinted.
- **`ComposeFab`** is a fixed accent circle above the bottom bar (bottom-right). Tapping it opens the
  **compose modal route** (§7), which on mobile is a full-screen sheet.
- The **top bar** carries the wordmark; the left avatar opens a slide-in drawer that mirrors `LeftNav`
  (gives access to Profile/Settings without crowding the 4-slot bottom bar).

---

## 6. Navigation item sets (canonical)

### 6.1 `LeftNav` items (desktop labels / tablet icons)

In order, top → bottom:

1. **cogno wordmark / mark** (links to `/`). Uses the cogno accent (`--cg-accent`), not X blue.
2. **Home** → `/` — house icon. Active on exact `/`.
3. **Explore** → `/explore` — magnifier/compass icon. Active on `/explore` and on any active search.
4. **Profile** → `/u/<my-ss58>/` — person icon. Resolves to the connected account's address; if
   not connected, this item routes to `/welcome` instead (and shows a subtle "connect" affordance).
   Active on `/u/<me>/`.
5. **Settings** → `/settings` — gear icon. Active on `/settings`. (X puts Settings under "More"; we
   promote it to a top-level rail item because it hosts wallet/identity/theme/vault — the chain-config
   surface — and we have spare slots since several X items are cut.)
6. **"Post" button** — full-width accent **pill** (`--cg-radius-pill`, `--cg-accent` fill,
   `--cg-accent-contrast` text). Opens the **compose modal** (§7). On tablet it's a round accent icon
   button.
7. **Account mini-widget** (bottom, sticky to rail base): `Avatar` + `DisplayName` + `Handle`
   (truncated ss58, mono). Click → a small menu with "View profile", "Settings", "Disconnect". If not
   connected, this becomes the `ConnectWalletButton`.

**Items deliberately CUT from X's rail (state this in the UI as simply *absent*, never as a labeled
omission):**

- **Notifications** — DEFERRED (per LOCKED DECISIONS). Do **not** add the bell now. But the indexer
  emits `Voted` / `Reposted` / `Followed` / `PostCreated{parent=you}` / `quote` targeting an account,
  which is exactly a notifications feed. Leave a `// HOOK: notifications — indexer events
  Voted/Reposted/Followed/reply/quote targeting <me> → a future /notifications route + bell here`
  comment at the rail item list and at the `BottomTabBar` so the follow-up has a home.
- **Messages (DMs)** — OUT of scope (no DM chain primitive). Omit entirely.
- **Lists** — OUT of scope. Omit entirely.
- **Communities / Premium / Verified / Bookmarks / Grok** — OUT of scope / not chain-backed. Omit.
- **More (…)** menu — not needed; the 5 promoted items + Post button cover everything. (If a future
  surface needs overflow, reintroduce a "More" disclosure; not now.)

### 6.2 `BottomTabBar` items (mobile, exactly 4)

`Home (/)` · `Explore (/explore)` · `Profile (/u/<me>/)` · `Settings (/settings)`. Icons match the
rail. Compose is the **FAB**, not a tab (X-exact: compose is the floating button, never a bottom tab).
Profile resolves to the connected address or `/welcome` when not connected. Leave the same
notifications HOOK comment here — if/when notifications ship, the bottom bar becomes Home · Explore ·
Notifications · Profile and Settings moves into the top-bar drawer (document this swap as the planned
layout in the notifications follow-up, do not build it).

### 6.3 `RightRail` content (desktop ≥1020px only)

Top → bottom, sticky:

1. **`SearchBar`** — rounded pill input, magnifier glyph, placeholder "Search cogno". Submitting (or
   pressing Enter) routes to `/explore?q=<term>` *as in-app client state* — but since static export +
   nginx can't read query strings server-side and we avoid query-param routing (§2), the search term is
   carried in **client state / the explore page's local URL via `useRouter().push` with a query** that
   the **client** reads (`useSearchParams()`), not the server. `useSearchParams()` works fine in a
   static export because resolution is client-side. Search **requires `caps.search`** (GraphQL reader);
   if the active `FeedSource.kind === 'papi'`, the `SearchBar` shows but submitting routes to `/explore`
   and renders an inline "Search needs the indexer (set it in Settings)" notice in the results area —
   plain functional copy, never a trust/honesty frame.
2. **"Who to follow"** — up to 3 accounts the connected user does **not** already follow, derived from
   the follow graph (`10-surface-explore-search.md` / `07-surface-profile.md` own the selection query — e.g. most-
   followed accounts via `Author.followerCount` desc, excluding self + existing `outgoingFollows`). Each
   row: `Avatar` + `DisplayName` + `Handle` + `FollowButton`. "Show more" links to `/explore`. With the
   PAPI-direct reader (no indexer), fall back to "recently active authors" derivable from the live feed,
   or hide the module if that's not cheaply computable — never show an empty trends box.

**Explicitly NOT in the `RightRail`:** Trends / What's happening (OUT of scope — no trends primitive),
premium upsell, footer ad links. The rail footer may carry the `ThemeToggle` and an "About" link only.

### 6.4 Auth-gating of nav targets

The shell is **always** mounted (you can read the timeline without a wallet — reads are public). But
**write affordances** and identity-scoped nav resolve against connection/identity state:

| State | Profile nav target | "Post" button / FAB | Compose / vote / repost / follow actions |
|---|---|---|---|
| Not connected (no wallet) | → `/welcome` | opens `/welcome` | each action, on intent, routes to `/welcome` (connect-first) |
| Connected, wallet only, **not identity-bound** | → `/welcome` (finish bind) | opens `/welcome` | intent → `/welcome` to complete `link_identity_signed` |
| Connected + identity-bound | → `/u/<me>/` | opens compose modal | actions fire their extrinsics (capacity-metered; rate-limit handled per `02`) |

`/welcome` is therefore both a route and the **gate target** for unauthenticated write intent. It is
the *only* route that meaningfully changes by auth state; all read routes render for everyone.
(`11-surface-onboarding-auth.md` owns `/welcome`'s internal steps; this doc owns that write-intent funnels there.)

---

## 7. Modal routes (compose / quote / reply / edit-profile)

X opens compose/quote/reply/edit-profile as **overlay modals** layered over the current surface, with
the URL updated so the modal is **deep-linkable and back-button-dismissible** — but it must also work as
a **standalone page** when navigated to directly (e.g. a shared `/compose/` link, or a hard refresh
while the modal is open). On a server framework this is Next's *intercepting/parallel routes*. **Those
do not work with `output: 'export'`** (intercepting routes require the server router). So we implement
modal routes **client-side**:

### 7.1 Strategy: client modal state + URL sync, with full-page fallback

- The **modal target is a real route**: `/compose/` (the `ComposePage`). Quote and reply are
  parameterized **client state**, not separate static routes (we will not pre-render
  `/compose/quote/[id]`). Instead:
  - **Open as overlay (preferred path):** when the user clicks Reply/Quote/Post from within the app,
    `AppShell`'s `<ModalRouteHost>` opens the appropriate composer (`Composer` / `ReplyComposer` /
    `QuoteComposer` / `PollComposer`) as an **overlay** *without* a full navigation. It updates the URL
    via `history.pushState` to a shareable form — `/compose/`, with the reply/quote target in
    `?reply=<id>` / `?quote=<id>` query (read client-side via `useSearchParams()`), and the underlying
    timeline stays mounted behind the dimmed `--cg-overlay`. Back button / Esc / dim-click closes the
    overlay and `history.back()` restores the previous URL — modal dismissed, surface intact.
  - **Full-page fallback (deep link / refresh):** if `/compose/` is loaded cold (no underlying surface
    in the client history), `ComposePage` renders the composer as a **standalone full page** (the X
    behavior when you open a compose link directly). The composer reads `?reply=` / `?quote=` from
    `useSearchParams()` and pre-loads the target post for context. On submit or cancel it
    `router.push('/')` (or `history.back()` if there is in-app history).
- **`EditProfileModal`** follows the same pattern but its standalone fallback is `/settings/` (the
  profile-edit section), since edit-profile is a Settings concern. Open as overlay from the profile
  header; deep-linked, it lands in Settings with the edit section focused. (`12-surface-settings.md` owns the
  Settings section; this doc owns the overlay/route behavior.)

### 7.2 `<ModalRouteHost>` contract

A single client component mounted once in `AppShell` that:

1. Subscribes to a tiny client `modalStore` (`{ kind: 'compose'|'reply'|'quote'|'poll'|'edit-profile'|null, targetId?: string }`).
2. Renders the matching composer in `ComposerModal` chrome (centered card desktop / full-screen sheet
   mobile, `--cg-overlay` scrim, focus-trapped, Esc-to-close, scroll-locked body).
3. Keeps the URL in sync: opening pushes the shareable URL; closing pops it. Uses the History API
   directly (not `next/router`) so we never trigger a full route swap of `<main>`.
4. **Never blocks reads behind it** — the timeline keeps its live `source.watch()` subscription so a new
   post lands in the feed even while the composer is open (X-exact).

This gives X-identical modal UX (deep-linkable, back-dismissible, refresh-safe) within the static-export
constraint, with `/compose/` and `/settings/` as the honest standalone fallbacks every overlay degrades
to.

---

## 8. Sticky-header pattern per surface

Every primary surface has X's **sticky, backdrop-blurred header** at the top of the center/main column.
It is `position: sticky; top: 0; z-index: --cg-z-header` with `backdrop-filter: blur(12px)` over a
translucent `--cg-bg`. Contents per surface:

| Surface | Sticky header contents |
|---|---|
| `/` Home | Title "Home" (mobile) + **`TimelineTabs`** (For you / Following) as the second row. On desktop the title row is minimal; the tabs row is the prominent sticky element. |
| `/explore` | **`SearchBar`** (full-width on mobile where there's no rail) + optional result-scope tabs (People / Posts) if `10-surface-explore-search.md` defines them. |
| `/post/[id]` | **Back arrow** (← to previous, X-style) + "Post" / "Thread" label. Back uses `history.back()` if in-app history exists, else `router.push('/')`. |
| `/u/[address]` | **Back arrow** + the author's `DisplayName` + a small post-count subtitle (X puts the name + post count in the sticky header over the profile banner). `ProfileTabs` (Posts / Replies / Likes) is the second sticky row. |
| `/compose` | Full-page: "Cancel" (left) + "Post" CTA (right), no blur header (it's a focused composer). |
| `/settings` | "Settings" label + back arrow on mobile; section list below. |
| `/welcome` | No sticky timeline header — it's a centered onboarding flow (own chrome). |

The back-arrow behavior is uniform: **prefer `history.back()`** when `window.history.length > 1` and the
referrer is in-app, otherwise `router.push('/')`, so deep-linked detail pages (no in-app history) still
have a sane "up" target.

---

## 9. Divergences honored (X clone vs cogno chain semantics)

This doc's IA encodes the LOCKED divergences; restating the ones that touch routing/nav:

- **No Notifications / Messages / Lists / Trends / Bookmarks / Media** in the nav or rails — cut for
  scope, with a single labeled **notifications HOOK** comment left at the rail + bottom-bar item lists
  (the indexer events make it the obvious next surface; do not build it).
- **No honesty/trust chrome anywhere in the shell** — no block-number marginalia, no "trusted follower"
  labels, no "signed ≠ finalized". Endpoint + wallet/identity config lives **silently in `/settings`**,
  framed as plain settings, not honesty. Rate-limit (capacity-exhausted) surfaces only as a Twitter-style
  `RateLimitNotice` on the relevant action (owned by `02`/`09-surface-compose.md`), never as a battery in the nav.
- **ss58-as-handle:** the Profile nav item and `/u/[address]` use the raw ss58 account address as the
  stable id (no unique usernames on-chain). `Handle` renders truncated-mono; `DisplayName` is the
  non-unique `Profile.display_name` (fallback: truncated address). `Avatar` falls back to a deterministic
  identicon derived from the address.
- **Static export, no server:** every routing mechanism above is client-resolved; the only "server" is
  nginx serving files + the `try_files` SPA fallback (§3). No SSR, no API route, no Next Image, no
  middleware — and nothing in the nav assumes them.
- **Reads are public; writes are gated** — the shell mounts for everyone; write intent funnels to
  `/welcome` (§6.4).

---

## 10. Implementation checklist (ordered)

Routing/IA foundation — do these before any per-surface doc is implemented.

- [ ] **Replace the single-page app with the App Router tree** in §1.1: create `layout.tsx` (keep the
      existing `trailingSlash`, `images.unoptimized`, `output: 'export'` config untouched) and the eight
      `page.tsx` routes + `not-found.tsx`. Each `page.tsx` starts with `"use client"`.
- [ ] **Build `AppShell`** (§4.1) as the persistent chrome mounting `LeftNav` / `RightRail` /
      `BottomTabBar` / `ComposeFab` / `<ModalRouteHost>` / `<Toaster>` around `{children}`. Mount it
      inside `<Providers>` (ChainProvider + FeedSourceProvider + ToasterProvider) in `layout.tsx`.
- [ ] **Implement the responsive switch** at the exact breakpoints in §5.1 (688px rail-collapse + bottom-
      tabs toggle; 1020px RightRail toggle; 600px center cap; 1280px max container). Use CSS
      media/container queries; mount/unmount `RightRail`/`BottomTabBar`/`ComposeFab` in `AppShell`.
- [ ] **Static-export dynamic routes (§2):** add `generateStaticParams` returning a single placeholder
      to `post/[id]/page.tsx` (`[{ id: "_" }]`) and `u/[address]/page.tsx` (`[{ address: "_" }]`). Read
      the param **client-side** via `useParams()`, validate (`/^\d+$/` for post id; ss58 decode-try for
      address), render the in-app not-found state on invalid. Do **not** set `dynamicParams = false`.
- [ ] **`npm run build` succeeds** (no "missing generateStaticParams" error) and `out/` contains
      `post/_/index.html`, `u/_/index.html`, `404.html`, and the eight route directories.
- [ ] **Add the nginx `location` blocks (§3)** to the deploy config: `_next/static` immutable cache,
      `*.html` no-cache, and `location / { try_files $uri $uri/ /404.html; }`. Verify post-deploy:
      `curl -sI https://<host>/post/999999999/` → `200` serving the shell; same for `/u/<ss58>/`.
- [ ] **Wire `LeftNav` items** (§6.1): Home/Explore/Profile/Settings + the accent "Post" pill + Account
      mini-widget. Resolve Profile to `/u/<me>/` or `/welcome` per auth state (§6.4). Add the
      notifications `// HOOK` comment.
- [ ] **Wire `BottomTabBar`** (§6.2): 4 tabs + the same Profile resolution + HOOK comment. `ComposeFab`
      opens the compose modal route.
- [ ] **Wire `RightRail`** (§6.3): `SearchBar` (gated on `caps.search`; PAPI-direct → inline "needs
      indexer" notice on `/explore`) + Who-to-follow + footer (ThemeToggle + About). No trends.
- [ ] **Active-link + back-arrow logic:** `usePathname()` for active nav state; uniform back behavior
      (`history.back()` if in-app history else `router.push('/')`).
- [ ] **Client navigation:** all in-app links use `<Link href>`; programmatic nav uses
      `useRouter().push()` **with trailing slashes**; main column is the desktop scroll container; rails
      `position: sticky`.
- [ ] **Scroll restoration (§4.3):** center column owns scroll on desktop; persist + restore the home
      timeline offset on back-nav; scroll-to-top on forward into detail pages.
- [ ] **Modal routes (§7):** build `<ModalRouteHost>` + `modalStore`; overlay compose/reply/quote/poll
      with `history.pushState` URL sync (`/compose/?reply=`/`?quote=`) and Esc/back/dim dismissal; full-
      page fallback in `ComposePage` (read `useSearchParams()`); `EditProfileModal` overlay → `/settings/`
      standalone fallback. Reads keep streaming behind the open modal.
- [ ] **Sticky headers (§8):** implement the per-surface sticky backdrop-blur header table; uniform
      back-arrow target resolution.
- [ ] **Auth-gating (§6.4):** funnel write intent (Post button, Reply/Quote/Repost/Vote/Follow, FAB) to
      `/welcome` when not connected or not identity-bound; render all read routes for everyone.
- [ ] **Smoke the SPA on nginx:** deep-link `/post/<real-id>/`, `/u/<real-ss58>/`, `/explore/`,
      `/settings/` via hard refresh → shell boots, client resolver renders the right surface (or its
      not-found state). Back/forward preserves the shell + ws subscription + scroll.
