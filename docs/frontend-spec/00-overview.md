# 00 — Overview, Vision & Scope

**The cogno-chain frontend is being re-skinned into a faithful Twitter/X clone.** Same dense
single-column timeline, the same pill buttons, the same three-column desktop / bottom-tab mobile
shell, the same compose-and-reply rhythm, the same heart/repost/reply/share action row — but
wearing the **cogno-chain** name, **cogno teal/verdigris** accent (replacing Twitter's blue),
and a **dark-first** theme. Underneath it is the existing feeless app-chain: every social action
is a real extrinsic, posts are 512-byte UTF-8 text, "Like" is a stake-weighted on-chain upvote,
"Repost" is permanent, posting is metered by a regenerating talk-capacity instead of fees, and
login is a Cardano wallet's CIP-8 signature. This document is the **north star and orientation
map** for the thirteen specification docs that follow — read it first, then go to the doc for the
surface you are building.

> **One-line mandate:** clone X's UI exactly; back every pixel with the chain we already have; drop
> every "honesty"/trust label; make it feel like Twitter, not like a blockchain explorer.

---

## 1. The pivot: from "Reading Room" to Twitter mimicry

The frontend that exists today (`app/`) is the **"Reading Room / Civic Ledger"** design. It is a
calm, paper-and-ink, serif long-form reading surface whose entire thesis is *honesty about trust*:
it deliberately **surfaces** the chain's limitations on screen. Concretely, today's app ships:

- a paper/ink **serif** body type, verdigris-barely-used, light-default `tokens.css`
  (`--surface-0`, `--ink-900`, `--font-serif`, etc. — note: **not** the `--cg-*` prefix this spec
  introduces);
- **`HonestyBadge`** chips (`chain: operator-run (v1)`, `follower: trusted (v1)`,
  `capacity: follower-metered (v1)`, `anchor: evidence, not enforcement`);
- a **`ProvenanceLine`** under posts (block number, ss58, "signed ≠ finalized" marginalia);
- a **`CapacityBattery`** widget that renders talk-capacity as charged/empty segments;
- an **`AnchorStatus`** panel exposing the Cardano anchor checkpoint as user-facing UI;
- a **`Masthead`** + single-column "feed" framed as a civic reading room, not a social timeline.

**We are pivoting away from all of that.** The design decisions locked by the user on 2026-06-21
are unambiguous, and this spec encodes them. Concretely, the pivot means:

| Reading Room (today) | Twitter clone (this spec) |
|---|---|
| Calm serif paper/ink, light-default | **Dark-first**, X's near-black; Twitter's 15px system-UI sans, hairline dividers, hover-row highlight |
| Honesty badges on screen | **No honesty layer at all** — no badges, no "signed ≠ finalized", no "operator-run"/"trusted follower" labels, no anchor UI |
| `CapacityBattery` segments | Talk-capacity is **invisible until exhausted**, then a Twitter-style **`RateLimitNotice`** ("You are over the rate limit, try again shortly") |
| `ProvenanceLine` (block #, marginalia) | **Gone.** No block-number marginalia; a post is just a post |
| `AnchorStatus` panel | **Gone** from the UI (the anchor still runs server-side; it is simply not a surface) |
| Honest "submitted ≠ confirmed" copy | **Optimistic UI**: the post/like/repost appears instantly, reconciles on confirmation, rolls back on failure with a quiet toast |
| `--surface-*` / `--ink-*` / serif tokens | **`--cg-*`** token system (see `02-design-system.md`), Twitter geometry (pill `--cg-radius-pill`, card radius), cogno accent replaces `#1d9bf0` |
| Endpoints framed as honest disclosure | Endpoints + wallet/identity config live **silently in Settings**, not framed as trust disclosure |

**What we keep.** The pivot is a re-skin of the *presentation*, not a rewrite of the *data layer*.
The existing seam stays and is **extended, not thrown away**:

- The chain client / PAPI layer (`lib/chain/*`, `lib/signer/*`, `lib/cardano/*`) is reused as-is.
- The **`FeedSource`** seam (`lib/feed/source.ts`) — `{ kind:'papi'|'graphql', caps, watch(), page(),
  thread(), profile() }` and `makeFeedSource(api, graphqlUrl)` — is the read abstraction every
  new surface binds to. It is **extended** with the social entities (votes, reposts, follows,
  polls, profiles) the new surfaces need; the PAPI-direct fallback remains the always-available
  reader and the GraphQL indexer remains the full-capability reader.
- The dual-key model (Cardano CIP-30 wallet → derive sr25519 posting key, never stored) is the
  login mechanic; it is simply **re-presented** as "Connect wallet" onboarding instead of a
  dual-key explainer.

> **One concrete cleanup the pivot forces:** the current GraphQL queries (`lib/graphql/queries.ts`)
> and `CognoPost`/`ProfileView` types still reference a **`deleted`** field and soft-delete /
> tombstone semantics. **That field was removed** — content is permanent, nothing is ever deleted,
> only authors get **`banned`** (after `Revoked`). Every `deleted` reference and every
> `deleted:{equalTo:false}` filter must be removed wherever the new surfaces touch the data layer.
> See `04-data-layer.md` for the corrected query set. (Also note the stale `spec_version 107`
> comment in `lib/types.ts` — the live runtime is **spec 116**; descriptors must be regenerated.)

---

## 2. Feature-mapping: Twitter feature → cogno-chain capability that backs it

Every Twitter affordance we clone is backed by a **real, already-shipped** on-chain capability.
This is the table that proves the clone is honest underneath even though the UI hides the chain.
Exact extrinsic signatures and arg shapes are in the SHARED GROUNDING block and re-stated per
surface doc; this is the orientation cross-walk.

| Twitter / X feature | cogno-chain capability backing it | Extrinsic / mechanism | Notes / divergence |
|---|---|---|---|
| **Tweet** (post) | a microblog post | `Microblog(10).post_message(text, parent=None)` — **FEELESS** | text is **≤ 512 BYTES UTF-8**, not 280 chars; **text only**, no media |
| **Reply** | a post with a parent | `Microblog(10).post_message(text, parent=Some(id))` — FEELESS | builds the `ThreadView`; `parent` = the post replied to |
| **Quote tweet** | a quote post | `Microblog(10).quote_post(text, quoted_id)` — FEELESS | renders as a normal feed post with a `QuotedPostEmbed` of `quoted_id` |
| **Like** (the heart) | a stake-**weighted UP vote** | `Microblog(10).vote(post_id, dir=Up)` — FEELESS | the heart **is** the upvote; re-liking replaces; weight = caller's `VotingPower`. Un-like = `clear_vote(post_id)` |
| **(no native X equiv.)** down-vote | a stake-weighted DOWN vote | `Microblog(10).vote(post_id, dir=Down)` — FEELESS | a **secondary** action (in the "…" overflow); weighted score shown on post-detail |
| **Retweet** | a **permanent** Repost | `Microblog(10).repost(post_id)` — FEELESS | **no un-repost** (permanent); a duplicate → `AlreadyReposted` (UI disables after) |
| **Follow / Unfollow** | a live follow edge | `Microblog(10).follow(target)` / `unfollow(target)` — FEELESS | toggle; `target` is an **AccountId** (ss58), not existence-checked |
| **Poll** | an on-chain poll | `Microblog(10).create_poll(question, options)` — FEELESS | **2..=4** options, each **≤ 80 bytes**; question reuses 512 B; **NO on-chain expiry** (polls never close) |
| **Poll vote** | a stake-weighted poll vote | `Microblog(10).cast_poll_vote(post_id, option)` — FEELESS | 0-indexed option; re-cast replaces |
| **Profile** (name, bio, avatar) | `pallet-profile` | `Profile(17).set_profile(display_name, bio, avatar)` — **FEE-BEARING** | name ≤ 64 B, bio ≤ 256 B, avatar = a **URL/IPFS CID** ≤ 128 B (a reference, **not** image bytes) |
| **Pinned tweet** | profile pin | `Profile(17).pin_post(id)` / `unpin_post()` — FEE-BEARING | pinned id **not validated on-chain**; FE must sanity-check it resolves |
| **Display name + @handle** | `Profile.display_name` + ss58 | (read) | display name is **non-unique** (fallback to truncated address); the **"@handle" is the truncated ss58** in mono — there are **no unique usernames** on-chain |
| **Avatar image** | `Profile.avatar` URL | (read) | a URL/CID; fallback to a **deterministic identicon/blockie** derived from the address |
| **Log in / Sign up** | Cardano **CIP-8 wallet bind** | `CognoGate(8).link_identity_signed(cose_sign1, cose_key, thread_pointer)` — FEELESS **unsigned bare** tx | "Connect wallet → derive posting key → bind identity" is the whole auth flow; the CIP-8 proof **is** the authorization |
| **(enables vote weight)** | bind stake credential | `CognoGate(8).link_stake_signed(cose_sign1, cose_key)` — FEELESS unsigned bare | optional; account must already be identity-bound; gives Likes/poll-votes their **weight** |
| **Rate limit** ("You are over the rate limit") | regenerating **talk-capacity** | `CheckCapacity` tx extension rejects at the pool when capacity is empty | capacity is **never** shown as a meter; only surfaces as a Twitter-style `RateLimitNotice` when exhausted |
| **Timeline / "For you" / "Following"** | the feed read | `FeedSource.watch()` / `.page()` (GraphQL indexer or PAPI-direct) | "For you" = global newest-first; "Following" = filtered to followed accounts (indexer-backed) |
| **Search** | indexer substring search | `Post.text:{ includesInsensitive: "…" }` | **indexer-only** (`caps.search`); PAPI-direct path has no search → search UI gated off |
| **Share link** | client-side copy of `/post/[id]` | (no chain call) | copies the canonical URL; no native sharing/embeds |

---

## 3. Twitter features we DEFER or OMIT (and why)

We are cloning **chain-backed surfaces only.** Everything below is explicitly out of scope for this
spec. Do **not** design these surfaces. Notifications are *deferred with a hook*, not omitted —
each relevant surface doc leaves a clearly-labeled note about which indexer events make it a clean
follow-up.

| Twitter / X feature | Decision | Reason |
|---|---|---|
| **Direct Messages (DMs)** | OMIT | no private-messaging primitive on-chain; all content is public and permanent |
| **Lists** | OMIT | no on-chain list/group primitive; would be pure client state with no chain backing |
| **Trends / Topics / "What's happening"** | OMIT | no trending/topic computation; the `RightRail` shows search + who-to-follow instead, not Trends |
| **In-post media** (image / video / GIF upload) | OMIT | posts are **text-only ≤ 512 bytes**; there is no media storage and `avatar` is a URL reference, not bytes. URLs in post text are auto-linked (`PostBody`), nothing is embedded/uploaded |
| **Bookmarks** | OMIT (FE-only later) | no on-chain bookmark primitive; if ever added it is pure local/client state, not a chain surface |
| **Monetization** (subscriptions, tips, ads, verification badges) | OMIT | out of product scope; no payment surface (the chain is feeless; tips were deferred at the pallet level) |
| **Notifications** | **DEFER (with hook)** | the data exists — reply/vote/repost/follow/quote events targeting you are decodable from the indexer (`Voted`, `Reposted`, `Followed`, `PostCreated` with `parent`/`quote` = your post). We do **not** author a full Notifications surface now; each relevant doc leaves a labeled "Notifications hook" note so it is a clean follow-up |
| **Spaces / audio, Communities, Moments, Grok, etc.** | OMIT | no backing capability; far out of scope |
| **Edit tweet** | OMIT | content is **permanent and immutable** on-chain; no edit/delete. (Profiles *can* be edited; posts cannot) |
| **Block / Mute** | OMIT (FE-only later) | no on-chain block/mute; `banned` is an author-level revocation flag set on-chain, not a per-user mute. Posts by a `banned` author are **flagged, not hidden** |

---

## 4. Scope — what's IN and what's OUT

**IN (design these surfaces):**

- **Home timeline** — `/` — "For you" / "Following" tabs (`Timeline`, `TimelineTabs`).
- **Explore + global search** — `/explore` (`ExploreList`, `SearchBar`).
- **Profile** — `/u/[address]` (`ProfileHeader`, `ProfileTabs` = Posts / Replies / Likes).
- **Thread / post detail** — `/post/[id]` (`ThreadView`, weighted score shown here).
- **Compose** — `/compose` (also a `ComposerModal` overlay) incl. replies, quotes, polls
  (`Composer`, `ReplyComposer`, `QuoteComposer`, `PollComposer`, `ByteCounter`).
- **Follows** — follow/unfollow buttons + follower/following counts (`FollowButton`).
- **Votes / reposts / quotes** — the `PostCardActions` row + the secondary down-vote.
- **Onboarding / auth** — `/welcome` (connect wallet → derive posting key → bind identity).
- **Settings** — `/settings` (endpoints, theme, wallet/identity, profile edit, vault/stake).

**OUT (do NOT design):** DMs, Lists, Trends/Topics, in-post media uploads, bookmarks, monetization
(see §3). **Notifications are DEFERRED** (hook only, not a surface). Also out of frontend scope:
the node/runtime/pallets, the follower/relayer/committee/indexer services, the L1 Aiken contract —
these are upstream and the FE only *reads/writes* through them.

---

## 5. Doc map — the 13 specs + this index

This `00-overview.md` is the orientation doc. The remaining docs each own one slice; build the
surface you are assigned from its doc, using the canonical vocabulary, and cross-reference siblings
by filename. (Exact filenames are owned by the index; the slices below are the authoritative
division of labor.)

| Doc | Owns |
|---|---|
| **`00-overview.md`** (this) | Vision, the Reading-Room→Twitter pivot, the feature-mapping + defer tables, in/out scope, the doc map, the guiding principles. The doc a newcomer reads first. |
| **`01-information-architecture.md`** | The route table (`/`, `/explore`, `/post/[id]`, `/u/[address]`, `/compose`, `/settings`, `/welcome`), the **static-export dynamic-route strategy** (how `[id]`/`[address]` resolve as a static SPA on nginx with `try_files` SPA fallback — no server), navigation model, deep-linking, URL/state contract. |
| **`02-design-system.md`** | The **`--cg-*`** token system (color/geometry/type/z), dark + light themes via `[data-theme]`, the cogno accent replacing `#1d9bf0`, the Twitter type scale (15px base), pill/card radii, CSS-Modules conventions, `ThemeToggle`. **Source of truth for every token name.** |
| **`03-component-library.md`** | The shared component kit: `AppShell`/`LeftNav`/`BottomTabBar`/`RightRail` + the sticky blurred header (the app-shell navigation chrome lives at **§22.7**), `PostCard`/`PostCardHeader`/`PostBody`/`PostCardActions`/`QuotedPostEmbed`/`Avatar`/`DisplayName`/`Handle`, the composer family, `ByteCounter`, `Toaster`/`Toast`, skeletons, the optimistic action states. |
| **`04-data-layer.md`** | The extended `FeedSource` seam + `FeedCaps`, the corrected GraphQL queries (with `deleted` removed), the PAPI-direct fallback, the exact entity bindings (Author/Post/Vote/Repost/Follow/Poll/PollOption/PollVote/Thread), optimistic-update + reconcile/rollback mechanics, capacity-as-rate-limit detection. |
| **`05-divergences-and-constraints.md`** | The canonical divergence + constraints reference: text-only 512 B, weighted likes, permanent reposts, no-expiry polls, capacity-as-ratelimit, ss58-as-handle, no media, banned-not-hidden, static export — the shared substrate every surface honors. |
| **`06-surface-home.md`** | Home `/` — `Timeline`, `TimelineTabs` (For you / Following), feed paging + live update, skeleton/empty/error states, `j`/`k` keyboard nav, `n`=new post. |
| **`07-surface-profile.md`** | `/u/[address]` — `ProfileHeader`, `ProfileTabs` (Posts / Replies / Likes — **no Media tab**, note why), `FollowButton`, follower/following counts, pinned post, `banned`-author treatment (flag not hide), `EditProfileModal`. |
| **`08-surface-thread.md`** | `/post/[id]` — `ThreadView`, the focused post, ancestor + reply rendering, the **weighted up/down score** display (where down-votes surface), reply composer inline. |
| **`09-surface-compose.md`** | `/compose` (also a `ComposerModal` overlay) — `Composer`, `ReplyComposer`, `QuoteComposer`, `PollComposer`, `ByteCounter` (**UTF-8 bytes** ≤ 512 / ≤ 80 / ≤ 64 / ≤ 256), submit lifecycle, optimistic insert, rate-limit handling on submit. |
| **`10-surface-explore-search.md`** | `/explore` — `ExploreList`, `SearchBar`, indexer substring search (`includesInsensitive`), who-to-follow, the `caps.search` gate + the PAPI-direct degraded state. |
| **`11-surface-onboarding-auth.md`** | `/welcome` — `ConnectWalletButton`, the connect-wallet → derive-sr25519-posting-key → CIP-8 `link_identity_signed` bind flow, the optional `link_stake_signed`, the not-connected / not-bound gating that every action respects. |
| **`12-surface-settings.md`** | `/settings` — endpoint config (silent, not honesty-framed), `ThemeToggle`, wallet/identity, `EditProfileModal` entry, the posting-account **funding** gate for the fee-bearing `set_profile`/`pin`, the vault **lock/exit 100 ADA** (`useVault`, Blockfrost) + **stake bind**, the only place chain plumbing is visible. |
| **`README.md` / index** | The frontend-spec index: reading order, the canonical-vocabulary glossary, the cross-reference graph, the pointer to the global divergence list (text-only 512 B, weighted likes, permanent reposts, no-expiry polls, capacity-as-ratelimit, ss58-as-handle, no media, static export). |

> If you are implementing a single doc in isolation: read **this doc** (§2/§3/§6) and
> **`02-design-system.md`** (tokens) and **`04-data-layer.md`** (the data seam) first — they are
> the shared substrate every other doc assumes.

---

## 6. Guiding principles

These four principles are load-bearing. Every surface doc inherits them; when a Twitter pattern and
a chain reality conflict, resolve it by these.

### 6.1 Faithful to X — clone, don't reinvent

We are **cloning** Twitter/X's actual, known design on purpose. Do not invent a "distinctive"
look. Match X: **15px base** type, **9999px pill** buttons (`--cg-radius-pill`), a **dense
single-column** timeline with **hairline dividers** and **hover-row highlight**, **3-column
desktop / collapsed-rail tablet / bottom-tab mobile**, a **sticky header with backdrop blur**,
**action-row icons with hover-tint**, the **compose FAB** on mobile. The *only* sanctioned
divergences from X's visuals are the brand swaps: the **cogno-chain** name/wordmark and the
**cogno teal/verdigris accent** (base ~`#2e7d6b`, refined for AA on dark) wherever Twitter uses its
blue `#1d9bf0` as load-bearing (primary buttons, links, active nav, focus rings, the Like-on-self
tint, the "Post" CTA). Dark-first by default (X's near-black), with a working light theme toggle.
Tokens specify both themes fully (`02-design-system.md`).

### 6.2 Optimistic UI — instant, then reconcile

The chain is real but confirmation is asynchronous, and we are **dropping** all "signed ≠ finalized"
honesty marginalia. The replacement is **optimistic UI**, exactly like Twitter: the post / like /
repost / follow appears **immediately** in the UI, then **reconciles** when the extrinsic confirms
(`inBestBlock` → `finalized`), and **rolls back with a quiet toast** if it fails (`invalid` /
`error`). Counts update optimistically (a Like bumps the heart count instantly). The user never
sees block numbers, tx phases, or "submitted vs finalized" copy. The submit lifecycle in
`lib/chain/post.ts` (`signing → broadcast → inBestBlock → finalized`) drives the reconcile under the
hood, invisibly. The two — and only two — chain realities we *do* surface are: (a) **graceful
rate-limit messaging** when talk-capacity is exhausted, and (b) a **quiet failure toast** on any tx
error/rollback.

### 6.3 Feeless but rate-limited — capacity is invisible until it isn't

Posting/voting/reposting/following/polling are **feeless** — there is no fee UI, no "confirm gas",
no cost shown, ever. They are metered by a regenerating, stake-weighted **talk-capacity**. The user
is **never** shown a capacity meter or battery (that was the Reading Room; it's gone). Capacity is
**invisible until exhausted**: when `CheckCapacity` rejects a feeless extrinsic at the pool, the UI
shows a Twitter-style **`RateLimitNotice`** — *"You are over the rate limit. Try again shortly."* —
and nothing more. Capacity regenerates per block and its ceiling scales with locked-ADA posting
weight, but none of that is FE-visible; only the rate-limit moment is. (Profile edits and pins are
the **only** fee-bearing actions — a tiny anti-spam tx fee — and even there the fee is not framed as
a cost surface.)

### 6.4 Wallet-as-login — the Cardano wallet is the account

There are **no email/password accounts and no unique usernames.** A user's identity **is** their
Cardano wallet: connecting the CIP-30 wallet, deriving the sr25519 posting key from a CIP-8
signature (never stored — re-derived each session by signing again), and submitting the feeless
unsigned **`link_identity_signed`** bind. That CIP-8 proof **is** the authorization — it is the
"Sign up / Log in" step, presented as plain "Connect wallet," not as a dual-key cryptography lesson.
The optional **`link_stake_signed`** bind gives Likes and poll votes their **weight**. Everywhere
in the app, the **"@handle" is the truncated ss58** of the derived posting account (mono, truncated)
and the **display name** is the non-unique `Profile.display_name` (fallback: truncated address);
the **avatar** is `Profile.avatar` (a URL/CID) with a deterministic **identicon/blockie** fallback
from the address. Actions that need an account (post, like, follow, …) gate on "connected +
identity-bound" and prompt the user to `/welcome` if not; reads never require a wallet.

---

## 7. The divergences from X (the canonical list)

Every surface doc must honor these. When chain semantics diverge from Twitter, the chosen UX is
stated here once and re-stated per doc.

1. **Text-only, 512 BYTES (UTF-8), no media.** No image/video/GIF upload; URLs in text are
   auto-linked, not embedded. `ByteCounter` counts **bytes**, not characters.
2. **"Like" = a stake-weighted UP vote** (the heart). Re-liking replaces; un-like is `clear_vote`.
   The **down-vote** is a real, secondary action (in the "…" overflow); the **weighted score**
   (`up − down`, may be negative) shows on **post-detail**, not the timeline row.
3. **Repost is PERMANENT** — no un-repost; the button disables after (`AlreadyReposted`).
4. **Polls never expire** — no on-chain expiry; no countdown timer. 2–4 options, ≤ 80 bytes each.
5. **Capacity-as-rate-limit** — feeless, no meter; `RateLimitNotice` only on exhaustion (§6.3).
6. **ss58-as-handle** — no unique usernames; `@handle` = truncated ss58 mono; display name is
   non-unique. Avatar falls back to an identicon from the address.
7. **Static export** — the app is a Next.js 14 **`output:'export'`** SPA on nginx: **no server, no
   SSR, no API routes.** Dynamic routes (`/post/[id]`, `/u/[address]`) resolve client-side with an
   nginx `try_files` SPA fallback (the strategy is owned by `01-information-architecture.md`).
8. **No honesty layer** — no badges, no provenance line, no anchor UI, no block-number marginalia,
   no trust labels (§1).
9. **Banned authors are flagged, not hidden** — a `Revoked`/`banned` author's posts remain in the
   feed (content is permanent), flagged subtly; nothing is ever deleted.
10. **Notifications deferred** — hook only, no surface (§3).

---

## 8. Implementation checklist (for this orientation doc's consumers)

This doc is orientation, not a build target, but the following are the concrete commitments every
implementer must carry out of it before touching a surface:

- [ ] Read `02-design-system.md` and use **`--cg-*`** tokens exclusively; never the old
      `--surface-*`/`--ink-*`/serif tokens, never a raw hex literal.
- [ ] Read `04-data-layer.md` and bind only to the extended **`FeedSource`** seam (`watch`/`page`/
      `thread`/`profile`) — never a concrete reader at a call site.
- [ ] Strip every **`deleted`** reference / `deleted:{equalTo:false}` filter you encounter in the
      data layer; nothing is ever deleted — authors get **`banned`** and posts are **flagged**.
- [ ] Regenerate PAPI descriptors against the live **spec 116** runtime before relying on
      `lib/types.ts` shapes (the in-file `spec_version 107` comment is stale).
- [ ] Remove / do not render any honesty surface: `HonestyBadge`, `ProvenanceLine`, `AnchorStatus`,
      `CapacityBattery`, the `Masthead` reading-room framing — none of these exist in the clone.
- [ ] Implement every chain-backed action with **optimistic UI** (instant → reconcile → rollback +
      quiet toast); surface **only** the `RateLimitNotice` and the failure `Toast`.
- [ ] Keep all endpoint/wallet/identity plumbing **silent in Settings** — never framed as trust
      disclosure.
- [ ] Use the canonical component names and route names verbatim (§4, §5, and the index) so the
      thirteen docs compose into one app.
- [ ] Honor the §7 divergence list in full on every surface you build, stating the chosen UX where
      chain semantics diverge from X.
- [ ] Leave a labeled **"Notifications hook"** note (which indexer events apply) on any surface
      whose interactions target another user (reply/like/repost/follow/quote).
