# 05 — Divergences & Hard Constraints

This is the **canonical constraints registry** for the cogno-chain frontend. Every other doc in
`docs/frontend-spec/` points here for the single, authoritative answer to *"where does cogno differ
from Twitter/X, and what is the chosen UX?"* We are deliberately **cloning Twitter/X** — exact
layout, component set, spacing rhythm, and interaction patterns — while the underlying machine is a
feeless, Cardano-anchored Substrate chain rather than a fee-and-database web2 service. Wherever the
chain's semantics force a behavioral divergence from Twitter, this doc records it once, decides the
UX once, and gives the one-line rationale once. Implementers MUST treat every numbered divergence
below as a binding requirement; sibling docs assume these decisions and do not re-litigate them.

A few global facts the whole registry rests on (see also the SHARED GROUNDING block the team works
from): the runtime is **spec_version 116**; the frontend is a **Next.js 14 static export**
(`output: 'export'`) with **no server, no SSR, no API routes**, served from nginx; user-facing
write actions are **feeless** (talk-capacity metered) except profile edits and pins, which are
**fee-bearing**; identity, posting weight, and voting power all originate from **Cardano (observed,
not bridged)**. The **trust/honesty layer is dropped entirely** — no honesty badges, no
"signed ≠ finalized", no "operator-run / trusted follower" marginalia. The UI is **optimistic**:
an action renders immediately, reconciles on confirmation, and rolls back with a toast on failure.

> **How to read each entry.** Every divergence has four fields:
> **Twitter** (the web2 behavior we are imitating) · **cogno-chain reality** (the on-chain truth) ·
> **Chosen UX** (what we build) · **Rationale** (the one-line why). Several entries add a
> **Wireframe / interaction** sketch and an explicit **State** list. The doc closes with a
> consolidated constraints table and an ordered implementation checklist.

---

## Index of divergences

| #  | Topic | One-line divergence |
|----|-------|---------------------|
| D1 | Post length & content | Text-only, **512 BYTES UTF-8** (not 280 chars); no media; URL auto-link only; avatar is a URL field |
| D2 | Like = weighted upvote + downvote + score | Heart = stake-weighted **upvote**; downvote is secondary; signed weighted **score** on detail |
| D3 | Reposts are permanent | No un-repost ever; confirm dialog; filled state is terminal |
| D4 | Polls have no expiry | Stake-weighted, **max 4 options ≤ 80 bytes**, "Open" not a countdown; % by weight |
| D5 | Feeless but capacity rate-limited | Reframe exhaustion as Twitter-style **rate limiting**; never a battery |
| D6 | No unique @handles | Handle = truncated **ss58** (mono); display name non-unique; identicon fallback |
| D7 | Login = wallet + derived key + CIP-8 bind | Cardano CIP-30 → derived sr25519 → identity bind; **"verified" concept dropped** |
| D8 | Static export / no server | Search & pagination only with an **indexer URL**; deep links via nginx SPA fallback |
| D9 | Profiles fee-bearing, posting feeless | One-time tiny **profile-edit fee** needs a funded account; documented handling |
| D10| Moderation = revoke→banned | Author **banned** (posts remain, author dimmed), **never delete** |
| D11| Optimistic UI & confirmation model | No block-number marginalia; reconcile silently; roll back with toast |
| D12| Counts & weights vocabulary | `upCount` next to heart; `weight`/`score` only on detail; permanent `repostCount` |

---

## D1 — Posts are text-only, 512 **bytes** UTF-8 (not 280 characters); no media

- **Twitter.** A "tweet" is up to **280 characters** (Twitter weights some ranges differently, e.g.
  CJK = 2), supports inline image/video/GIF uploads, a media compose toolbar, and link-card unfurls.
- **cogno-chain reality.** `Microblog.post_message(text: Vec<u8>, parent: Option<u64>)` stores
  `BoundedVec<u8, MaxLength>` with **`MaxLength = 512` BYTES** (runtime `configs/mod.rs`,
  `type MaxLength = ConstU32<512>`). The chain stores **raw UTF-8 bytes only** — there is **no media
  storage, no blob store, no upload endpoint**, and the avatar is a **string URL field**
  (`Profile.set_profile(.. avatar: Vec<u8>)`, `MaxAvatar = 128` bytes) pointing at an external
  URL/IPFS CID, **not** image bytes. Quote text and poll questions also reuse the 512-byte body.
