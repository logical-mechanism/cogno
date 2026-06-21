# 11 — Surface: Onboarding / Auth (`/welcome`)

This doc specifies the **onboarding/auth surface** — route `/welcome`, the `WelcomePage` — plus the
`ConnectWalletButton` flow it shares with the rest of the app. This is X's "Sign in to cogno"
re-imagined as **wallet auth**: connect a Cardano CIP‑30 wallet → derive an sr25519 posting key from
one wallet signature (never stored) → bind that key 1:1 on‑chain with a **feeless unsigned CIP‑8
proof** (`CognoGate.link_identity_signed`) so the account can post → then two **optional power‑ups**
(lock 100 ADA into the L1 vault to earn posting capacity, and bind the wallet's stake key with
`CognoGate.link_stake_signed` to earn voting weight). It is presented as a clean, modern, X‑style
**multi‑step onboarding** (progress dots, one primary CTA per step, "Skip for now" on the optional
steps) with **zero honesty hedging** — no "signed ≠ finalized", no trusted‑follower labels, no
block‑number marginalia. It is the canonical **gate target** for any write intent attempted while not
connected or not identity‑bound. The honest dual‑key model is reflected only in plain, friendly copy.
The dev‑account (`//Alice`) fallback exists but lives **hidden in Settings** (see
`12-surface-settings.md`), never on `/welcome`.

> Cite siblings: tokens in `02-design-system.md`; components in `03-component-library.md`; the
> session state machine + write‑affordance gate + hooks/queries in `04-data-layer.md`; routing +
> nginx fallback in `01-information-architecture.md`; divergences in
> `05-divergences-and-constraints.md`. Use the canonical names verbatim. This file
> (`11-surface-onboarding-auth.md`) is the authoritative onboarding/auth spec.

---

## 1. Purpose, route, and where it is reached from

| | |
|---|---|
| **Route** | `/welcome` → `WelcomePage` (a `'use client'` page component; see `01-information-architecture.md` §route map). |
| **Static export** | Plain static route (no dynamic segment) — exported as `welcome/index.html`. No `generateStaticParams` needed. Deep‑linkable. |
| **Chrome** | **No sticky timeline header**; `/welcome` renders its **own centered onboarding chrome** (per `01-information-architecture.md` §sticky‑header table: "No sticky timeline header — centered onboarding flow"). It still mounts inside the persistent `AppShell`, but the LeftNav/RightRail collapse to give the flow center stage on desktop, and BottomTabBar is hidden on this route on mobile (full‑screen flow). |
| **Purpose** | The single place a reader becomes a writer: connect → derive → bind → (optional) power‑ups. Also the **gate target** for deferred write intent. |

**Entry points into `/welcome`:**

1. **`ConnectWalletButton`** in `LeftNav` (desktop) / its place in the empty‑states — when
   `viewer.status === 'not-connected'` it reads "Connect wallet"; when `'not-identity-bound'` it
   reads "Finish setup" (see `03-component-library.md` §20). Both route to `/welcome` (or open the
   flow inline; `/welcome` is the canonical full surface).
2. **Write‑intent funnel** — per the `04-data-layer.md` §5.2 gating table and
   `01-information-architecture.md` §6.4, any write affordance (Post CTA, Reply, Quote, Like,
   Repost, Follow, poll vote, Edit profile, the `ComposeFab`) clicked while `disconnected` or
   `connected_unbound` routes the user to `/welcome` to finish setup. **v1: the original click is NOT
   auto‑replayed** after setup — leave a follow‑up note (remember‑intent), do not build it now.
3. **Empty‑state CTAs** — the Home `For you` empty‑state and the Profile self CTA route here when not
   connected (`03-component-library.md` §EmptyState `feed` variant + §FollowButton self case).
4. **Direct deep link** — someone shares `/welcome`; the nginx `try_files $uri $uri/ /404.html`
   fallback (`01-information-architecture.md`) boots the shell and the client renders the flow.

**Post‑setup redirect:** once `viewer.status === 'ready'` (identity‑bound), `/welcome` shows the
"You're all set" success step with a primary **"Go to your timeline"** CTA → `router.push('/')`. If
the user arrived via a deferred write intent we still land them on `/` (not auto‑replay) in v1.

---

## 2. The flow as a state machine (canonical)

`/welcome` is a **stepper** driven entirely by the `SessionState` from `04-data-layer.md` §5.1
(derived by `sessionState(useSigner, useIdentity)`), plus two **optional, independent** power‑up
sub‑states layered on top (vault lock via `useVault`, stake bind via `useIdentity.bindStake`). The
core steps are **required and sequential**; the power‑ups are **skippable** and may be done now or
later in `/settings`.

```
SessionState (from 04-data-layer.md §5.1) ─────────────────────────────────────────────┐
  disconnected        → STEP 1  Connect wallet                                          │
  connecting          → STEP 1  (deriving spinner — sign-to-derive in flight)           │
  connected_unbound   → STEP 2  Confirm account  →  STEP 3  Bind identity (required)    │
  binding             → STEP 3  (binding spinner — CIP-8 bare submit in flight)         │
  bound / bound_no_stake / bound_staked → STEP 4  Power-ups (optional)  →  Done         │
└───────────────────────────────────────────────────────────────────────────────────────┘

Power-up sub-states (independent, both skippable, both also live in /settings):
  • Vault lock   : useVault.phase  idle → working → submitted (capacity lands ~blocks later)
  • Stake bind   : useIdentity.stakeBinding / stakeBound / votingPower
                   (requires bound === true; gated on a stake-signing wallet)
```

