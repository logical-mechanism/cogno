# 12 — Surface: Settings (`/settings`)

The **Settings** surface is the cogno-chain X-clone's single "config" home: an X-style sectioned settings list
(left-hand section index → a right-hand sub-panel on desktop; a flat drill-down list on mobile) that exposes every
account / profile / vault / appearance / network knob the rest of the app reads from. It is the **only** place the
user touches configuration, and — per the locked decisions — it is kept **quiet and un-hedged**: no honesty badges,
no "trusted follower" / "operator-run" labels, no "signed ≠ finalized" marginalia, no block-number chrome. Endpoints
are framed as plain settings ("Node", "Indexer", "Cardano provider"), the vault is framed plainly as **posting
power** (never a battery), and the dev-account picker is hidden behind an "Advanced" disclosure. This doc owns the
seven sections — **Account**, **Profile**, **Vault & posting power**, **Appearance**, **Network**, **Advanced
(Developer)**, **About** — their controls, their `localStorage` persistence keys, their validation, their effects
on the live app (e.g. changing the node ws reconnects `useChain`; clearing the indexer URL silently degrades to
PAPI-direct, which hides search/Following/who-to-follow), and every UI state.

> **Sibling docs (cite, don't redefine).** Tokens, components, motion: `02-design-system.md`. Shared component kit
> (`EditProfileModal`, `ThemeToggle`, `Toaster/Toast`, `Spinner/Skeleton`, `EmptyState`, `ConnectWalletButton`,
> `Avatar`, `DisplayName`, `Handle`, `FollowButton`): `03-component-library.md`. Routing, the `AppShell`, the
> sticky-blur header, modal-route host (`/settings/` is the standalone fallback for `EditProfileModal`):
> `01-information-architecture.md`. The data seam, hooks, mutations, query names, capability gating, and the
> session-state machine: `04-data-layer.md`. Divergences (D1–D12): `05-divergences-and-constraints.md`.
>
> **Inherited reality.** Runtime **spec_version 116**. **Next.js 14 static export** (`output:'export'`) — no server,
> no SSR, no API routes; every config read/write is a browser-side `localStorage` + PAPI/Blockfrost call. **CSS
> Modules + `--cg-*` tokens** (no Tailwind). The honesty/trust layer is **dropped** everywhere on this surface.

---

## 0. Purpose, route, and ownership

| Field | Value |
|---|---|
| **Route** | `/settings` (page component `SettingsPage`, per `01-information-architecture.md` route→component map). `/settings/` is also the standalone fallback the `EditProfileModal` overlay degrades to (see `01-information-architecture.md` §7). |
| **Nav entry points** | `LeftNav` "Settings" (gear `IconSettings`), `BottomTabBar` 4th tab (gear), the header avatar drawer "Settings" item (mobile, per `01-information-architecture.md` §6), and any "Open in Settings" deep link from `RateLimitNotice` (`no_weight` copy → vault), the explore "search needs the indexer" `EmptyState`, and the `not-identity-bound` write gates routing to "Finish setup". |
| **Auth** | **Readable by everyone.** Sections that need a connected wallet (Account details, Profile, Vault) show their `disconnected` / `connected_unbound` states inline rather than route-gating the whole page — Settings is where you *go to* connect. |
| **Page kind** | A **Client Component** (`'use client'`), like every page in the static export (`01-information-architecture.md`). No server fetch. |
| **Spec owner** | This doc (`12-surface-settings.md`). It is the Settings authority that `01-information-architecture.md` refers to as the settings owner; it also owns the in-Settings render of `EditProfileModal`'s standalone fallback (the modal itself is specified in `03-component-library.md`). |

### Section inventory (the seven sections, top to bottom)

| # | Section id | Heading | Needs wallet? | Writes |
|---|---|---|:--:|---|
| 1 | `account` | **Account** | shows all session states | none (display + `disconnect`) |
| 2 | `profile` | **Profile** | yes (bound) | `Profile.set_profile` / `Profile.clear_profile` (FEE-BEARING) via `EditProfileModal` |
| 3 | `vault` | **Vault & posting power** | yes (wallet) | Cardano L1 lock/exit (`useVault`); reads on-chain weight |
| 4 | `appearance` | **Appearance** | no | none (theme only) |
| 5 | `network` | **Network** | no | none (endpoint config in `localStorage`) |
| 6 | `advanced` | **Advanced** (Developer) | no | none (dev signer choice) |
| 7 | `about` | **About** | no | none |

> The order is deliberate: the things a real user touches (Account → Profile → Vault → Appearance) come first;
> Network is the "I know what I'm doing" config; Advanced/Developer is collapsed by default and About is the footer.

---

## 1. Layout & wireframes

X renders Settings as a **two-pane master/detail** on desktop (a fixed left section index, a scrolling right detail
panel) and as a **single-column drill-down** on mobile (the section list; tapping a row pushes its panel). We clone
that exactly, re-skinned with `--cg-*` tokens. The `AppShell` chrome (`LeftNav` / `RightRail` / `BottomTabBar`) is
unchanged from `01-information-architecture.md`; only the center column changes. **`RightRail` is suppressed on
`/settings`** (Settings owns the full content width — X does the same), so on desktop the settings master/detail
fills the center + right columns.

### 1.1 Desktop (≥1020px) — master/detail inside the center+right span

```
┌──────────────┬───────────────────────────────────────────────────────────────────────┐
│  LeftNav      │  ┌── sticky header (backdrop-blur) ───────────────────────────────┐    │
│  (275px rail) │  │  Settings                                                       │    │
│               │  └─────────────────────────────────────────────────────────────────┘   │
│  ◈ cogno      │  ┌── section index (master, 290px) ──┐┌── detail panel (scrolls) ──────┐│
│  ⌂ Home       │  │ ▸ Account                  >       ││  Account                       ││
│  🔍 Explore   │  │   Profile                  >       ││  ┌──────────────────────────┐  ││
│  ◎ Profile    │  │   Vault & posting power    >       ││  │ Connected wallet         │  ││
│  ⚙ Settings ◄ │  │   Appearance               >       ││  │  eternl · addr_test1q…7g │  ││
│               │  │   Network                  >       ││  │  [ Disconnect ]          │  ││
│  ( Post )     │  │   Advanced                 >       ││  └──────────────────────────┘  ││
│  (av) me  ⋯   │  │   About                    >       ││  ┌──────────────────────────┐  ││
│               │  │                                    ││  │ Posting account (ss58)   │  ││
│               │  │  (active row = accent left bar +   ││  │  5CBEKoFC…m1k  [copy] ⧉  │  ││
│               │  │   --cg-bg-hover, chevron hidden)   ││  │  Identity: ✓ bound       │  ││
│               │  │                                    ││  │  Voting power: 100.0 ADA │  ││
│               │  └────────────────────────────────────┘└────────────────────────────────┘│
└──────────────┴───────────────────────────────────────────────────────────────────────┘
```

- The section index (master) is `position: sticky; top: var(--cg-header-h)` and ~290px wide; the detail panel
  scrolls independently. Selecting a row swaps the detail panel **without a route change** (in-page state
  `activeSection`), but updates the hash (`/settings#profile`) via `history.replaceState` so a row is deep-linkable
  and the back button is sane. (A deep-linked `/settings/` standalone fallback for `EditProfileModal` lands on
  `activeSection='profile'` with the modal open — see `01-information-architecture.md` §7.)
- Master rows are 52px tall, `--cg-fs-sm`, with a 4px accent left-border (`--cg-accent`) + `--cg-bg-hover` on the
  active row; inactive rows show a trailing chevron in `--cg-text-secondary`.

### 1.2 Mobile (<688px) — single-column drill-down

```
┌─────────────────────────────┐        (tap "Account")        ┌─────────────────────────────┐
│ ◂ Settings                  │   ───────────────────────▶    │ ◂ Account                   │
├─────────────────────────────┤                               ├─────────────────────────────┤
│  Account                  > │                               │ Connected wallet            │
│  Profile                  > │                               │   eternl · addr_test1q…7g   │
│  Vault & posting power    > │                               │   [ Disconnect ]            │
│  Appearance               > │                               │                             │
│  Network                  > │                               │ Posting account (ss58)      │
│  Advanced                 > │                               │   5CBEKoFC…m1k   [copy] ⧉   │
│  About                    > │                               │   Identity   ✓ bound        │
├─────────────────────────────┤                               │   Voting power  100.0 ADA   │
│ ⌂   🔍   ◎   ⚙              │  ← BottomTabBar               │                             │
└─────────────────────────────┘                               └─────────────────────────────┘
```

- Mobile is a **stack**: the section list is the root; tapping a row `router.push`-style swaps to that panel with a
  back arrow (`IconBack`) in the sticky header that returns to the list. Implemented as in-page state (no route
  segment per section — the static export has no `/settings/[section]` route), with the hash mirrored for
  deep-linkability and `history.back()` wired to return to the list when a panel is open (`01-information-architecture.md`
  §5 client-nav rule).
- The sticky header on the list shows "Settings"; on a panel it shows the panel title + a back arrow.

### 1.3 Tablet (688–1019px)

Collapsed icon `LeftNav` (per `01-information-architecture.md` breakpoints), **no `RightRail`**, and the settings
master/detail collapses to the **mobile drill-down** pattern (the 290px master + detail does not fit beside a
600px-capped center at this width). i.e. tablet uses the §1.2 single-column behavior inside the wider center column.

---

## 2. Section 1 — Account

**Purpose.** Show *who you are on the chain right now*: the connected Cardano wallet (the identity/stake key), the
**derived posting account** (ss58, copyable), the identity-bound status, and the stake / voting-power status; offer
**Disconnect** and the **Finish setup** (bind) affordance. This is a **display + disconnect** section — it performs
no chain writes itself (binds happen here only via the same `useIdentity.bind` the `/welcome` onboarding flow uses,
`11-surface-onboarding-auth.md`).

### 2.1 Data bindings

| Field | Source | Hook | Notes |
|---|---|---|---|
| Session state | `sessionState(useSigner, useIdentity)` (`04-data-layer.md` §5.1) | derived | drives which sub-card renders |
| Connected wallet id + address | `useSigner().connectedWalletId`, `.walletAddress` | `useSigner` | `null` when on a dev account / disconnected |
| Posting account ss58 | `useSigner().signer.ss58` | `useSigner` | the derived sr25519 key (or dev account) |
| Identity bound | `useIdentity().bound` (`true`/`false`/`null`) | `useIdentity` | `null` = loading |
| Stake bound | `useIdentity().stakeBound` | `useIdentity` | enables vote weight |
| Voting power | `useIdentity().votingPower` (lovelace `bigint`) | `useIdentity` | watched live; formatted ADA |
| `bind` / `bindStake` | `useIdentity().bind(walletId)`, `.bindStake(walletId)` | `useIdentity` | feeless **bare unsigned** binds |
| Disconnect | `useSigner().disconnect()` | `useSigner` | clears the derived key (no chain write) |

No GraphQL here — Account reads only **session + chain account state**. `votingPower`/`stakeBound` come from the
live watches in `useIdentity` (`TalkStake.VotingPower`, `CognoGate.StakeCredOf`).

### 2.2 Sub-cards (rendered by session state)

```
Account
┌───────────────────────────────────────────────┐   ← Connected wallet card
│ Connected wallet                               │     (present iff walletConnected)
│   eternl · addr_test1q…7g            [Disconnect]│
└───────────────────────────────────────────────┘
┌───────────────────────────────────────────────┐   ← Posting account card (always, once postingEnabled)
│ Posting account                                │
│   5CBEKoFC…m1k                       [Copy ⧉]  │     mono, middle-truncated ss58 (Handle component)
│   Identity      ✓ Registered                   │     ← bound===true
│   Voting power  100.0 ADA                       │     ← votingPower formatted; "—" if 0n/null
│   Stake key     ✓ Linked  /  [ Add voting power ]│   ← stakeBound? linked : bind CTA
└───────────────────────────────────────────────┘
```

- **`disconnected`** (no wallet, no dev account): the cards collapse to a single empty card with a
  `ConnectWalletButton` (`03-component-library.md`) and one line "Connect a Cardano wallet to post." No honesty copy.
- **`connecting`** (`useSigner.deriving`): a `Spinner` + "Signing in…" (the sign-to-derive popup is the wallet's
  own UX).
- **`connected_unbound`** (`bound===false`): the Posting account card shows the ss58 + "Identity: **Not registered**"
  and a primary **Finish setup** button → `useIdentity.bind(connectedWalletId)`. While `binding`, the button shows a
  `Spinner` + "Registering…". On success the row flips to "✓ Registered" (the live `bound` watch).
- **`bound` / `bound_no_stake`**: "Identity ✓ Registered"; "Voting power —" (or "0 ADA"); an **Add voting power**
  button → `useIdentity.bindStake(connectedWalletId)`. Gated: only usable when `bound===true` (the hook pre-checks
  `NotPaymentBound`); shows `stakeError` inline (`--cg-danger`) if the wallet can't sign over a reward address.
- **`bound_staked`**: "Voting power N ADA"; "Stake key ✓ Linked"; the bound stake credential is **not** displayed by
  default (drop the raw 0x cred chrome — it reads as honesty/dev marginalia); it is available only under Advanced.

### 2.3 Copy-the-ss58 control

The posting account renders via `Handle` (`03-component-library.md`, mono middle-truncated ss58, prefix 42) with a
trailing **Copy** button (`IconShare`/copy glyph). On click: `navigator.clipboard.writeText(signer.ss58)` → a brief
**success Toast** "Copied" (`Toaster/Toast` kind `success`, `03-component-library.md`). The full ss58 is the copy
payload (never the truncated display string).

### 2.4 Disconnect

`Disconnect` → `useSigner.disconnect()`. This is purely client-side: it drops the derived key and returns the signer
to the background `//Alice` (posting disabled). **It does not** clear the wallet's `localStorage` reconnect hint
(`cogno.wallet.last`) — that stays so the next visit offers a one-click reconnect. No confirm dialog (nothing is
destroyed; the key is re-derivable by reconnecting). After disconnect, the Account section returns to the
`disconnected` empty card and the rest of the app's write affordances fall to the `disconnected` gate
(`04-data-layer.md` §5.2).

### 2.5 States (Account)

| State | Render |
|---|---|
| loading (`bound===null` / `votingPower===null`) | the rows present with `Skeleton` shimmer placeholders (`03-component-library.md`) |
| disconnected | single empty card + `ConnectWalletButton` + one-line prompt |
| connecting | `Spinner` + "Signing in…" |
| connected_unbound | ss58 card + **Finish setup** primary button |
| binding | **Finish setup** → `Spinner` "Registering…"; disabled |
| bound_no_stake | ✓ Registered; "Add voting power" CTA |
| stake binding | "Add voting power" → `Spinner` "Linking…"; disabled |
| bound_staked | ✓ Registered + ✓ Linked + voting power |
| error (`useIdentity.error`/`stakeError`) | inline `--cg-danger` line under the relevant button; the action re-enables for retry |

---

## 3. Section 2 — Profile

**Purpose.** Edit the on-chain profile (display name / bio / avatar URL) and pinned post via the shared
`EditProfileModal`; clear the profile. These are the **only fee-bearing writes** in the whole app
(`05-divergences-and-constraints.md` D9), so this section explicitly carries the "needs a funded account" state —
**not** a `RateLimitNotice` (capacity is for feeless social actions; profile fees are a real tx fee).

> **This doc owns "fund your posting account."** The funded-account gate and the funding path for the only
> fee-bearing actions (`set_profile` / `pin_post`) are specified here in §3.4. `05-divergences-and-constraints.md`
> D9 and `07-surface-profile.md` §9.4 both defer this mechanism to `12-surface-settings.md` — they reference it,
> 12 defines it.

### 3.1 Panel layout

```
Profile
┌───────────────────────────────────────────────┐
│  (av lg)   Ada Lovelace                         │   ← live preview from current Profile (or fallback)
│            @5CBEKoFC…m1k                         │
│            "first ada to lock"  (bio)           │
│            avatar: ipfs://Qm…/pfp.png           │
│                                                 │
│            [ Edit profile ]   [ Clear profile ] │   ← Edit opens EditProfileModal; Clear → confirm
│                                                 │
│  Pinned post                                    │
│   ┌─ PostCard (variant 'timeline') ─────────┐   │   ← current pinnedPostId resolved via ONE_POST
│   │ … your pinned post …          [ Unpin ] │   │     (or an EmptyState "No pinned post")
│   └────────────────────────────────────────┘   │
└───────────────────────────────────────────────┘
```

### 3.2 Data bindings (profile display)

The display preview reads the viewer's own profile. Two paths, gated by `source.caps.profiles`
(`04-data-layer.md` §2.3):

- **Indexer (`caps.profiles===true`):** `PROFILE_BY_ACCOUNT` (`04-data-layer.md` §2.6, query constant
  `PROFILE_BY_ACCOUNT`) with `$ss58 = signer.ss58`, taking `displayName bio avatar pinnedPostId` from the `author`
  node. The pinned post is resolved via the `ONE_POST` query (`04-data-layer.md` §6) on `pinnedPostId`.
- **PAPI-direct (`caps.profiles===false`):** the preview falls back to the `DisplayName` = truncated ss58 +
  identicon `Avatar` (`03-component-library.md`) and **bio/avatar are blank** (the node path omits profile display
  fields, `04-data-layer.md` §2.6). The `EditProfileModal`'s *current values* can still be read directly from
  `Profile.Profiles(ss58)` storage for the edit form's initial values (a one-shot PAPI read), even when the indexer
  isn't configured — so editing works PAPI-direct, only the rich preview degrades.

> **Reuse `EditProfileModal` (`03-component-library.md`) verbatim** — this doc does not redefine it. The modal owns
> the form fields, the `ByteCounter`s (display_name ≤ 64 B, bio ≤ 256 B, avatar ≤ 128 B; UTF-8 BYTES via
> `TextEncoder`, `05-divergences-and-constraints.md` D1/D12), the avatar-URL note ("a link or IPFS CID, not an
> upload" — no media, `05-divergences-and-constraints.md`), and the submit/cancel buttons. Settings just mounts it.

### 3.3 Extrinsics

| Interaction | Extrinsic | Function (`lib/chain/mutations.ts`, `04-data-layer.md` §3.1) | Args | Cost |
|---|---|---|---|---|
| Save profile (modal Save) | `Profile.set_profile` | `submitSetProfile(api, signer, name, bio, avatar)` | `{ display_name: Binary.fromText(name), bio: Binary.fromText(bio), avatar: Binary.fromText(avatar) }` | **FEE-BEARING** signed |
| Clear profile | `Profile.clear_profile` | `submitClearProfile(api, signer)` | `{}` | FEE-BEARING |
| Pin a post (from a `PostCard` overflow elsewhere) | `Profile.pin_post` | `submitPinPost(api, signer, id)` | `{ id: bigint }` | FEE-BEARING |
| Unpin (here, the **Unpin** button) | `Profile.unpin_post` | `submitUnpinPost(api, signer)` | `{}` | FEE-BEARING |

- Pinning *new* posts happens from a `PostCard` overflow on the timeline/profile (`03-component-library.md`); the
  Settings → Profile panel only surfaces the **current** pinned post + an **Unpin** button.
- `pinnedPostId` is **not validated on-chain** (`05-divergences-and-constraints.md` / SHARED GROUNDING): if the
  resolved post 404s, render the `EmptyState` "No pinned post" and still offer Unpin.

### 3.4 Fund your posting account (the funded-account gate) — **owned here**

Profile edits and pins are signed and charge a tiny tx fee from the posting account's balance. The posting account
is a fresh derived sr25519 key that is usually **zero-balance** (binds are feeless; posting is feeless). So this
section must surface an **insufficient-balance** state — distinct from rate-limit:

- **The gate.** Before enabling **Save** in `EditProfileModal` (and the **Clear**/**Unpin** buttons here), read the
  posting account's free balance via `useBalance(api, ss58)` (`04-data-layer.md` §7.2; reads
  `System.Account(ss58).data.free` as a one-shot/watched PAPI read) and estimate the fee with the fee-estimate
  helper (`04-data-layer.md` §7.2, wrapping PAPI `tx.getEstimatedFees(ss58)`).
- **The decision.** If `free < estimatedFee`: disable Save and show an inline notice in the modal/panel (NOT
  `RateLimitNotice`): "Your posting account needs a small balance to edit your profile." with a copyable ss58 so the
  user can fund it. One line, no honesty framing (`05-divergences-and-constraints.md` D9).
- **The funding path.** This testnet has **no in-app faucet**; funding the posting account is an **out-of-band /
  operator step**. The notice exposes the posting account's full ss58 (Copy button, §2.3) and one plain line telling
  the user how to top it up: transfer a small amount of the runtime's native token to that ss58 from an already-funded
  account (operator-funded on this single-operator testnet), or — if a public faucet endpoint is later configured —
  a "Get test tokens ↗" link. Until then it is explicitly an out-of-band manual transfer-in; do not promise an
  in-app faucet. The balance watch flips the gate the moment the transfer lands, re-enabling Save with no reload.
- **On submit error** `InsufficientBalance` / `Payment` (the runtime authority): roll back the optimistic preview and
  raise the same funded-account notice as a `Toast` (`error` kind).

### 3.5 Submit lifecycle (Profile)

Per `04-data-layer.md` §3.4, fee-bearing writes get a **brief success toast** (unlike silent feeless actions). The
flow: optimistic preview update (the panel shows the new name/bio/avatar immediately) → `submitSetProfile` stream →
on `inBestBlock` (ok) **close the modal** + "Profile updated" success `Toast` → on `error`/`invalid` roll back the
preview + error `Toast`. `Clear profile` requires a **confirm dialog** ("Clear your profile? Your posts stay.")
because it is destructive of display data (the posts themselves are permanent — never deleted).

### 3.6 States (Profile)

| State | Render |
|---|---|
| not-connected / `connected_unbound` | the whole panel shows "Finish setting up your account to edit your profile." + the bind affordance (reuses §2.2 `connected_unbound`); Edit/Clear hidden |
| loading | `Skeleton` preview rows |
| empty profile (bound, no `set_profile` yet) | preview shows `DisplayName` fallback (truncated ss58) + identicon; bio/avatar blank; **Edit profile** prompts "Add a display name and bio" |
| populated | full preview + Edit/Clear |
| editing | `EditProfileModal` open (overlay; standalone fallback `/settings/`) |
| saving | modal Save → `Spinner`; panel preview optimistic |
| insufficient balance | inline funded-account notice; Save disabled |
| error | error `Toast` + rollback |
| no indexer (PAPI-direct) | preview degrades to ss58 + identicon; Edit still works from `Profile.Profiles` storage read |

---

## 4. Section 3 — Vault & posting power

**Purpose.** Lock / exit the 100-ADA L1 vault that earns **posting power** (talk-capacity weight), and show the
account's current posting weight — framed **plainly as "posting power", never a battery or an honesty meter**
(`00-overview.md`, `05-divergences-and-constraints.md` D5). This is the Cardano-side action; it uses `useVault`
(Blockfrost) and is entirely separate from the stake-key/voting-power bind in Account (§2).

> **Vocabulary discipline.** Two different weights, kept distinct in copy:
> - **Posting power** = the locked-ADA talk-capacity weight (this section; `useVault` lock + on-chain
>   `TalkStake.AllowedStake`). It is what lets you post without hitting the rate limit.
> - **Voting power** = the stake-key-proven total Cardano stake (§2 Account; `useIdentity.votingPower` /
>   `TalkStake.VotingPower`). It is what gives your likes/votes weight.
> Never conflate them; never render either as a battery.

### 4.1 Panel layout

```
Vault & posting power
┌───────────────────────────────────────────────┐
│  Posting power                                  │
│    100.0 ADA locked                             │   ← TalkStake.AllowedStake (lovelace) → ADA; "—" if 0
│                                                 │
│  Vault                                          │
│    Status:  100.000000 ADA locked               │   ← useVault.locked (lovelace) once inspected
│    [ Lock 100 ADA ]      [ Exit vault ]         │   ← lock disabled if already locked; exit if nothing locked
│                                                 │
│    (when busy)  ⟳ Submitting lock…              │
│    (after)      Submitted · updating shortly    │   ← NO tx hash chrome, no block number
└───────────────────────────────────────────────┘
```

### 4.2 Data bindings

| Field | Source | Hook | Notes |
|---|---|---|---|
| Provider available | `useVault().available` (`hasCardanoProvider()`) | `useVault` | false ⇒ the whole Lock/Exit block is **hidden** (no Blockfrost id configured) |
| Locked lovelace | `useVault().locked` (`bigint\|null`), `.lockedKnown` | `useVault` | resolved via `inspect(walletId)` |
| Posting power (on-chain weight) | `TalkStake.AllowedStake(ss58)` watched | extend `useCapacity`/a small read | the weight the follower/inherent has granted; lags the lock by a few blocks |
| `inspect` / `lock` / `exit` | `useVault().inspect/lock/exit(walletId)` | `useVault` | `walletId = useSigner().connectedWalletId` |
| phase / busy / error / txHash | `useVault().phase/busy/error/txHash` | `useVault` | txHash **not rendered** (no block/tx chrome) |

On entering the section (and on wallet change), call `inspect(connectedWalletId)` once to populate `locked`. The
on-chain posting power reads `TalkStake.AllowedStake(signer.ss58)` (a `watchValue` so it updates when the follower
writes the weight a few blocks after a lock).

### 4.3 Extrinsics / actions

| Interaction | Action | Path | Notes |
|---|---|---|---|
| Lock 100 ADA | `useVault.lock(connectedWalletId)` | Cardano L1 tx via Blockfrost (`lib/cardano/vault.ts`) | mints the owner beacon + locks 100 ADA at `talk_vault`; **not a Substrate extrinsic** |
| Exit vault | `useVault.exit(connectedWalletId)` | Cardano L1 spend via Blockfrost | burns the beacon + reclaims the locked ADA |

> **No Substrate extrinsic here.** Posting power is *observed* from Cardano (the follower/inherent writes
> `TalkStake.AllowedStake`); the FE only submits the **Cardano** lock/exit. That observation lag is surfaced plainly:
> after a successful lock, the panel says "Submitted · updating shortly" and `useVault` auto re-inspects after 5 s;
> the on-chain `AllowedStake` watch flips the "Posting power" line when the weight lands. **No** "trusted follower" /
> "evidence" / honesty copy.

### 4.4 Lock/exit lifecycle & gating

- **Lock disabled** when `locked` is already ≥ the lock amount (a vault exists) — show "Already locked" instead of
  the button. **Exit disabled** when `locked` is `null`/`0` (nothing to exit). Buttons disabled while `busy`
  (`phase==='working'`), showing a `Spinner` + "Submitting lock…" / "Submitting exit…".
- `phase==='submitted'`: "Submitted · updating shortly" (`--cg-text-secondary`); the buttons re-enable after the
  re-inspect resolves.
- `phase==='error'`: `useVault.error` rendered inline (`--cg-danger`) + the action re-enables for retry. Common
  errors (cost-model / wallet-rejected / no-UTxO) come through `useVault.error` as-is; do not decorate with honesty
  text. `reset()` clears the error when the user dismisses it.
- **`available===false`** (no Blockfrost project id): hide the Lock/Exit block entirely and show one line "Set a
  Cardano provider in **Network** to lock ADA." linking to §5. (Mirrors `04-data-layer.md`/endpoints: empty
  Blockfrost ⇒ lock hidden.)

### 4.5 The "posting power" → rate-limit relationship (read-only note)

This section is where the user *acquires* posting power; the *consequence* of low/zero posting power is the
`RateLimitNotice` ("Lock ADA to start posting.") shown on the Composer (`04-data-layer.md` §4, `draftStatus`
`no_weight`). That notice's "Lock ADA" link routes **here** (`/settings#vault`). We do **not** render a battery,
percentage, or "blocks until you can post" anywhere — Settings shows only the plain "N ADA locked" / "Posting
power: N ADA" lines (`05-divergences-and-constraints.md` D5).

### 4.6 States (Vault)

| State | Render |
|---|---|
| provider unavailable | block hidden + "Set a Cardano provider in Network" |
| not-connected | "Connect a wallet to lock ADA." + `ConnectWalletButton` |
| loading (`!lockedKnown`) | `Skeleton` on the Status line; buttons disabled |
| nothing locked | Status "No vault yet"; **Lock 100 ADA** enabled, **Exit** disabled |
| locked | Status "N ADA locked"; **Lock** → "Already locked" (disabled), **Exit** enabled |
| working | `Spinner` + "Submitting lock…/exit…"; both disabled |
| submitted | "Submitted · updating shortly" |
| error | `useVault.error` inline `--cg-danger`; retry enabled |

---

## 5. Section 4 — Appearance

**Purpose.** Theme (dark/light), persisted. Dark-first (default), with a working light toggle. **No "Dim" third
theme** (optional future, `02-design-system.md`).

### 5.1 Layout

```
Appearance
┌───────────────────────────────────────────────┐
│  Theme                                          │
│    ( ◐ Dark )   ( ☼ Light )                     │   ← segmented control; active = accent ring/fill
│                                                 │
│    [ ☾ / ☼ ]  quick toggle  (ThemeToggle)       │   ← the same ThemeToggle used in the RightRail footer
└───────────────────────────────────────────────┘
```

### 5.2 Control & persistence

- **Control:** the canonical `ThemeToggle` (`02-design-system.md` / `03-component-library.md`, icons `IconSun` /
  `IconMoon`), optionally presented here as a two-option segmented control (Dark / Light) for clarity, both backed
  by the same `useTheme()` hook (`04-data-layer.md` §7.2: `→ { theme, setTheme, toggle }`).
- **Persistence:** `localStorage` key **`cg-theme`** (value `'dark'` | `'light'`), the canonical key from
  `02-design-system.md`. `useTheme` writes the `data-theme` attribute on `<html>` (`document.documentElement.dataset.theme`)
  and persists `cg-theme`.
- **No-flash contract:** the pre-paint inline boot script (owned by `01-information-architecture.md`) reads
  `localStorage['cg-theme']` (default `'dark'`) and sets `data-theme` before first paint. Appearance just flips it
  at runtime; the boot script keeps the choice across reloads with no flash. Default when unset = **dark**.

### 5.3 Effect & validation

- Effect is immediate: `setTheme('light')` swaps `[data-theme="light"]` on `<html>`, re-resolving all `--cg-*`
  color tokens app-wide (`02-design-system.md` themes the color tokens only; geometry/type/motion are theme-agnostic).
- Validation: the only valid values are `'dark'`/`'light'`; any other persisted value falls back to `'dark'`
  (handled by the boot script + `useTheme`). No user free-text.

### 5.4 States (Appearance)

| State | Render |
|---|---|
| default | "Dark" active |
| toggled | "Light" active; instant repaint |
| storage blocked (private mode) | the toggle still works for the session (in-memory); it just won't persist — **silent**, no error |

---

## 6. Section 5 — Network

**Purpose.** The three endpoint knobs the whole app's reads/writes flow through — **Node (ws)**, **Indexer
(GraphQL)**, **Cardano provider (Blockfrost)** — plus the **Follower URL** (legacy; see note). These are the **only**
config surfaces, and per the locked decision they are **quiet and un-hedged**: plain field labels, no honesty
framing, no "who you trust to read for you" disclaimers. Backed entirely by `lib/config/endpoints.ts` (already
implemented).

### 6.1 Layout

```
Network
┌───────────────────────────────────────────────┐
│  Node (WebSocket)                               │
│    [ wss://node.cogno.example/ws            ]   │   ← ws:// or wss://; required; default ws://127.0.0.1:9944
│    [ Save ]  ● Connected                        │   ← status dot from useChain().status
│                                                 │
│  Indexer (GraphQL)                              │
│    [ https://indexer.cogno.example/            ]│   ← optional; empty ⇒ PAPI-direct (no search/Following)
│    [ Save ]  [ Clear ]                           │
│    “Search and the Following tab need the indexer.”  ← one-line, plain
│                                                 │
│  Cardano provider (Blockfrost project id)       │
│    [ preprintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX  ] │   ← optional; empty ⇒ vault lock hidden
│    [ Save ]  [ Clear ]                           │
└───────────────────────────────────────────────┘
```

> The existing `EndpointSettings.tsx` component is the kernel of this section; extend it (it currently handles ws +
> indexer + follower) to also surface the Blockfrost field, and re-skin to the `--cg-*` settings card layout. Keep
> all validation in `lib/config/endpoints.ts` (do not duplicate it in the component).

### 6.2 Controls, persistence, validation, effect

| Field | Control | localStorage key (via `endpoints.ts`) | Validation | Effect on change |
|---|---|---|---|---|
| **Node (ws)** | text input + Save | `cogno.endpoints` (JSON array of ws/wss) — `setEndpoints` / `getEndpoints` / `getActiveWsUrl` | must start `ws://` or `wss://`; `setEndpoints` throws on an all-invalid list → show inline `--cg-danger` | **Reconnects `useChain`**: on Save, `useChain.reconnect()` (or re-mount the handle) so the live ws + `source.watch()` subscription re-point at the new node. Status dot from `useChain().status` (`connecting`/`connected`/`error`). Active endpoint = `getActiveWsUrl()` (first in the list). |
| **Indexer (GraphQL)** | text input + Save + Clear | `cogno.graphql` — `setGraphqlUrl` / `getGraphqlUrl` | non-empty must be `http://`/`https://`; `setGraphqlUrl` throws on a non-empty non-http value; **empty/blank Clears it** | Re-memoizes `useFeedSource(api, graphqlUrl)` (`04-data-layer.md` §7.2). Set a URL ⇒ `makeFeedSource` picks the **indexer** reader (caps all-true: search/pagination/Following/who-to-follow/profiles light up). **Clear** ⇒ `makeFeedSource` falls back to **PAPI-direct** (`caps {search:false,pagination:false,threads:true,revocation:true,tallies:true,follows:false,profiles:false,whoToFollow:false}`) — the app silently **hides** search results, the Following tab, who-to-follow, and profile counts (`04-data-layer.md` §2.3 gating table). |
| **Cardano provider** | text input + Save + Clear | `cogno.blockfrost` — `setBlockfrostProjectId` / `getBlockfrostProjectId` | any non-blank string; **empty/blank Clears it** | Toggles `useVault().available` (`hasCardanoProvider()`): set ⇒ the **Vault & posting power** Lock/Exit block (§4) appears; clear ⇒ it hides. Also gates the in-browser CIP-30 lock/exit txs. |
| **Follower URL** (legacy) | text input + Save (under a small "Legacy" disclosure) | `cogno.follower` — `setFollowerUrl` / `getFollowerUrl` | must be `http://`/`https://` | **No effect in spec 116** — the CIP-8 binds are feeless bare unsigned extrinsics; there is **no follower POST in the bind path** anymore. Keep the field only for completeness behind a collapsed "Legacy" disclosure (the relay was removed; `endpoints.ts` notes this). Default-collapsed; most users never see it. |

> **Effect plumbing.** Saving the **Node** triggers a reconnect — the clean way is to have `useChain` re-read
> `getActiveWsUrl()` and call its `reconnect()`; saving the **Indexer**/**Blockfrost** does not need a chain
> reconnect, only a re-read of the config-derived memo (`useFeedSource` depends on `graphqlUrl`; `useVault.available`
> on the Blockfrost id). Because these are read on mount/effect, the simplest robust UX is: on any endpoint Save,
> show a "Settings saved — reloading…" toast and `window.location.reload()` if a live re-point isn't wired (the
> static export tolerates a reload; state is in `localStorage`). Prefer the live re-point for ws/indexer; reload is
> the acceptable fallback. **Document which you chose in the PR.**

### 6.3 Validation UX

- Each field has a **Save** that is disabled until the value changes from the persisted value. On Save, run the
  `endpoints.ts` setter inside a try/catch; a thrown validation error renders inline under the field in `--cg-danger`
  (e.g. "Node must be a ws:// or wss:// URL", "Indexer must be http:// or https:// (or empty to read directly)").
- **Clear** (Indexer / Blockfrost) calls the setter with `""` (removes the key) and immediately re-derives the
  dependent affordance (hides search / hides vault). Confirm-free (clearing is non-destructive — config only).
- Storage-blocked (private mode): the setters degrade silently (no throw on the storage write); the field shows the
  attempted value for the session but a small "Won't persist in private mode" hint may be shown (optional, plain).

### 6.4 States (Network)

| State | Render |
|---|---|
| pristine | fields prefilled from `getEndpoints()[0]` / `getGraphqlUrl()` / `getBlockfrostProjectId()`; Save disabled |
| edited | Save enabled |
| node connecting | status dot amber + "Connecting…" |
| node connected | status dot `--cg-accent`/green + "Connected" |
| node error | status dot `--cg-danger` + the `useChain().status` error string; Save still available to fix the URL |
| indexer set | search/Following/who-to-follow affordances light up app-wide (no per-field confirmation needed beyond the toast) |
| indexer cleared | "search needs the indexer" `EmptyState` will show on `/explore`; Following tab hidden on Home (`04-data-layer.md` §2.3) |
| validation error | inline `--cg-danger` under the field |

---

## 7. Section 6 — Advanced (Developer)

**Purpose.** The hidden/advanced power-user controls, collapsed by default behind a disclosure: the **dev account
picker** (`//Alice` … for testing without a wallet), and read-only diagnostics (the bound stake credential hex, the
active genesis hash, the live `useHeads` numbers) that we deliberately keep **out of the main chrome** (the honesty
layer is dropped — these live here only for operators/testers). Reuses `useSigner`'s advanced API.

### 7.1 Layout

```
Advanced ▾                                          ← collapsed by default; click to expand
┌───────────────────────────────────────────────┐
│  Developer account                              │
│    Use a built-in test account (no wallet).     │
│    [ //Alice ▾ ]   [ Use ]                       │   ← devAccounts dropdown → setDevAccount(uri)
│    Active: //Alice  (5GrwvaEF…)                 │
│                                                 │
│  Diagnostics (read-only)                        │
│    Genesis      0x2653e177…                      │
│    Best / final #1234 / #1230                    │   ← useHeads (NOT shown anywhere else)
│    Stake cred   0x…  (if bound_staked)           │   ← from useIdentity.boundStakeCredHex
└───────────────────────────────────────────────┘
```

### 7.2 Controls & persistence

| Control | Source | Persistence | Effect |
|---|---|---|---|
| Dev account dropdown + Use | `useSigner().devAccounts`, `.setDevAccount(uri)` | `cogno.signer.devChoice` (the URI only — **never a secret**, key from `useSigner`) | sets the active posting signer to a well-known dev key (`getDevSigner(uri)`); `postingEnabled` becomes true via the dev choice. Disconnects any connected wallet. |
| Genesis hash | `getGenesisHex(api)` (`lib/chain/identity.ts`) | n/a (read) | display only |
| Best / finalized heads | `useHeads(client)` | n/a (read) | display only — **the only place block numbers appear in the entire app** (`04-data-layer.md` §7.1: `useHeads` kept but "not rendered in chrome"); Advanced is the explicit exception |
| Stake credential hex | `useIdentity().boundStakeCredHex` | n/a (read) | display only (kept out of Account §2 to avoid honesty/dev marginalia) |

### 7.3 Gating & states

- **Collapsed by default.** The disclosure header reads "Advanced" with a chevron; expanding it reveals the dev
  controls. This keeps the consumer-facing Settings clean (the dev/honesty/endpoints-as-trust framing is hidden,
  matching the M8 UX-redesign posture — dev controls behind a toggle).
- Choosing a dev account is a **testing** affordance; it bypasses the wallet/identity flow (dev accounts may not be
  identity-bound, so write gates still apply via `sessionState`). After `setDevAccount`, the Account section (§2)
  reflects the dev signer's ss58 + its (usually unbound) identity state.
- States: collapsed / expanded; dev-account-active (shows "Active: //Alice (…ss58)") / wallet-active (the dev picker
  shows "Connected to a wallet — using a dev account will disconnect it").

---

## 8. Section 7 — About

**Purpose.** A minimal, plain "About cogno-chain" footer card — name, a one-line description, a version/link — **with
no honesty framing** (the old `About.tsx` reading-room/honesty copy is replaced). Keep it short; this is not a trust
disclosure.

```
About
┌───────────────────────────────────────────────┐
│  cogno-chain                                    │
│  A feeless place to post.                       │
│  v… · source ↗                                  │   ← plain; NO "trusted follower"/"operator-run"/anchor copy
└───────────────────────────────────────────────┘
```

- Reuse a slimmed `About` component (`03-component-library.md` does not own it; this section owns a plain card). The
  existing `About.tsx` must have its reading-room/honesty/endpoint-trust language **removed** (per `00-overview.md`
  honesty-drop mandate); keep only name + one-liner + an optional source link.

---

## 9. Responsive behavior (summary)

| Breakpoint | Settings layout | Chrome |
|---|---|---|
| **Desktop ≥1020px** | master/detail (290px section index + scrolling detail); `RightRail` suppressed so Settings fills center+right | full `LeftNav` |
| **Tablet 688–1019px** | single-column drill-down (§1.2) inside the wider center column | collapsed icon `LeftNav`, no `RightRail` |
| **Mobile <688px** | single-column drill-down; sticky header back-arrow on a panel | `BottomTabBar` (Settings = 4th tab), `ComposeFab` still present |

- The section index/detail split and the drill-down are the **same React tree** with a CSS-Modules + container-query
  (or width-class) switch; no separate routes per section (static export has no `/settings/[section]`).
- `EditProfileModal` opens as a centered overlay on desktop and a full-height sheet on mobile (per
  `03-component-library.md`); its standalone fallback `/settings/` lands on `activeSection='profile'`.

---

## 10. Accessibility

- **Master/detail as a tablist (desktop):** the section index is `role="tablist"` (vertical,
  `aria-orientation="vertical"`); each row is `role="tab"` with `aria-selected`; the detail panel is `role="tabpanel"`
  labelled by the active tab (`aria-labelledby`). Arrow-up/down moves between sections; Enter/Space activates; the
  detail panel is focusable (`tabIndex={0}`) and receives focus on selection.
- **Drill-down (mobile/tablet):** the section list rows are buttons (`<button>`/`<a>`); the back arrow is a labelled
  `IconBack` button (`aria-label="Back to settings"`); on entering a panel, focus moves to the panel heading
  (`tabindex=-1` + `.focus()`); `history.back()` / the back arrow returns to the list and restores focus to the row
  that opened it.
- **Every input** has a visible `<label>` (Node / Indexer / Cardano provider / dev account); Save buttons are
  associated via the form. Validation errors use `aria-live="polite"` + `aria-describedby` linking the field to its
  error text.
- **Theme toggle / segmented control:** the Dark/Light control is a `radiogroup` (or the `ThemeToggle` button with
  `aria-pressed`); the active theme is announced; the control is keyboard-operable.
- **Copy ss58:** the Copy button has `aria-label="Copy posting account address"`; success is announced via the
  `Toaster` live region (`03-component-library.md`).
- **Focus ring:** all interactive controls use the canonical `:focus-visible` accent ring (`--cg-focus-ring`,
  `02-design-system.md`). Disabled controls (Save when unchanged, Lock when already locked) get `aria-disabled` +
  `disabled`.
- **Keyboard shortcuts:** the global feed shortcuts (`j/k/n`, `02-design-system.md`/`06-surface-home.md`-owned) are **not**
  active on `/settings` (no feed); only standard form/tab navigation applies. The global `g s` (go to settings)
  shortcut, if implemented in `AppShell`, routes here.
- **Reduced motion:** the master→detail and list→panel transitions respect `prefers-reduced-motion` (per
  `02-design-system.md` motion guards) — instant swap, no slide.

---

## 11. Notifications hook (DEFERRED — leave the seam)

Settings is where a future **Notifications preferences** sub-section would live (which events to surface: reply /
vote / repost / follow / quote targeting you, `04-data-layer.md` §5.4). **Do not author it now.** Leave a single
labelled comment at the section-inventory list and the `LeftNav`/`BottomTabBar` (owned by
`01-information-architecture.md`) noting the deferred follow-up; the indexer already exposes the targeting events
(`Voted`/`Reposted`/`Followed`/reply-`PostCreated`/quote) that make it a clean addition. No section is rendered for
it in v1.

---

## 12. Implementation checklist (ordered)

- [ ] **Page shell.** Create `SettingsPage` (`src/app/settings/page.tsx`, `'use client'`) per
      `01-information-architecture.md`. Build the master/detail (desktop) + drill-down (mobile/tablet) responsive
      shell with `activeSection` state, hash-mirroring (`history.replaceState('/settings#<id>')`), and the sticky
      blurred header. Suppress `RightRail` on `/settings`.
- [ ] **Section 1 — Account.** Render the session-state-driven sub-cards (`sessionState(useSigner, useIdentity)`,
      `04-data-layer.md` §5.1): connected-wallet card (+ `disconnect`), posting-account card with `Handle` + Copy
      (clipboard + success Toast), identity-bound status (`useIdentity.bound` + **Finish setup** → `bind`), and
      voting-power status (`votingPower` + **Add voting power** → `bindStake`). Wire all states (§2.5).
- [ ] **Section 2 — Profile.** Mount the canonical `EditProfileModal` (`03-component-library.md`); render the live
      profile preview from `PROFILE_BY_ACCOUNT` (indexer) or ss58+identicon fallback (PAPI-direct, `caps.profiles`);
      resolve `pinnedPostId` via `ONE_POST`; wire `submitSetProfile`/`submitClearProfile`/`submitUnpinPost`
      (FEE-BEARING, `04-data-layer.md` §3.1), the **funded-account** insufficient-balance state (NOT
      `RateLimitNotice`), the Clear confirm dialog, and the brief success toast (§3.5). Standalone fallback
      `/settings/` opens with `activeSection='profile'` + modal.
- [ ] **Section 3 — Vault & posting power.** Wire `useVault` (`available`/`locked`/`lock`/`exit`/`inspect`/`phase`),
      `inspect(connectedWalletId)` on mount/wallet-change, the `TalkStake.AllowedStake` watch for "Posting power",
      lock/exit gating (already-locked / nothing-to-exit / busy / submitted / error), provider-unavailable hide, and
      the plain "N ADA locked" framing (no battery, no tx/block chrome). Link the Composer's `no_weight`
      `RateLimitNotice` here (`/settings#vault`).
- [ ] **Section 4 — Appearance.** Wire `useTheme()` + `ThemeToggle` (`02-/03-`); persist `cg-theme`; rely on the
      pre-paint boot script (`01-`) for no-flash; default dark; private-mode degrades silently.
- [ ] **Section 5 — Network.** Extend `EndpointSettings.tsx` for all four fields (Node `cogno.endpoints`, Indexer
      `cogno.graphql`, Blockfrost `cogno.blockfrost`, Follower `cogno.follower` under a collapsed "Legacy"
      disclosure). Keep validation in `lib/config/endpoints.ts`. Wire effects: Node Save → `useChain.reconnect()`
      (or documented reload), Indexer Save/Clear → re-memoize `useFeedSource` (search/Following/who-to-follow caps),
      Blockfrost Save/Clear → toggle `useVault.available`. Node status dot from `useChain().status`. Inline
      validation errors (`--cg-danger`, `aria-live`).
- [ ] **Section 6 — Advanced (Developer).** Collapsed disclosure: dev-account picker (`useSigner.devAccounts` +
      `setDevAccount`, persists `cogno.signer.devChoice`), read-only diagnostics (genesis via `getGenesisHex`, heads
      via `useHeads` — the ONLY block numbers in the app, bound-stake-cred hex). Keep it collapsed by default.
- [ ] **Section 7 — About.** Slim the existing `About.tsx`: remove all honesty / reading-room / endpoint-trust copy
      (`00-overview.md` mandate); keep name + one-liner + optional source link.
- [ ] **Honesty drop sweep.** Verify nothing on `/settings` renders a HonestyBadge / ProvenanceLine / AnchorStatus /
      CapacityBattery / "trusted follower" / "operator-run" / "signed ≠ finalized" / block-number chrome (except the
      Advanced diagnostics). The vault is framed as "posting power", endpoints as plain config.
- [ ] **Accessibility (§10).** Master/detail tablist + drill-down focus management, labelled inputs +
      `aria-live` errors, theme `radiogroup`/`aria-pressed`, copy `aria-label` + Toast live region, focus rings,
      reduced-motion swap.
- [ ] **Responsive (§9).** Desktop master/detail (RightRail suppressed), tablet/mobile drill-down, modal sheet on
      mobile; one React tree switched by CSS Modules width classes (no per-section routes).
- [ ] **Notifications seam (§11).** Leave the labelled deferred comment; render no section.
- [ ] **Tests (Vitest, MeshJS/PAPI mocked).** `endpoints.ts` setter validation (already has tests — extend for the
      Blockfrost effect), `sessionState` → Account sub-card selection, the funded-account gate (free < fee disables
      Save), the indexer-clear → caps-shrink (search/Following hidden) behavior, and `useTheme` persistence.