- **Chosen UX.**
  - The **ByteCounter** counts **UTF-8 BYTES**, not characters or "Twitter-weighted" units. It MUST
    use `new TextEncoder().encode(value).length` (or equivalent) — never `value.length` (which is
    UTF-16 code units). One ASCII char = 1 byte; `é` = 2 bytes; most emoji = 4 bytes; many ZWJ emoji
    sequences (e.g. 👨‍👩‍👧) cost **11+ bytes**. The counter shows **remaining bytes** ("512" →
    counts down), turns the cogno accent → `--cg-danger` near the limit, and the **Post** CTA
    disables at **> 512 bytes** (strict; the chain rejects `TooLong` at the pool — see D11).
  - The composer has **NO media buttons** at all: no image, no video, no GIF, no poll-image. The
    only compose affordances are: text area, **ByteCounter**, the **PollComposer** toggle (D4), and
    the **Post** CTA. (Twitter's media toolbar row is simply omitted — do not render placeholder
    disabled icons; their absence is the design.)
  - A **TEXT emoji picker is permitted** (it inserts plain Unicode emoji characters into the body,
    whose bytes **count toward the 512-byte budget** via the ByteCounter — most emoji ≈ 4 bytes, ZWJ
    sequences 11+). **Media/sticker/GIF pickers are NOT** permitted — those imply a blob pipeline the
    chain has no storage for.
  - **PostBody** renders **URL auto-linking only** (linkify `http(s)://…` to anchors with
    `rel="noopener noreferrer"`), preserves newlines, and **does not unfurl link cards** and **does
    not embed media**. A pasted image URL renders as a plain clickable link, not an image.
  - **Avatar** is set from `Profile.avatar` (a URL); when empty, fall back to a **deterministic
    identicon/blockie** derived from the ss58 address (see D6). The EditProfileModal exposes avatar
    as a **URL text input with a live preview**, never a file picker.
  - **ProfileTabs** are **Posts / Replies / Likes** — there is deliberately **NO "Media" tab**
    (there is no media to aggregate). Note this explicitly in the profile doc.
- **Rationale.** The chain stores bounded UTF-8 bytes and zero binary blobs; counting bytes (not
  chars) is the only way the UI limit matches the on-chain `MaxLength`, and there is nothing to build
  a media pipeline against.

> **Wireframe — Composer (no media row):**
> ```
> ┌──────────────────────────────────────────────┐
> │ (avatar) │ What is happening?!                │   ← textarea, autosize
> │          │ ▍                                   │
> │──────────────────────────────────────────────│
> │  [Poll]                          245   ( Post )│   ← NO image/video/gif icons
> └──────────────────────────────────────────────┘     245 = BYTES remaining
> ```

> **Notifications hook (deferred).** Posts that `parent`/`quote`-reference your post drive future
> reply/quote notifications via the `PostCreated` + `Post.parent`/`Post.quote` indexer relations.

---

## D2 — "Like" is a stake-**weighted upvote**; there is also a downvote and a signed score

- **Twitter.** The heart is a simple 1-person-1-like toggle; the count is the number of likers; there
  is no dislike and no weighting.
- **cogno-chain reality.** The chain has a genuinely **stake-weighted up/down vote**:
  `Microblog.vote(post_id, dir: VoteDir{Up|Down})` (re-voting **replaces** your prior direction),
  `Microblog.clear_vote(post_id)` removes it. Each vote's weight = the caller's **VotingPower
  snapshot** at vote time (0 until the account binds a stake credential via
  `CognoGate.link_stake_signed`). The indexer exposes both **counts** (`upCount`, `downCount`:
  number of distinct voters) and **weights** (`upWeight`, `downWeight`: BigInt sums), plus
  `score = upWeight − downWeight` (BigInt, **MAY be negative**). Events: `Voted{id,who,dir,weight}`,
  `VoteCleared{id,who}`.
- **Chosen UX.**
  - The **heart = the Up vote**, and it is the **primary** PostCardAction (the load-bearing Twitter
    "Like"). Tapping the heart calls `vote(post_id, {type:'Up'})`; tapping a filled heart calls
    `clear_vote(post_id)` (un-like). Filled heart tint = `--cg-like`.
  - The **count shown next to the heart on a PostCard = `upCount`** (number of likers) — this is what
    a Twitter user expects to see. **Weight is NOT shown inline on the timeline.**
  - The **Down vote is a secondary action**, surfaced in the PostCardActions **"…" overflow** menu
    (label: "Downvote" / "Remove downvote"), **not** as a top-level icon. Switching from up→down (or
    down→up) is a single `vote` call (replace); clearing is `clear_vote`.
  - **Weighted score** (`score`, and the `upWeight`/`downWeight` breakdown) is shown only on the
    **post detail / `/post/[id]`** view — render it as a small "Weighted score: +N.NN ⬆ / −M.MM ⬇"
    block. Because votes are stake-weighted, a post with few likers can outrank one with many; the
    detail view is where we make that visible without cluttering the timeline.
  - **Self-like is allowed** (the chain does not forbid voting on your own post). Render normally;
    do not special-case "you can't like your own post."
- **Rationale.** Mapping the weighted up vote to the heart keeps the Twitter muscle-memory intact;
  hiding weight on the timeline and revealing it on detail respects Twitter's clean row while honestly
  surfacing the one place the chain's weighting actually changes outcomes.

> **Interaction map:**
> | UI gesture | Extrinsic | Optimistic effect |
> |---|---|---|
> | Tap empty heart | `vote(id,{type:'Up'})` | heart fills, `upCount`+1 |
> | Tap filled heart | `clear_vote(id)` | heart empties, `upCount`−1 |
> | "…" → Downvote | `vote(id,{type:'Down'})` | `downCount`+1 (+ clears any up) |
> | "…" → Remove downvote | `clear_vote(id)` | `downCount`−1 |

---

## D3 — Reposts are **permanent** (no undo)