**Step model (canonical step ids — used in progress dots + analytics seams):**

| Step | id | Required? | Gate to enter | Primary action | Hook |
|---|---|:--:|---|---|---|
| 1 | `connect` | ✅ | always | Connect a CIP‑30 wallet → derive key | `useSigner.connectWallet(walletId)` |
| 2 | `account` | ✅ | `walletConnected` | Review derived account, continue | (display only) |
| 3 | `bind` | ✅ | `connected_unbound` | Bind identity (CIP‑8 feeless) | `useIdentity.bind(walletId)` |
| 4 | `powerups` | ⬜ skippable | `bound === true` | Lock 100 ADA and/or bind stake | `useVault.lock` / `useIdentity.bindStake` |
| — | `done` | — | `bound === true` | Go to timeline | `router.push('/')` |

> **Why steps 2 and 3 are distinct despite both being post‑connect:** the derived account is a real
> on‑chain identity the user should *see* (it's their `@handle`), and the bind is a separate wallet
> signature + on‑chain submit. Showing the account first makes the bind ("this is the account you're
> registering") legible. Both map to `connected_unbound`; the stepper advances `account → bind`
> within that single `SessionState` via local `welcomeStep` state.

---

## 3. Desktop wireframes (≥1020px, centered flow)

The flow is a **single centered column** (max‑width `480px`, `--cg-col-onboarding` capped narrower than the
600px feed), vertically centered on `--cg-bg`, with the cogno wordmark at top and a **progress dots**
row. LeftNav stays as a thin rail (or collapses to icon‑only) so the flow owns the canvas.

### 3.1 Step 1 — Connect wallet (`disconnected`)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ⬡ cogno-chain                                                             │
│                                                                            │
│                         ●  ○  ○  ○                                         │
│                                                                            │
│                    Join the conversation                                   │
│            Connect a Cardano wallet to start posting.                      │
│                                                                            │
│        ┌──────────────────────────────────────────────────┐               │
│        │  [E] Eternl                                    ›  │  ← wallet row  │
│        ├──────────────────────────────────────────────────┤               │
│        │  [L] Lace                                      ›  │               │
│        ├──────────────────────────────────────────────────┤               │
│        │  [N] Nami                                      ›  │               │
│        └──────────────────────────────────────────────────┘               │
│                                                                            │
│        No wallets found?  Install Eternl or Lace ↗   (when list empty)     │
│                                                                            │
│        Reconnect [Eternl] →   (only if lastWalletId persisted)             │
│                                                                            │
│              By connecting you agree to nothing — your keys                │
│              stay in your wallet. (one quiet reassurance line)             │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Step 1 — connecting (`connecting`, `useSigner.deriving === true`)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         ●  ○  ○  ○                                         │
│                                                                            │
│                    Check your wallet                                       │
│        ┌──────────────────────────────────────────────────┐               │
│        │  [E] Eternl            ◐ Waiting for signature…  │  (row spinner) │
│        └──────────────────────────────────────────────────┘               │
│                                                                            │
│        Approve the signature request in Eternl to create                  │
│        your posting key. This signs a message — it never                   │
│        moves any funds.                                                    │
│                                                          [ Cancel ]        │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Step 2 — Confirm account (`connected_unbound`, `welcomeStep==='account'`)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         ●  ●  ○  ○                                         │
│                                                                            │
│                    This is your account                                    │
│                                                                            │
│                   ┌────────────┐                                          │
│                   │  (identicon)│   ← Avatar (identicon from ss58)         │
│                   └────────────┘                                          │
│                   5Grw…  utQY        ← Handle (mono, middle-truncated)     │
│                   derived from Eternl                                       │
│                                                                            │
│        Your posting key was created from your wallet                       │
│        signature. We don't store it — you'll re-create it                  │
│        by connecting again next time.                                      │
│                                                                            │
│        ┌──────────────────────────────────────────────────┐               │
│        │             Continue                              │  (accent pill)│
│        └──────────────────────────────────────────────────┘               │
│        Use a different wallet                                              │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.4 Step 3 — Bind identity (`connected_unbound`, `welcomeStep==='bind'`) + `binding`

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         ●  ●  ●  ○                                         │
│                                                                            │
│                    One more step to post                                   │
│                                                                            │
│        Register 5GrwutQY so it can post. Your wallet will                  │
│        sign once to prove this account is yours. It's free                 │
│        and there's no transaction fee.                                     │
│                                                                            │
│        ┌──────────────────────────────────────────────────┐               │
│        │             Register account                      │  (accent pill)│
│        └──────────────────────────────────────────────────┘               │
│                                                                            │
│  ── while binding ──                                                       │
│        ┌──────────────────────────────────────────────────┐               │
│        │       ◐  Registering…                             │  (disabled)   │
│        └──────────────────────────────────────────────────┘               │
│        Approve the signature in your wallet…                               │
│                                                                            │
│  ── on error (e.g. wallet rejected / already bound) ──                     │
│        ⚠  That didn't work. <reason>           [ Try again ]              │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.5 Step 4 — Power‑ups (`bound`) + Done

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         ●  ●  ●  ●                                         │
│                                                                            │
│                    You're all set 🎉                                       │
│        You can post, reply, repost, and follow right now.                  │
│                                                                            │
│        ┌──────────────────────────────────────────────────┐               │
│        │             Go to your timeline                   │  (accent pill)│
│        └──────────────────────────────────────────────────┘               │
│                                                                            │
│   ── Optional power-ups (collapsible cards) ──                            │
│   ┌────────────────────────────────────────────────────────┐              │
│   │  Lock ADA to post more                                  │              │
│   │  Lock 100 ADA in the vault to raise your posting        │              │
│   │  limit. You can unlock it anytime.                      │              │
│   │              [ Lock 100 ADA ]   Skip for now            │              │
│   └────────────────────────────────────────────────────────┘              │
│   ┌────────────────────────────────────────────────────────┐              │
│   │  Add voting power                                       │              │
│   │  Prove your wallet's stake to make your votes count.    │              │
│   │              [ Add voting power ]   Skip for now        │              │
│   └────────────────────────────────────────────────────────┘              │
│                                                                            │
│        You can do these later in Settings.                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Mobile wireframes (<688px, full‑screen flow)

Full‑bleed single column, `--cg-space-4` side padding, BottomTabBar hidden on `/welcome`. Wallet
rows are full‑width tappable (≥44px hit target). Progress dots pinned under a minimal top bar with a
back/close affordance.

### 4.1 Mobile — Step 1 (connect) and connecting

```
┌───────────────────────────────┐     ┌───────────────────────────────┐
│ ⬡ cogno-chain            ✕    │     │ ⬡ cogno-chain            ✕    │
│        ● ○ ○ ○                │     │        ● ○ ○ ○                │
│                               │     │                               │
│   Join the conversation       │     │   Check your wallet           │
│   Connect a wallet to post.   │     │                               │
│ ┌───────────────────────────┐ │     │ ┌───────────────────────────┐ │
│ │ [E] Eternl             ›  │ │     │ │ [E] Eternl   ◐ Waiting…   │ │
│ ├───────────────────────────┤ │     │ └───────────────────────────┘ │
│ │ [L] Lace               ›  │ │     │                               │
│ ├───────────────────────────┤ │     │ Approve the signature in      │
│ │ [N] Nami               ›  │ │     │ Eternl to create your         │
│ └───────────────────────────┘ │     │ posting key.                  │
│                               │     │                               │
│ No wallets? Install Eternl ↗  │     │           [ Cancel ]          │
│ Reconnect Eternl →            │     │                               │
└───────────────────────────────┘     └───────────────────────────────┘
```

### 4.2 Mobile — Step 3 (bind) and Step 4 (done + power‑ups)

```
┌───────────────────────────────┐     ┌───────────────────────────────┐
│ ⬡ cogno-chain            ✕    │     │ ⬡ cogno-chain                 │
│        ● ● ● ○                │     │        ● ● ● ●                │
│                               │     │   You're all set 🎉           │
│   One more step to post       │     │ ┌───────────────────────────┐ │
│                               │     │ │     Go to your timeline    │ │
│ Register 5GrwutQY so it can   │     │ └───────────────────────────┘ │
│ post. Your wallet signs once  │     │                               │
│ — free, no fee.               │     │ ┌── Lock ADA to post more ──┐ │
│ ┌───────────────────────────┐ │     │ │  Lock 100 ADA …           │ │
│ │     Register account      │ │     │ │  [ Lock 100 ADA ]  Skip   │ │
│ └───────────────────────────┘ │     │ └───────────────────────────┘ │
│                               │     │ ┌── Add voting power ───────┐ │
│ ⚠ <error>      [ Try again ] │     │ │  [ Add voting power ] Skip │ │
│                               │     │ └───────────────────────────┘ │
└───────────────────────────────┘     └───────────────────────────────┘
```

---

## 5. Component composition

`/welcome`'s `WelcomePage` is a thin orchestrator over canonical components from
`03-component-library.md` plus a small set of **welcome‑local** subcomponents (named here, owned by
this surface):

```
WelcomePage  ('use client')
├─ <WelcomeShell>                      ← centered chrome: wordmark + ProgressDots + slot
│   ├─ cogno wordmark (links '/')
│   ├─ <ProgressDots step={welcomeStep} total={4} />   (welcome-local)
│   └─ {stepContent}
├─ step 'connect'  → <WalletPicker>    (welcome-local; wraps ConnectWalletButton semantics)
│     ├─ <WalletRow walletId name icon onSelect />   (per listCardanoWallets())
│     ├─ empty → <EmptyState variant='no-wallets'>  (install links)
│     └─ <ReconnectRow lastWalletId>   (when useSigner.lastWalletId)
├─ step 'account' → <AccountConfirm>   (welcome-local)
│     ├─ <Avatar address={signer.ss58} size='xl' />          (identicon fallback)
│     ├─ <DisplayName/> (fallback) + <Handle ss58={signer.ss58} />
│     └─ primary button "Continue"  +  "Use a different wallet"
├─ step 'bind'    → <BindStep>         (welcome-local)
│     ├─ primary button "Register account" → useIdentity.bind(walletId)
│     ├─ Spinner + narration while binding
│     └─ inline error + Retry  (uses Toast for transient failures)
├─ step 'powerups'→ <PowerUps>         (welcome-local)
│     ├─ <DoneBanner> + "Go to your timeline"
│     ├─ <VaultCard>  → useVault.lock(walletId)       (cites 12-surface-settings.md)
│     └─ <StakeCard>  → useIdentity.bindStake(walletId)
└─ <Toaster/> mount is global (AppShell); WelcomePage raises Toasts via useMutation/useTheme seams
```

**Shared component reuse (do not redefine):** `Avatar`, `DisplayName`, `Handle`, `Spinner`,
`EmptyState`, `Toaster/Toast`, `ConnectWalletButton` (for the LeftNav/empty‑state entry points), and
all `--cg-*` tokens + the accent pill button style from `02-design-system.md`. The accent pill is the
**single primary CTA per step**; secondary affordances ("Skip for now", "Use a different wallet") are
text/ghost buttons in `--cg-text-secondary`.

---

## 6. Hooks, data, and exact calls

This surface is **mostly write + local state**; its only reads are the live `bound`/`stakeBound`/
`votingPower` watches inside `useIdentity` and the optional `useVault.inspect`. It does **not** issue
any GraphQL feed query — there is no timeline here. (Cross‑ref `04-data-layer.md` §5 + §7.)

### 6.1 Hooks consumed (all already specified in `04-data-layer.md` §7)

| Hook | Used for | Key fields read |
|---|---|---|
| `useChain()` | the PAPI `api` + `client` (bare submit) + `boot` guard | `api`, `client`, `boot`, `wsUrl`, `status` |
| `useSigner()` | wallet connect + derive + dev fallback | `connectWallet(walletId)`, `deriving`, `error`, `walletConnected`, `connectedWalletId`, `walletAddress`, `lastWalletId`, `disconnect`, `signer` |
| `useIdentity(api, client, signer)` | identity bind + stake bind + live bound watch | `bound`, `binding`, `error`, `bind(walletId)`, `boundAddress`, `stakeBound`, `votingPower`, `bindStake(walletId)`, `stakeBinding`, `stakeError` |
| `useVault()` | optional 100‑ADA lock power‑up | `available`, `lock(walletId)`, `phase`, `busy`, `error`, `txHash`, `locked`, `inspect(walletId)` |
| `useTheme()` | (inherited from AppShell) | — |
| derived `sessionState(...)` | drive the stepper | `04-data-layer.md` §5.1 |

`WelcomePage` derives its own `welcomeStep` from `SessionState` + a local sub‑step within
`connected_unbound`:

```ts
// inside WelcomePage
const session = sessionState(signer, identity);   // 04-data-layer.md §5.1
const [subStep, setSubStep] = useState<'account' | 'bind'>('account');

const welcomeStep =
  session === 'connecting'                                ? 'connect'  :
  session === 'disconnected'                              ? 'connect'  :
  session === 'binding'                                   ? 'bind'     :
  session === 'connected_unbound'                         ? subStep    :   // 'account' then 'bind'
  /* bound / bound_no_stake / bound_staked */               'powerups';
```

### 6.2 Exact extrinsics + Cardano calls per interaction

| Interaction (step) | Function | Underlying call | Fee / signing |
|---|---|---|---|
| **List wallets** (1) | `listCardanoWallets()` (`lib/cardano/cip8.ts`) | `BrowserWallet.getInstalledWallets()` | none (read) |
| **Connect + derive** (1) | `useSigner.connectWallet(walletId)` → `deriveSignerFromWallet(walletId)` | `BrowserWallet.enable` → `wallet.signData(DERIVE_MESSAGE)` → `blake2b_256(sig)` → sr25519 seed | wallet **data signature** (CIP‑8), no on‑chain tx, no funds |
| **Bind identity** (3) | `useIdentity.bind(walletId)` | `getGenesisHex(api)` → `produceBindProof({walletId, sr25519PubkeyHex, genesisHex})` → `submitLinkIdentityFeeless(client, api, coseSign1, coseKey)` → `api.tx.CognoGate.link_identity_signed(...).getBareTx()` + `client.submit(...)` → `AccountOf` readback | wallet **data signature** (CIP‑8) + **FEELESS UNSIGNED BARE** extrinsic — **no fee, no nonce, no funded sponsor** |
| **Bind stake** (4, optional) | `useIdentity.bindStake(walletId)` | `produceBindProofStake({...})` (stake‑key CIP‑8 over reward address) → `submitLinkStakeFeeless(...)` → `api.tx.CognoGate.link_stake_signed(...).getBareTx()` + `client.submit(...)` | wallet **stake‑key data signature** + **FEELESS UNSIGNED BARE**; **requires `bound===true`** (`NotPaymentBound` otherwise) |
| **Lock 100 ADA** (4, optional) | `useVault.lock(walletId)` → `lockIntoVault(walletId, MIN_LOCK)` | MeshJS `MeshTxBuilder` lock at `talk_vault` (mint owner beacon, lock `MIN_LOCK` lovelace) submitted via Blockfrost (`lib/cardano/provider.ts`) | a **real Cardano L1 tx** (network fee in tADA, from the wallet); capacity weight lands a few blocks later when the off‑chain follower observes the beacon |

**Argument shapes (grounded in `lib/chain/identity.ts`):** `link_identity_signed(cose_sign1:
BoundedVec<u8,512>, cose_key: BoundedVec<u8,128>, thread_pointer: Option<Vec<u8>>)` — built with
`Binary.fromBytes(...)`, `thread_pointer` passed `undefined` on `/welcome` (no pointer needed for a
fresh bind). `link_stake_signed(cose_sign1, cose_key)` — **two blobs only, no thread pointer**.

### 6.3 Bind‑complete confirmation (no honesty chrome, just correctness)

`useIdentity.bind` already does the **`AccountOf` readback** (`readAccountOf(api, idHash) ===
signer.ss58`) and an `isAccountBound` re‑check before flipping `bound = true`. `/welcome` advances to
the `powerups` step **only** when the hook reports `bound === true` (it watches live). We surface
this as a silent success transition — **no "finalized" chip, no block number** (per
`05-divergences-and-constraints.md` D11). A single celebratory micro‑state ("You're all set") is the
only feedback.

### 6.4 No GraphQL queries on this surface

`/welcome` issues **no `FEED`/`PROFILE_*`/`THREAD`/`POLL`/`VIEWER_STATES` queries** (those are
defined in `04-data-layer.md` §6 and used by the timeline/profile/thread surfaces). The only data
reads are PAPI storage watches inside `useIdentity` (`CognoGate.PkhOf`, `CognoGate.StakeCredOf`,
`TalkStake.VotingPower`) and the optional `useVault.inspect` (Blockfrost). The PAPI‑direct vs indexer
`FeedCaps` distinction is irrelevant here — **onboarding never depends on the indexer**, so it works
identically whether or not a GraphQL URL is configured. (This is intentional: a user can always
onboard even if `caps.search/pagination/profiles` are false.)

---

## 7. Every UI state (exhaustive)

States are keyed to `SessionState` + the per‑hook flags. "Toast" = `Toaster/Toast`
(`03-component-library.md`); "inline" = rendered in the step body.

### 7.1 Step 1 — Connect

| State | Trigger | UI |
|---|---|---|
| **idle / list** | `disconnected`, wallets found | `<WalletPicker>` lists each `listCardanoWallets()` row (icon + name + chevron). |
| **empty (no wallets)** | `disconnected`, `listCardanoWallets()` returns `[]` | `<EmptyState variant='no-wallets'>`: "No Cardano wallet found." + install links (Eternl ↗ / Lace ↗). Reconnect row hidden. |
| **reconnect hint** | `useSigner.lastWalletId` set | A `<ReconnectRow>` above/below the list: "Reconnect [Eternl] →" — one‑click `connectWallet(lastWalletId)`. |
| **connecting / deriving** | `connecting` (`useSigner.deriving`) | Selected wallet row shows inline Spinner + "Waiting for signature…"; body narration "Approve the signature…"; **Cancel** resets to idle (no `disconnect` needed — derive is in‑flight; Cancel just dismisses the spinner/ignores the promise). |
| **wallet rejected** | `connectWallet` rejects (user declined `signData`) | Toast (error): "Connection cancelled." Stay on step 1, list re‑enabled. `useSigner.error` cleared on next attempt. |
| **non‑vkey address** | `deriveSignerFromWallet` throws "connect a normal wallet address…" (script/vault payment cred) | inline error under the row: "That's a script/contract address. Connect a normal wallet account." (the derive guard refuses script credentials). |
| **no signature returned** | wallet returns empty `signData` | Toast (error): "Your wallet didn't return a signature. Try again." |
| **wallet not installed mid‑flow** | `BrowserWallet.enable` throws | inline: "Couldn't open <wallet>. Is it installed and unlocked?" |

### 7.2 Step 2 — Confirm account

| State | Trigger | UI |
|---|---|---|
| **review** | `connected_unbound` & `subStep==='account'` | `Avatar` (identicon from `signer.ss58`) + `Handle` (mono truncated) + "derived from <wallet>" + "Continue" + "Use a different wallet" (→ `disconnect()` then back to step 1). |
| **already bound (fast‑path)** | on connect, `bound===true` immediately (returning user, same wallet/account) | **Skip step 3 entirely** → jump to `powerups` with a "Welcome back" `DoneBanner`. (The live `bound` watch resolves to `true` before the user can click Continue; the stepper honors `welcomeStep` derivation in §6.1.) |

### 7.3 Step 3 — Bind identity

| State | Trigger | UI |
|---|---|---|
| **ready to bind** | `connected_unbound` & `subStep==='bind'` | Body copy + primary "Register account" (`useIdentity.bind(walletId)`). |
| **binding** | `binding` (`useIdentity.binding`) | Button → disabled Spinner "Registering…"; narration "Approve the signature in your wallet…". |
| **success** | `bound` flips to `true` | Auto‑advance to `powerups`; subtle success Toast suppressed in favor of the Done step (no double‑celebration). |
| **wallet rejected** | `produceBindProof` returns `!ok` (user declined the CIP‑8 sign) | inline error: "Signature declined. Try again." + **Try again**. |
| **proof failed** | `produceBindProof` `!ok` for malformed payload / pre‑flight (non‑vkey, size bound) | inline: "Couldn't create the proof — <reason>." + Try again. |
| **already bound (race / re‑submit)** | `submitLinkIdentityFeeless` rejected because identity already linked, OR `AccountOf` readback shows it's already mine | If it resolves to **my** ss58 → treat as success, advance. If it resolves to a **different** account → hard error "This identity is registered to another account." (the hook already throws "refusing to claim it"). |
| **bound‑elsewhere mismatch** | `AccountOf[idHash] !== signer.ss58` | inline danger: "That wallet is already linked to a different posting key. Use a different wallet." (Do **not** advance.) |
| **submit rejected (validity)** | `client.submit` returns `!res.ok` (e.g. `InvalidTransaction` at pool, duplicate) | inline: "The network rejected the registration — <dispatch/validity reason>." + Try again. |
| **chain still unbound** | submit ok but `isAccountBound` re‑check false | inline: "Registration didn't take — please try again." + Try again (hook surfaces this exact message). |

### 7.4 Step 4 — Power‑ups + Done

| State | Trigger | UI |
|---|---|---|
| **done banner** | `bound===true` | "You're all set" + "Go to your timeline" (→ `/`). |
| **vault: provider missing** | `useVault.available === false` (no Blockfrost id) | `<VaultCard>` shows a disabled "Lock 100 ADA" + small note "Add a Cardano provider in Settings to lock." Link → `/settings`. |
| **vault: ready** | `available===true` | "Lock 100 ADA" enabled. |
| **vault: working** | `useVault.phase==='working'` | Button → Spinner "Locking…" + "Confirm the transaction in your wallet…". |
| **vault: submitted** | `phase==='submitted'` | Card flips to "Locked ✓ Your posting limit will rise shortly." (capacity lands a few blocks later — say "shortly", **never** show a battery or block count). `txHash` not surfaced as marginalia. |
| **vault: error** | `phase==='error'` | inline card error + Retry (`useVault.reset()` then `lock` again). Common: insufficient tADA → "Your wallet doesn't have enough ADA. Top up and try again." |
| **stake: ready** | `bound===true`, wallet supports stake signing | "Add voting power" → `useIdentity.bindStake(walletId)`. |
| **stake: pre‑gate fail** | `bound !== true` | (cannot reach this card — `powerups` requires bound). Defensive copy if shown: "Register your account first." |
| **stake: binding** | `stakeBinding` | Spinner "Adding voting power…" + "Approve the stake signature…". |
| **stake: success** | `stakeBound` flips true | Card → "Voting power added ✓"; `votingPower` lands a few blocks later (watched) → "Your votes now count." |
| **stake: wallet can't stake‑sign** | `produceBindProofStake` `!ok` (wallet won't sign over a reward address — e.g. Nami) | inline: "This wallet can't prove its stake. Try Eternl or Lace." |
| **stake: rejected** | `submitLinkStakeFeeless` `!ok` / user declined | inline: "Couldn't add voting power — <reason>." + Try again. |
| **skip** | "Skip for now" on either card | Card collapses; "You can do these later in Settings." remains. Does not block "Go to your timeline." |

### 7.5 Cross‑cutting states

| State | Trigger | UI |
|---|---|---|
| **chain connecting** | `useChain.status === 'connecting' / 'reconnecting'` | Steps 1–2 (no chain needed) still render; the **Bind** primary is disabled with "Connecting to the network…" until `api`/`client` ready (`useIdentity.bind` no‑ops without `api && client`). |
| **boot‑guard fail (spec mismatch)** | `useChain.boot.ok === false` | Disable the **bind** + **power‑up** writes with a quiet inline note "The app needs an update to register — reading still works." (No honesty framing; this is just a "try again later".) Connect/derive (step 1–2) still work. See `lib/types.ts` `BootGuard`. |
| **network mismatch (wrong Cardano network)** | wallet is on **mainnet** but the app targets **preprod** (detect via `wallet.getNetworkId()` ≠ expected; or `produceBindProof` genesis/address mismatch) | inline error on step 1/3: "Switch your wallet to the Cardano preprod testnet, then reconnect." Block the derive/bind until corrected. |
| **WelcomeShell loading** | first paint pre‑hydration | `<Spinner>` centered; the wordmark + dots render statically (SSG‑safe, no `window` at module‑eval). |
| **theme** | inherited | Honors `[data-theme]` from `02-design-system.md`; dark default. The `ThemeToggle` is **not** placed on `/welcome` (it lives in RightRail/Settings); the flow simply respects the active theme. |

---

## 8. Persistent session (what survives reload)

The session is **derived, not stored** — only **non‑secret hints** persist:

| Persisted (localStorage) | Key | What | Why |
|---|---|---|---|
| Last wallet id | `cogno.wallet.last` | the CIP‑30 wallet id (e.g. `"eternl"`) | offers one‑click **Reconnect** (step 1) — re‑derives the same key by re‑signing |
| Dev choice (advanced only) | `cogno.signer.devChoice` | a dev URI (`//Alice`) | only when a dev account was explicitly chosen in Settings — **never on `/welcome`** |

**NOT persisted (re‑created each session):**

- The **sr25519 posting key / seed** — derived fresh from a wallet signature each connect. There is
  no key to back up, no password (per `wallet-derive.ts` security note: the signature stays in
  memory, never published; worst case is impersonation, never theft).
- The **bound state** — read live from chain (`CognoGate.PkhOf`), never cached as truth.
- The **stake / voting power** — read live (`CognoGate.StakeCredOf`, `TalkStake.VotingPower`).

**Reload behavior:** on reload the app starts `disconnected` (no wallet enabled), shows the
Reconnect hint if `lastWalletId` is set, and the user re‑signs to re‑derive. Once re‑derived, the
live `bound` watch resolves to `true` (they're already registered on chain), so `/welcome` (if
visited) fast‑paths to the `powerups`/`done` step and the rest of the app treats them as `ready`.
**Re‑binding is not required on reload** — the bind is permanent on chain; only the in‑memory posting
key is re‑created.

---

## 9. Write‑gate integration (how the rest of the app uses this surface)

Per `04-data-layer.md` §5.2 and `01-information-architecture.md` §6.4, every write affordance gates on
`viewer.status` (`03-component-library.md` §0.4):

| `viewer.status` | Write affordance behavior | This surface's role |
|---|---|---|
| `not-connected` (`disconnected`) | CTA label/route → **Connect** | `ConnectWalletButton` opens `/welcome` step 1 |
| `not-identity-bound` (`connected_unbound`) | CTA label "Finish setup" → **bind** | `/welcome` step 3 (or the Composer's inline "Finish setting up…" prompt that calls `useIdentity.bind` directly — same hook) |
| `ready` (`bound*`) | CTA enabled, submits | `/welcome` not needed; account chip shown in LeftNav instead of `ConnectWalletButton` |

- **Deferred intent (v1):** clicking a write affordance while gated routes to `/welcome` and does
  **not** auto‑replay the action after setup (note the remember‑intent follow‑up). The Composer is
  the one exception that offers an **inline** finish‑setup prompt (a Bind button calling
  `useIdentity.bind(walletId)`) so a user can bind without leaving the composer — that inline prompt
  reuses the exact same hook this surface drives (`03-component-library.md` §Composer states).
- **Voting without stake is allowed:** `bound_no_stake` is **not** a hard gate — votes submit at
  weight 0. `/welcome` therefore never blocks "Go to your timeline" on the stake bind; the stake card
  is purely a power‑up (cross‑ref `04-data-layer.md` §5.1 note + `05-divergences-and-constraints.md`
  D2/D12).

---

## 10. Dev‑account fallback (`//Alice`) — hidden, not on `/welcome`

The `//Alice` (and other `DEV_ACCOUNTS`) path exists for operator/testing use **without a wallet**,
via `useSigner.setDevAccount(uri)`. It is **deliberately absent from `/welcome`** — onboarding is
wallet‑first and consumer‑shaped. The dev toggle lives in **Settings → Advanced** (see
`12-surface-settings.md`); selecting a dev account sets `postingEnabled` true and `signer.kind
=== 'dev'`. When a dev account is active, `/welcome` (if visited) reflects the same `SessionState`
machine (a dev account is `connected_unbound` until bound — and a dev account like `//Alice` is
typically pre‑bound or bound via committee, so it shows `ready`). Do **not** surface any dev affordance
on the onboarding surface; keep the consumer flow clean.

---

## 11. Responsive behavior

| Breakpoint | Layout |
|---|---|
| **Mobile <688px** | Full‑screen flow, `--cg-space-4` side padding, BottomTabBar hidden, ComposeFab hidden. Wallet rows full‑width, ≥44px tall. Close (✕) → `history.back()` or `/`. Progress dots under a minimal top bar. |
| **Tablet 688–1019px** | Centered `480px` column on `--cg-bg`. Collapsed icon LeftNav per IA; no RightRail. |
| **Desktop ≥1020px** | Centered `480px` column; LeftNav thin/icon rail, RightRail suppressed on `/welcome` (the flow owns the canvas). |
| **center cap** | `480px` max content width (narrower than the 600px feed cap, to feel like an auth card). |

The step content reflows but the **step semantics never change** across breakpoints — same hooks,
same calls, same states.

---

## 12. Accessibility

- **Focus management:** on each step transition, move focus to the step `<h1>` (e.g. "Join the
  conversation") with `tabIndex={-1}` so screen readers announce the new step. The primary CTA is the
  first focusable interactive after the heading.
- **Progress:** `<ProgressDots>` renders `role="progressbar"` `aria-valuenow={step}` `aria-valuemax={4}`
  `aria-label="Setup progress"`; the active dot uses `--cg-accent`, completed dots filled, pending
  `--cg-border`.
- **Wallet rows:** each `<WalletRow>` is a `<button>` with `aria-label="Connect with Eternl"`;
  Enter/Space activate; the loading row sets `aria-busy="true"`.
- **Live regions:** the binding/locking narration ("Approve the signature…", "Registering…") sits in
  an `aria-live="polite"` region so the wait state is announced. Errors use `role="alert"`
  (assertive) so a rejection is read immediately.
- **Keyboard:** `Esc` closes/cancels the in‑flight signature spinner (returns to the list) and closes
  the flow on mobile. No `j/k`/`n` feed shortcuts apply here (no feed). Tab order: heading → primary
  CTA → secondary text buttons → wallet list.
- **Buttons:** the accent pill CTA meets the AA contrast pairing from `02-design-system.md`
  (`--cg-accent` + `--cg-accent-contrast`). Disabled states use `aria-disabled` + a tooltip/inline
  reason (never a bare greyed button with no explanation).
- **Reduced motion:** the "You're all set 🎉" celebration and any dot transitions respect
  `prefers-reduced-motion` (no confetti/pop; cross‑ref `02-design-system.md` motion tokens).
- **Identicon:** `Avatar` identicon fallback has `alt="Your account avatar"`; the `Handle` exposes a
  copy‑to‑clipboard with an `aria-label="Copy your account address"`.

---

## 13. Honesty‑layer purge (what is intentionally absent)

Per `00-overview.md` + `05-divergences-and-constraints.md` (D7, D11): **no** "verified" badge, **no**
"trusted follower" label, **no** "signed ≠ finalized", **no** block numbers / finalized chips, **no**
anchor/provenance UI, **no** capacity battery. The dual‑key model surfaces **only** as friendly copy
("Your posting key was created from your wallet signature. We don't store it."). The "free, no
transaction fee" line on the bind step is the only chain‑economics mention, framed as a user benefit,
not a trust disclaimer.

---

## 14. Errors → copy table (canonical microcopy)

| Failure | Surface | Copy |
|---|---|---|
| User declines connect signature | Toast | "Connection cancelled." |
| Wallet returns no signature | Toast | "Your wallet didn't return a signature. Try again." |
| Script/vault (non‑vkey) address | inline (step 1) | "That's a script/contract address. Connect a normal wallet account." |
| Wallet not installed/unlocked | inline (step 1) | "Couldn't open <wallet>. Is it installed and unlocked?" |
| No wallets installed | EmptyState (step 1) | "No Cardano wallet found." + install links |
| Wrong network (mainnet vs preprod) | inline (step 1/3) | "Switch your wallet to the Cardano preprod testnet, then reconnect." |
| User declines bind signature | inline (step 3) | "Signature declined. Try again." |
| Proof malformed / pre‑flight fail | inline (step 3) | "Couldn't create the proof — <reason>." |
| Identity bound to another account | inline danger (step 3) | "That wallet is already linked to a different posting key. Use a different wallet." |
| Submit rejected at pool | inline (step 3) | "The network rejected the registration — <reason>." |
| Bind didn't take (chain still unbound) | inline (step 3) | "Registration didn't take — please try again." |
| Chain connecting / boot‑guard fail | inline (disabled CTA) | "Connecting to the network…" / "The app needs an update to register — reading still works." |
| Vault: no provider | VaultCard | "Add a Cardano provider in Settings to lock." |
| Vault: insufficient ADA | VaultCard | "Your wallet doesn't have enough ADA. Top up and try again." |
| Stake: wallet can't stake‑sign | StakeCard | "This wallet can't prove its stake. Try Eternl or Lace." |

All `<reason>` interpolations come from the hook's `error`/`stakeError`/`useVault.error` strings
(already stringified via `stringifyDispatchError`/`stringifyError` in `lib/chain/post.ts`).

---

## 15. Notifications hook (DEFERRED — leave the seam)

Onboarding is the natural place to (later) prompt "turn on notifications", but **do not build it
now**. Leave a single labeled comment near the `done` step: a future `useNotifications(who)`
(`04-data-layer.md` §5.4) folds the indexer's `Voted`/`Reposted`/`Followed`/reply‑`PostCreated`/quote
edges targeting the viewer into a `/notifications` surface. The hook slot is named; this surface adds
nothing further.

---

## 16. Implementation checklist (ordered)

- [ ] **Route + page:** create `src/app/welcome/page.tsx` (`'use client'`) → `WelcomePage`; ensure
      it exports statically as `welcome/index.html` (no `generateStaticParams`).
- [ ] **WelcomeShell:** centered chrome (wordmark → `/`, `<ProgressDots>`, slot); suppress RightRail
      and (mobile) BottomTabBar/ComposeFab on this route via the `AppShell` route check
      (`01-information-architecture.md`).
- [ ] **ProgressDots** (welcome‑local): `role="progressbar"`, accent active dot, 4 total.
- [ ] **Derive `welcomeStep`** from `sessionState(useSigner, useIdentity)` (§6.1) + local
      `subStep('account'|'bind')`; fast‑path to `powerups` when `bound===true` on connect.
- [ ] **Step 1 — WalletPicker:** call `listCardanoWallets()`; render `<WalletRow>` per wallet; empty
      → `<EmptyState variant='no-wallets'>` with install links; `<ReconnectRow>` when
      `useSigner.lastWalletId`; on select → `useSigner.connectWallet(walletId)`.
- [ ] **Step 1 states:** connecting spinner on the chosen row + narration + Cancel; map
      `useSigner.error` / derive errors to the §14 copy (rejected, non‑vkey, no‑signature,
      not‑installed, network‑mismatch).
- [ ] **Step 2 — AccountConfirm:** `<Avatar address={signer.ss58} size='xl'>` (identicon) +
      `<Handle>` + "derived from <wallet>" + "Continue" (→ `subStep='bind'`) + "Use a different
      wallet" (→ `useSigner.disconnect()`).
- [ ] **Step 3 — BindStep:** "Register account" → `useIdentity.bind(connectedWalletId!)`; disable +
      Spinner while `binding`; on `bound===true` auto‑advance; render all §7.3 error states inline
      with Try again; the `AccountOf` mismatch → hard danger (no advance).
- [ ] **Guard writes on chain readiness:** disable bind/power‑up CTAs until `api && client` ready and
      `useChain.boot.ok`; show "Connecting to the network…" / boot‑guard note.
- [ ] **Step 4 — PowerUps:** `<DoneBanner>` + "Go to your timeline" (`router.push('/')`); `<VaultCard>`
      (`useVault.available`/`lock`/`phase`/`error`, capacity "lands shortly", no battery) citing
      `12-surface-settings.md`; `<StakeCard>` (`useIdentity.bindStake`/`stakeBinding`/`stakeBound`/
      `votingPower`, stake‑wallet gate). "Skip for now" collapses each card; neither blocks Done.
- [ ] **Persistence:** rely on `useSigner` for `cogno.wallet.last` (reconnect hint); **do not** store
      the key or `bound` state; confirm reload starts `disconnected` and re‑derives.
- [ ] **Dev fallback OFF here:** no dev‑account UI on `/welcome`; it lives in Settings → Advanced
      (`12-surface-settings.md`).
- [ ] **Toasts:** wire connect/bind/stake/vault failures to `Toaster` per §14; success transitions
      are silent (the Done step is the only celebration); respect `prefers-reduced-motion`.
- [ ] **Accessibility:** focus the step heading on transition; `aria-live` narration; `role="alert"`
      errors; wallet rows as labelled buttons; Esc cancels in‑flight signature; AA‑contrast accent
      pill; identicon `alt`.
- [ ] **Responsive:** verify mobile full‑screen (BottomTabBar/FAB hidden), tablet/desktop centered
      `480px` column, RightRail suppressed.
- [ ] **Honesty purge:** confirm no "verified", no trust labels, no block numbers, no battery, no
      anchor UI anywhere on this surface.
- [ ] **Notifications seam:** leave the labeled deferred comment near the `done` step (no surface).