- **Twitter.** Retweet is a toggle; you can un-retweet, and the count goes back down.
- **cogno-chain reality.** `Microblog.repost(post_id)` is **PERMANENT** — there is **no un-repost
  extrinsic**, and a duplicate call fails `AlreadyReposted`. The indexer `Repost` edge
  (`id "<postId>-<reposterId>"`) is **never removed**; `Post.repostCount` only ever increases.
  Event: `Reposted{id,who}`.
- **Chosen UX.**
  - The Repost icon (the two-arrows glyph) opens the standard Twitter **repost menu** with **only
    "Repost"** and **"Quote"** (D-quote). There is **no "Undo Repost"** item, ever.
  - Selecting **Repost** shows a lightweight **confirmation dialog**: *"Reposts are permanent and
    cannot be undone. Repost this?"* with **Cancel / Repost** buttons. This is the one place we add
    friction that Twitter does not — because the action is irreversible.
  - After confirmation the icon goes to a **filled / `--cg-repost`-tinted terminal state** and
    `repostCount` increments. The filled state is **non-interactive for un-repost**: re-tapping the
    repost icon on an already-reposted post still opens the menu but with Repost **disabled**
    (tooltip: *"You already reposted this"*) and **Quote** still available (you may quote a post you
    reposted).
  - Optimistic UI applies (icon fills immediately); on `AlreadyReposted` or any failure, roll back
    the fill and toast.
- **Rationale.** The chain makes reposts terminal, so the only honest UX is a one-time confirm plus a
  permanent filled state — offering an "undo" the chain cannot honor would be a lie.

---

## D4 — Polls have **no expiry**, are stake-weighted, max 4 options each ≤ 80 bytes

- **Twitter.** Polls have a **countdown timer** (minutes→days), 2–4 options, 1-person-1-vote, and
  **close** when the timer ends; results show **% of voters**.
- **cogno-chain reality.** `Microblog.create_poll(question: Vec<u8>, options: Vec<Vec<u8>>)` — **2..=4
  options** (`MaxPollOptions = 4`), each **≤ 80 bytes** (`MaxPollOptionLen = 80`), question reuses the
  512-byte body. **There is NO on-chain expiry** — a poll is open forever.
  `Microblog.cast_poll_vote(post_id, option: u8)` is **stake-weighted** (re-cast **replaces**);
  weight = VotingPower snapshot. The indexer `PollOption` carries **`weight` (BigInt) and `count`**;
  results are **% by weight**, not % of voters. Events: `PollCreated{id,author}` (a poll is also a
  `PostCreated`), `PollVoted{id,who,option,weight}`.
- **Chosen UX.**
  - **PollComposer** (inside the Composer): a question field (512-byte ByteCounter), **2 to 4**
    option rows, each with its own **80-byte ByteCounter**; an "Add option" control caps at 4 and is
    hidden at 4; removing drops below… but never below 2. There is **NO duration picker** — omit
    Twitter's "Poll length" control entirely.
  - **PollCard** shows each option as a horizontal bar filled to **its share of total `weight`**, with
    the **`%` by weight** and a small raw `count` ("N voters"). The user's chosen option is
    highlighted. Casting/recasting calls `cast_poll_vote(post_id, option)`; recasting **moves** the
    user's weight to the new option (optimistically animate the bars).
  - Status label is **"Open"** (a static pill), **never a countdown / "1d left" / "Final results"**.
    Do not render a timer, do not gray out / lock the poll, do not show "Closed".
  - Because polls never close, "results" and "voting" are the same view — there is no
    results-after-close transition.
- **Rationale.** No expiry exists on-chain, so a countdown would be fiction; weighting is by stake, so
  honest results are **% by weight** with raw counts as secondary context.

> **Wireframe — PollCard (open, weighted):**
> ```
> Best L1 for social? (poll · Open)
> ┌────────────────────────────────────────┐ 58%
> │ Cardano  ████████████████░░░░░░░░░░░░   │  ← bar = weight share, NOT vote share
> └────────────────────────────────────────┘
> ┌────────────────────────────────────────┐ 42%
> │ Other    ███████████░░░░░░░░░░░░░░░░░░   │
> └────────────────────────────────────────┘
> 12 voters · Open
> ```

---

## D5 — Feeless, but capacity **rate-limited** (talk-capacity, not fees)

- **Twitter.** Free to post; rate limits are silent until you hit one, then "You are over the daily
  limit for sending Tweets" / "Rate limit exceeded."
- **cogno-chain reality.** Posting and all social actions are **feeless** (no per-action fee). The
  right to act is metered by a **regenerating, stake-weighted talk-capacity** (`pallet-microblog`
  `Capacity` row + the `CheckCapacity` tx extension). Capacity **regenerates per block** and its
  **ceiling scales with posting weight** (locked ADA); each action debits micro-capacity units —
  `BaseCost = 50_000_000` (≈ 1 post), `PerByteCost = 50_000` (a 512-byte post ≈ 1.5 posts),
  `VoteCost = 20_000_000`, `RepostCost = 20_000_000`, `FollowCost = 10_000_000`. When capacity is
  insufficient, the feeless extrinsic is **rejected at the pool by `CheckCapacity`** before it ever
  enters a block. Capacity refills **going-forward only** — it is never retroactively banked.
- **Chosen UX.**
  - **Reframe capacity exhaustion as plain Twitter-style RATE LIMITING.** When a feeless action is
    rejected for insufficient capacity (or when a pre-flight estimate says it will be), surface a
    **RateLimitNotice** with Twitter-flavored copy: *"You're posting too fast. Take a break and try
    again shortly."* (and the action-appropriate variant: *"You're over the rate limit — try again
    in a bit."*). It is a transient toast/inline notice, dismissable, with no countdown unless we can
    cheaply estimate one (default: no countdown).
  - **NEVER render a battery / fuel gauge / "capacity meter" / percentage of capacity.** The previous
    `<CapacityBattery>` concept is **removed**; do not reintroduce any visualization that exposes
    "talk-capacity" as a quantity. Capacity is an **invisible rate limiter**, exactly like Twitter's.
  - **Pre-flight (optional, recommended):** the **Composer** Post CTA and the action handlers MAY
    consult a `useCapacity` estimate to **disable** the CTA with the RateLimitNotice copy *before*
    submit (avoiding a doomed broadcast), but the **authoritative** signal is the pool rejection. Do
    not block the UI on a missing/uncertain estimate — when in doubt, let the user try and handle the
    rejection.
  - **Mapping the pool error:** a `CheckCapacity` rejection (invalid-transaction at submit) maps to
    RateLimitNotice; **do not** show a generic "transaction failed" toast for it. (A body
    `> MaxLength` rejection is a **D1** validation bug, not a rate limit — guard against it client-side
    so it never reaches the pool.)
  - **Profile edits / pins are NOT rate-limited this way** — they are **fee-bearing** (D9) and gated
    by account balance, not capacity.
- **Rationale.** The talk-capacity meter *is* a rate limiter; the product decision (LOCKED) is to
  present it as Twitter does — invisible until hit, then a polite "slow down" — never as a
  crypto-flavored battery.

> **States for any feeless action:** `idle → optimistic-pending → success` (reconciled) ·
> `rate-limited` (pool reject → RateLimitNotice + rollback) · `error` (other failure → toast +
> rollback) · `not-connected` / `not-identity-bound` (gate the action; see D7).

---

## D6 — No unique @handles; handle = truncated ss58; display names are non-unique

- **Twitter.** Globally unique **@username** is the identity and the URL (`twitter.com/jack`); display
  name is separate and changeable; verified badges exist.
- **cogno-chain reality.** There are **no usernames on-chain**. The stable identity is the **ss58
  account address** (SS58 prefix **42**), which is the derived posting account bound 1:1 to a Cardano
  identity via `CognoGate.link_identity_signed`. `Profile.display_name` (`MaxName = 64` bytes) is
  **optional and non-unique** (anyone can set any name). The indexer `Author.identityHash` is the
  0x-hex beacon name (null until bound); `Author.banned` (D10); `Author.weight` is posting power.
- **Chosen UX.**
  - The **route key for a profile is the ss58 address**: `/u/[address]`.
  - **Handle** = the **truncated ss58** rendered in the **mono** font (`--cg-font-mono`), e.g.
    `5GrwvaEF…utQY` (first 6 / last 4, with a middle ellipsis), shown where Twitter shows `@username`.
    Clicking it copies the full address (and routes to the profile). This is the **`Handle`**
    component.
  - **DisplayName** = `Profile.display_name` when set, otherwise **fall back to the truncated ss58**
    (same value as the handle). Because display names are non-unique, **always** render the
    `Handle` (truncated address) alongside the `DisplayName` so users can disambiguate — never show a
    display name alone as if it were a unique identity.
  - **Avatar** falls back to a **deterministic identicon/blockie** derived from the address bytes
    (stable per-address) when `Profile.avatar` is empty (the **Avatar** component).
  - **No "verified" badge, no blue check, no any-color check.** The "verified" concept is dropped
    along with the honesty layer (see D7). Identity-bound vs not is **never** shown as a badge on
    posts; it only gates *your own* ability to post (D7).
  - **Search/mention semantics:** there is no `@username` lookup; mentions are **plain text** (no
    on-chain mention index). The SearchBar searches **post text** (and, where supported, display
    names) — not unique handles. Do not build an autocomplete that implies unique usernames.
- **Rationale.** The address *is* the identity; surfacing a truncated mono address as the handle and
  always pairing it with the (non-unique) display name is the only collision-safe way to clone
  Twitter's name/handle pair.

---

## D7 — Login = Cardano wallet (CIP-30) + derived sr25519 + CIP-8 bind; "verified" dropped

- **Twitter.** Email/username + password (or OAuth); "Log in" / "Sign up"; verified badges.
- **cogno-chain reality.** Authentication is a **three-step Cardano flow** (all on `/welcome`):
  1. **Connect a CIP-30 Cardano wallet** (in-browser: Eternl/Nami/Lace/Flint/Yoroi via MeshJS).
  2. **Derive an sr25519 posting key** deterministically from a CIP-8 wallet signature — **nothing is
     stored** (the key is re-derived from the wallet on demand; `useSigner`).
  3. **Bind identity** with `CognoGate.link_identity_signed(cose_sign1, cose_key, thread_pointer?)`
     — a **FEELESS UNSIGNED BARE** tx (PAPI `tx.getBareTx()` + `client.submit()`; no fee, no nonce);
     the **CIP-8 proof itself is the authorization**. Optionally bind a **stake credential** with
     `CognoGate.link_stake_signed(...)` (also feeless bare) to gain **voting power** (D2/D4 weight).
  - **Posting is identity-gated:** `post_message` (and the other feeless actions) require the derived
    account to be **identity-bound**; an unbound account's actions are rejected.
- **Chosen UX.**
  - **ConnectWalletButton** replaces Twitter's "Log in / Sign up." `/welcome` walks the three steps
    with a progress indicator: *Connect wallet → Create posting key → Confirm identity* (and an
    optional fourth: *Enable voting (stake)*). Each step is plain and Twitter-clean — **no honesty
    badges, no "trusted follower" copy, no block numbers**.
  - The **"verified" concept is dropped entirely** (honesty layer removed): no checkmarks, no "this
    account is verified", no trust marginalia anywhere in the app.
  - **Gating UX (identity-bound):** when a connected user who is **not identity-bound** attempts a
    feeless action (post/like/repost/etc.), route them to **finish onboarding** rather than failing
    silently — e.g. the Composer Post CTA shows *"Confirm your identity to post"* and links to the
    bind step. The `not-identity-bound` state is a **first-class state** on every write surface.
  - **Stake/voting is optional:** a user can post, reply, repost, follow, and create polls while
    only identity-bound (weight 0). Voting and poll-voting still **work** at weight 0 (the vote
    records with zero weight) but contribute nothing to score — the UI MAY nudge *"Enable voting to
    make your likes count"* (links to the stake bind in Settings). Do **not** hard-block voting on
    stake.
  - **Settings** silently holds the endpoint URL, wallet/identity status, and the stake bind — **not**
    framed as honesty, just configuration.
- **Rationale.** The chain's only auth is the Cardano-proof bind; we present it as a clean
  "connect → confirm" onboarding and drop "verified" because the whole trust framing is gone.

> **States for every write surface:** `not-connected` (no CIP-30 wallet) → ConnectWalletButton ·
> `connected-not-bound` (no identity) → "Confirm your identity" CTA · `bound-no-stake` (weight 0) →
> works, optional stake nudge · `bound-staked` → full weight. (Also see D5 for `rate-limited`.)

---

## D8 — Static export / no server: search & pagination need an indexer; deep links via SPA fallback

- **Twitter.** Server-rendered, infinite scroll with cursor pagination, full-text search, server
  routing for every deep link.
- **cogno-chain reality.** The frontend is a **Next.js static export** (`output: 'export'`,
  `app/out/` rsynced to nginx) — **no Node server, no SSR, no API routes** at runtime. There are two
  read paths behind the **FeedSource** seam (`lib/feed/source.ts`):
  - **`graphql`** (SubQuery indexer; **OPTIONAL**, URL configured in Settings) — gives **full caps**:
    `{ search: true, pagination: true, threads: true, revocation: true }`.
  - **`papi`** (direct chain RPC over a single WS) — the **always-available fallback** with **reduced
    caps**: `{ search: false, pagination: false, threads: limited, revocation: limited }`.
    `makeFeedSource(api, graphqlUrl)` picks `graphql` when a URL is set, else `papi`.
- **Chosen UX.**
  - **Capability-gated features.** Every search/pagination/thread surface MUST read `FeedSource.caps`
    and degrade gracefully when on the **papi** path:
    - **SearchBar / ExploreList:** when `caps.search === false`, **hide the search box** (or show it
      disabled with helper text *"Search needs an indexer — set one in Settings"*). Do not render a
      broken search.
    - **Pagination / infinite scroll:** when `caps.pagination === false`, show a **bounded recent
      window** (e.g. latest N via `watch()`) with **no "load more"**; show an EmptyState footer
      *"Showing recent posts. Configure an indexer for full history."*
    - **Threads:** `ThreadView` uses the indexer's `replies` relation when available; on papi, show
      the post plus directly-fetchable replies and note partial threading.
  - **Static dynamic routes.** `/post/[id]` and `/u/[address]` are **dynamic** but there is no
    server: configure Next static export so these resolve as a **client-rendered SPA**. **nginx
    `try_files $uri $uri/ /404.html;`** is the expected SPA fallback so a hard-load / refresh of a
    deep link serves the app shell, which then reads the `[id]`/`[address]` param client-side and
    fetches via FeedSource. (The IA doc, `01-information-architecture.md`, owns the exact
    static-export route strategy — **this doc only states the constraint**: deep links MUST work on
    hard refresh via the SPA fallback.)
  - **Share-link** (PostCardActions) copies the canonical `/post/[id]` URL — which must survive a cold
    load via the fallback above.
  - **No build-time data.** Because there is no SSR/ISR, **never** assume server data at build; all
    feed/profile/thread data is fetched **client-side** at runtime from the configured WS/indexer.
- **Rationale.** A static SPA on nginx has no server to paginate or full-text-search, so those
  features are honestly **indexer-gated**, and deep links only work via the SPA fallback — the UI must
  declare both rather than silently break.

> **Cap matrix (cross-ref `04-data-layer.md`):**
> | Feature | `graphql` caps | `papi` caps | UX when unavailable |
> |---|---|---|---|
> | Global search | ✔ | ✗ hidden | SearchBar hidden/disabled + hint |
> | Pagination / load-more | ✔ | ✗ bounded window | "recent only" EmptyState footer |
> | Full threads | ✔ | partial | partial-thread note |
> | Revocation surfacing (banned) | ✔ | partial | best-effort dim (D10) |

---

## D9 — Profiles are **fee-bearing** while posting is feeless

- **Twitter.** Editing your profile is free.
- **cogno-chain reality.** `Profile.set_profile`, `Profile.clear_profile`, `Profile.pin_post`,
  `Profile.unpin_post` are **FEE-BEARING, signed** extrinsics (a tiny tx fee, anti-spam) — they are
  **NOT feeless** and **NOT capacity-metered**. They require the **derived posting account to hold a
  small balance** to pay the fee. (Contrast: posts/votes/reposts/follows/polls are feeless.)
  Identity/stake binds are feeless unsigned; profile edits are the **one routine fee-bearing action**.
- **Chosen UX.**
  - **EditProfileModal** (display name ≤ 64 B, bio ≤ 256 B, avatar URL ≤ 128 B) and **pin/unpin** are
    presented exactly like Twitter's edit-profile / pin flows — but the submit path is a **signed,
    fee-bearing** tx, so handle the **insufficient-balance** case explicitly:
    - Pre-flight: if the derived account balance can't cover the estimated fee, show an inline notice
      in the modal: *"Editing your profile needs a small network fee. Fund your posting account to
      continue,"* with a short explainer in Settings on how the account is funded.
    - **Funding handling (document one of, pick per `12-surface-settings.md`):** (a) the user sends a
      small amount to the derived ss58 from any source they control, surfaced in Settings as the
      account address + balance; or (b) an operator faucet/sponsor tops up trivial amounts on the
      testnet. **This doc requires that the EditProfileModal and pin actions surface a clear "needs a
      small fee / fund your account" state** — the exact funding mechanism is owned by the
      settings doc (cross-ref `12-surface-settings.md`).
  - **Do NOT** apply the **RateLimitNotice** (D5) to profile/pin failures — an insufficient-balance
    failure is a **funding** problem, not a rate limit. Use a distinct, accurate message.
  - **Optimistic UI** still applies to profile edits (name/avatar update immediately, reconcile on
    finalize, roll back + toast on failure). **pinnedPostId is not validated on-chain** — the UI may
    pin any id; show the pinned post if it resolves, otherwise hide the pin silently.
- **Rationale.** Profile/pin edits are the only fee-bearing routine action; conflating their
  balance-gated failure with the feeless rate limit (D5) would mislead the user, so they get their own
  "fund your account" state.

---

## D10 — Moderation = **revoke → banned** (posts remain, author dimmed), **never delete**

- **Twitter.** Tweets can be **deleted** (by author or moderation) and **vanish**; accounts can be
  **suspended**.
- **cogno-chain reality.** **There is no delete.** Content is **permanent** — `delete_post` was
  removed; there is **no soft-delete** and **no `Post.deleted` field** (it was REMOVED). The only
  moderation primitive is **revoke**: `Revoked{who,identity}` flips the indexer
  **`Author.banned = true`**. **A banned author's posts REMAIN** in the chain and the feed; only the
  *author* is flagged.
- **Chosen UX.**
  - **Never delete from the UI; never offer a Delete action** in PostCardActions or anywhere. (Twitter's
    "Delete" overflow item is omitted.)
  - **Banned author = dimmed, not removed.** When `Author.banned === true`, render their PostCards
    **dimmed** (reduced opacity / `--cg-text-muted` name) with a small, neutral note (e.g. *"This
    account has been restricted"*) — but **keep the post content visible and the post in the
    timeline/thread**. Do not collapse, hide, or tombstone the content.
  - The author's **ProfileHeader** for a banned account shows the same neutral "restricted" note;
    their existing posts/replies/likes tabs still populate.
  - **KNOWN BUG TO FIX (data layer):** any existing/legacy FE GraphQL query that references
    **`Post.deleted`** (e.g. `filter: { deleted: { equalTo: false } }`) is **WRONG and must be
    removed** — the field does not exist. **Nothing is ever deleted**; only authors get `banned`.
    Every `deleted` reference in queries/types/components MUST be stripped (cross-ref
    `04-data-layer.md`).
  - **Capability note:** on the **papi** fallback path, `banned` surfacing is best-effort
    (`caps.revocation` partial, D8) — dim when known, otherwise render normally; never block on it.
- **Rationale.** The chain keeps content permanent and only flags authors, so the only faithful UX is
  to dim the banned author while preserving the (immutable) posts — and to purge the dead `deleted`
  field that no longer exists.

---

## D11 — Optimistic UI & confirmation model (no block-number marginalia)

- **Twitter.** Actions feel instant (optimistic), then quietly reconcile; failures toast.
- **cogno-chain reality.** Writes go through a **submit lifecycle** (`lib/chain/post.ts`:
  signing → broadcast → `inBestBlock` → `finalized`). Feeless actions can be **rejected at the pool**
  (capacity D5, or malformed). New post ids arrive in the **`PostCreated`** event. Finalization takes
  a few seconds (Aura/GRANDPA), but the user must **not** be shown block numbers, "best block vs
  finalized", or any chain marginalia (honesty layer dropped).
- **Chosen UX.**
  - **Render optimistically.** On submit, immediately show the post/like/repost/vote in the UI in an
    **optimistic-pending** state (subtle: a faint pending tint or a tiny spinner on the affected
    control — **not** a "pending finalization" label). Reconcile to **success** silently when the
    event/finalization confirms; on the post path, swap the optimistic placeholder for the real
    record once `PostCreated` yields the id.
  - **Roll back on failure.** On pool rejection or tx error, **revert** the optimistic change and show
    a **Toast**: rate-limit copy for capacity (D5), funding copy for fee-bearing (D9), or a generic
    *"Something went wrong. Try again."* otherwise.
  - **No block numbers, no "finalized" chips, no anchor status, no "evidence" copy** anywhere in the
    feed/compose/profile surfaces. (The Toaster/Toast and Spinner/Skeleton components carry all
    transient feedback.)
  - **Idempotency-aware:** reposts (D3) and votes (D2 replace) must reconcile against the chain's
    `AlreadyReposted` / replace semantics without double-applying optimistic state.
- **Rationale.** Optimistic-render-then-reconcile is exactly Twitter's feel; surfacing the chain's
  block lifecycle would reintroduce the very honesty marginalia the product decision removed.

---

## D12 — Counts & weights vocabulary (what number goes where)

- **Twitter.** Reply / Retweet / Like / View counts are simple integers under each tweet.
- **cogno-chain reality.** The indexer exposes both **voter counts** and **stake weights**:
  `Post.upCount`/`downCount` (Int voters), `Post.upWeight`/`downWeight`/`score` (BigInt weight),
  `Post.repostCount` (Int, permanent), plus reply counts via the `replies` relation.
- **Chosen UX (binding mapping — every doc uses these):**
  - **Heart (Like) inline count = `upCount`** (number of likers). Weight is **not** shown inline.
  - **Repost inline count = `repostCount`** (permanent, monotonic).
  - **Reply inline count** = count of `replies` (top-level replies to this post).
  - **Downvote count = `downCount`**, shown **only** in the "…" overflow context and on detail — not
    as a primary timeline number.
  - **Weighted `score` and the `upWeight`/`downWeight` split** appear **only on `/post/[id]`** detail.
  - **BigInt safety:** `weight`/`score`/`upWeight`/`downWeight` are **BigInt** (the chain uses u128
    lovelace-scale numbers > 2^53). The UI MUST treat them as **BigInt/string**, never coerce to JS
    `Number`, and format with a compact helper (e.g. `1.2M`) for display. `score` **may be negative**
    — render a leading sign and handle the negative case.
  - **No "View" / impression counts** exist on-chain — **omit** Twitter's view-count entirely.
- **Rationale.** The chain distinguishes voter-count from stake-weight; pinning each number to one
  place keeps the timeline Twitter-clean while making the weighted reality legible exactly where it
  matters (detail), and BigInt handling prevents silent precision loss.

---

## Consolidated hard-constraints table (quick reference)

| Constraint | Exact value / rule | Source | Doc |
|---|---|---|---|
| Post body length | **512 BYTES UTF-8** (`MaxLength`); counted as bytes | runtime `ConstU32<512>` | D1 |
| Poll options | **2..=4** options (`MaxPollOptions=4`), each **≤ 80 bytes** (`MaxPollOptionLen=80`) | runtime | D4 |
| Poll question | reuses 512-byte body | runtime | D4 |
| Poll expiry | **none** ("Open" forever) | chain | D4 |
| Profile display name | ≤ **64 bytes** (`MaxName`), non-unique | Profile pallet | D6/D9 |
| Profile bio | ≤ **256 bytes** (`MaxBio`) | Profile pallet | D9 |
| Profile avatar | ≤ **128 bytes** (`MaxAvatar`), a **URL/CID**, not bytes | Profile pallet | D1/D9 |
| Like model | stake-weighted **Up** vote = heart; Down = secondary; `score` signed | `VoteDir` | D2/D12 |
| Repost | **permanent**, no undo, `AlreadyReposted` on dup | chain | D3 |
| Feeless actions | post/quote/vote/clear_vote/repost/follow/unfollow/poll/poll-vote | cost model | D5 |
| Fee-bearing actions | `set_profile`/`clear_profile`/`pin_post`/`unpin_post` | Profile pallet | D9 |
| Capacity costs | Base 50M (1 post), PerByte 50k, Vote/Repost 20M, Follow 10M | runtime | D5 |
| Capacity exhaustion | pool-rejected by `CheckCapacity` → **RateLimitNotice** (no battery) | tx extension | D5 |
| Handle | truncated **ss58** (prefix **42**), mono; no unique usernames | chain | D6 |
| Identity | ss58 account, 1:1 bind via `link_identity_signed` (feeless bare) | CognoGate | D7 |
| Voting power | from `link_stake_signed` (feeless bare); 0 until staked | CognoGate | D2/D7 |
| Moderation | revoke → `Author.banned`; **posts remain**; no delete; **no `Post.deleted`** | chain/indexer | D10 |
| Read paths | `graphql` (indexer, full caps) vs `papi` (fallback, no search/pagination) | FeedSource | D8 |
| Deploy | static export → nginx; SPA `try_files … /404.html` for deep links | infra | D8 |
| Honesty layer | **dropped** — no badges/verified/block numbers/trust copy | product | D7/D11 |
| Confirmation | optimistic render → reconcile → rollback+toast | submit lifecycle | D11 |
| BigInt fields | weight/score/upWeight/downWeight are **BigInt**, may be negative | indexer | D12 |

---

## Cross-references (what this doc assumes from siblings)

- **`01-information-architecture.md`** — owns the canonical routes and the **static-export
  dynamic-route strategy** + nginx SPA fallback (this doc only states the *constraint* in D8).
- **`02-design-system.md`** — owns the `--cg-*` tokens this doc references by name (`--cg-like`,
  `--cg-repost`, `--cg-danger`, `--cg-text-muted`, etc.) and the dark-first/light theming.
- **`03-component-library.md`** — owns the canonical component behaviors (ByteCounter, RateLimitNotice,
  PollCard, PostCardActions, Handle, Avatar, EditProfileModal, Toaster, …) that implement these rules.
- **`04-data-layer.md`** — owns the exact GraphQL queries, the FeedSource/FeedCaps seam, the BigInt
  handling, and **must remove every `Post.deleted` reference** (D10) and use
  `outgoingFollows`/`incomingFollows` (not `following`/`followers`).
- **`11-surface-onboarding-auth.md`** — owns the **wallet → derive → bind** flow (D7); and
  **`12-surface-settings.md`** owns the **endpoint/indexer-URL** config (D8) and the
  **posting-account funding** mechanism for fee-bearing profile edits (D9).
- **Per-surface docs** (home/explore/profile/thread/compose) — each leaves a labeled **notifications
  hook** (deferred) per the global decision; this doc records that reply/vote/repost/follow/quote
  targeting you are the clean follow-up driven by indexer events.

---

## Implementation checklist (ordered)

A dev wiring constraints across the app can execute these in order; most are *enforcement points* the
other docs' components must honor.

- [ ] **D1** Implement **ByteCounter** to count **UTF-8 bytes** (`TextEncoder().encode().length`),
      cap at **512** for posts/quotes/questions and **80** for poll options; disable the Post CTA at
      `> limit`.
- [ ] **D1** Build the **Composer with NO media buttons**; render **PostBody** with **URL auto-link
      only** (no unfurl, no media); make **Avatar** a URL field + identicon fallback; **omit the
      profile "Media" tab**.
- [ ] **D2** Wire the **heart → `vote(id,{type:'Up'})` / `clear_vote(id)`**; inline count = **`upCount`**;
      put **Downvote** in the **"…" overflow**; show **`score` + weights only on `/post/[id]`**; allow
      self-like.
- [ ] **D3** Repost menu = **Repost / Quote only**; add the **"permanent, cannot be undone" confirm
      dialog**; filled terminal state; **never** offer un-repost; disable Repost on
      already-reposted.
- [ ] **D4** **PollComposer** = 2–4 options (≤ 80 B each), **no duration picker**; **PollCard** shows
      **% by weight** + raw count + static **"Open"** pill; recast via `cast_poll_vote` moves weight.
- [ ] **D5** Add **RateLimitNotice**; map **`CheckCapacity` pool rejection → rate-limit copy**;
      **remove any battery/capacity meter**; optional pre-flight CTA disable via `useCapacity`.
- [ ] **D6** Build **Handle** (truncated ss58, mono, copy-on-click) + **DisplayName** (fallback to
      handle) + **Avatar** identicon; route profiles by **`/u/[address]`**; **no verified badge**;
      search post text, not handles.
- [ ] **D7** Implement `/welcome` **connect → derive → bind** (feeless **bare** `link_identity_signed`,
      optional `link_stake_signed`); add the **`not-identity-bound`** gate state to every write
      surface; **drop "verified"**; keep voting allowed at weight 0.
- [ ] **D8** Read **`FeedSource.caps`** everywhere; **hide search & load-more** on the `papi` path
      with hints; confirm `/post/[id]` & `/u/[address]` **survive hard refresh** via nginx
      `try_files … /404.html`.
- [ ] **D9** Treat **profile/pin as fee-bearing**: add an **insufficient-balance / fund-your-account**
      state to **EditProfileModal** + pin actions; **do not** show RateLimitNotice for these; surface
      the derived account address + balance in Settings.
- [ ] **D10** **Remove all `Post.deleted` references** from queries/types/UI; never render a Delete
      action; **dim banned authors** (`Author.banned`) while keeping their posts visible.
- [ ] **D11** Apply **optimistic render → silent reconcile → rollback+toast** to all writes; **no
      block numbers / finalized chips / honesty marginalia**; reconcile against
      `AlreadyReposted`/vote-replace idempotency.
- [ ] **D12** Lock the **count/weight mapping** (`upCount` by heart, `repostCount`, reply count,
      `downCount` in overflow/detail, `score`+weights on detail); handle all weight fields as
      **BigInt** (may be negative); **omit view counts**.
- [ ] **Audit pass:** grep the app for `deleted`, `battery`/`capacity meter`, `verified`/`badge`,
      block-number/anchor honesty copy, `value.length` byte-counting, and per-post fee assumptions —
      each is a divergence violation to fix against this registry.
