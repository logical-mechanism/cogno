# 09 — Surface: Compose

The **compose** surface is the write engine of the whole app: the route `/compose` plus the
`ComposerModal` overlay that opens from anywhere (LeftNav "Post" pill, mobile `ComposeFab`, a
`PostCardActions` Reply/Quote, the "Poll" toggle). It owns every authoring flow — a top-level **post**,
a **reply**, a **quote**, and a **poll** — re-skinned as a faithful Twitter/X composer (avatar gutter,
auto-growing textarea, the circular `ByteCounter` ring counting **UTF-8 bytes** toward 512, a pill
**Post** CTA), but stripped to *chain-backed* affordances: **no media button, no GIF/image/emoji-as-media,
no location, and no audience selector** (none exist on-chain). Submission is **optimistic** — the modal
closes, the new card appears at the top of the relevant timeline as `pending`, and reconciles or rolls
back per `04-data-layer.md` §3.3. Capacity is invisible until exhausted: when `useCapacity` says the draft
is unpostable, the **Post** CTA disables and a Twitter-style `RateLimitNotice` appears (never a battery).
The two surfaced chain realities are the rate-limit notice and a quiet failure `Toast`; everything else is
silent. This doc specifies the modal-vs-page presentation, the four modes, exact extrinsic calls with arg
encoding, every UI state, responsive behavior, accessibility, and an ordered implementation checklist.

> **Citations.** Tokens, ring colors, motion, geometry: `02-design-system.md` (`--cg-*`). Components
> (`Composer`, `ComposerModal`, `ReplyComposer`, `QuoteComposer`, `PollComposer`, `ByteCounter`,
> `QuotedPostEmbed`, `RateLimitNotice`, `Avatar`, `Toaster/Toast`, `Spinner`): `03-component-library.md`
> §7–§11. Mutations, capacity gate, session/identity gating, query names: `04-data-layer.md` §3/§4/§5.
> Divergences (D1 bytes, D5 rate-limit, D7 identity-bind, D11 optimistic): `05-divergences-and-constraints.md`.
> The modal-route host, breakpoints, sticky-header, and `/compose` full-page fallback: `01-information-architecture.md`
> §5/§7. **Reuse every name from those docs verbatim. Do not redefine tokens or components here.**

---

## 1. Route & presentation model

The composer appears in **two presentations** backed by the **same** `Composer` base component
(`03-component-library.md` §7):

| Presentation | When | Chrome | URL |
|---|---|---|---|
| **`ComposerModal` overlay** | clicking the LeftNav "Post" pill, the mobile `ComposeFab`, a `PostCardActions` **Reply**/**Quote**, or the LeftNav "Poll" entry | centered dialog card over a `--cg-overlay` scrim (desktop/tablet); **full-screen sheet** (mobile <688px) | `history.pushState` syncs to `/compose/` (+ `?reply=<id>` / `?quote=<id>` / `?poll=1`), the underlying surface stays mounted behind the scrim (`01-information-architecture.md` §7.1) |
| **`/compose` full page** (`ComposePage`) | deep-link / hard refresh while the overlay was open / no-JS share of `/compose/` | a focused page: header **"Cancel" (left) + "Post" CTA (right)**, no blurred sticky header (`01-information-architecture.md` §5.5) | the real route `/compose/` (`trailingSlash:true`); `?reply`/`?quote`/`?poll` read **client-side** via `useSearchParams()` |

**One source of truth.** Both presentations mount the same `Composer` with the same props; only the chrome
differs. `<ModalRouteHost>` (owned by `AppShell`, `01-information-architecture.md` §7.2) decides which:

- If a `modalStore` entry is set (`{ kind:'compose'|'reply'|'quote'|'poll', targetId? }`), it renders
  `ComposerModal` chrome and pushes the URL.
- If `/compose/` is loaded **cold** (no underlying surface in `window.history`), `ComposePage` reads
  `useSearchParams()` (`reply`/`quote`/`poll`), pre-loads the target post for context via `ONE_POST`
  (`04-data-layer.md` §6), renders the full-page chrome, and on submit/cancel does `router.push('/')` (or
  `history.back()` if in-app history exists).

**Mode resolution** (drives the extrinsic, `03-component-library.md` §7 `mode` prop):

```
?reply=<id>            → mode='reply'   (load ONE_POST(id) for "Replying to @handle")
?quote=<id>            → mode='quote'   (load ONE_POST(id) for QuotedPostEmbed)
?poll=1                → mode='poll'    (PollComposer fields)
(none)                 → mode='post'    (top-level)
```

> A request may carry only one of `reply`/`quote`/`poll`. If more than one is present, precedence is
> `reply > quote > poll` and the others are ignored (defensive; never crash a deep link).

---

## 2. Desktop wireframes

### 2.1 `ComposerModal` overlay — top-level post (`mode='post'`)

```
                 ╔══════════════════════════════════════════════════════════╗
   dim scrim     ║  ✕                                                        ║  ← close (Esc / dim-click; confirm if dirty)
  (--cg-overlay) ║                                                          ║
                 ║  (•)  What's happening?                                   ║  ← Avatar(md) + autogrow textarea (placeholder --cg-text-muted)
                 ║  40px |                                                   ║     fs-md (17px), caret --cg-accent
                 ║       |                                                   ║
                 ║                                                          ║
                 ║  ┌──────────────────────────────────────────────────┐   ║
                 ║  │  RateLimitNotice  (ONLY if capacity exhausted)    │   ║  ← slim inline banner, --cg-text-secondary, role="status"
                 ║  └──────────────────────────────────────────────────┘   ║
                 ║  ──────────────────────── hairline --cg-border ───────── ║
                 ║   [▦ Poll]                              ( ◔ 383 )  [ Post ] ║  ← toolbar: Poll toggle | ByteCounter ring | pill CTA
                 ║   tint --cg-accent on hover            remaining   --cg-accent
                 ╚══════════════════════════════════════════════════════════╝
```

Notes:
- The toolbar holds **exactly one** affordance besides the counter+CTA: the **Poll** toggle. There is
  **no** media/GIF/image button, **no** emoji-as-media picker, **no** location, **no** schedule, **no**
  audience/"Everyone" selector (D1 + scope: none exist on-chain — drop them, do not render a disabled stub).
- The **Post** pill is `--cg-radius-pill`, filled `--cg-accent` with `--cg-accent-contrast` label; disabled
  state is reduced-opacity (see §6 state table for the exact disabled rules).

### 2.2 `ComposerModal` — reply (`mode='reply'`, `ReplyComposer`)

```
╔══════════════════════════════════════════════════════════╗
║  ✕                                                        ║
║                                                          ║
║  ┌───────────────────── thread connector ─────────────┐  ║
║  │ (•) DisplayName  @5CBE…oFC · 2h                     │  ║  ← compact preview of the post being replied to (read-only)
║  │     Parent body, clamped to ~3 lines …             │  ║     (NOT a full PostCard; no action row)
║  └────────────────────────────────────────────────────┘  ║
║  ↳ Replying to @5CBE…oFC                                  ║  ← --cg-text-secondary; @handle links /u/[address]
║  (•)  Post your reply                                     ║  ← Avatar(md) + textarea (placeholder "Post your reply")
║       |                                                   ║
║  ─────────────────────────────────────────────────────── ║
║                                       ( ◔ 480 )  [ Reply ] ║  ← CTA label "Reply"
╚══════════════════════════════════════════════════════════╝
```

### 2.3 `ComposerModal` — quote (`mode='quote'`, `QuoteComposer`)

```
╔══════════════════════════════════════════════════════════╗
║  ✕                                                        ║
║  (•)  Add a comment                                       ║  ← placeholder "Add a comment"
║       |                                                   ║
║   ┌──────────────────────────────────────────────────┐   ║
║   │  QuotedPostEmbed (read-only, NO action row,        │   ║  ← 03 §5; onOpen disabled inside composer
║   │  onOpen no-op)                                     │   ║
║   │  (•) DisplayName @ha…le · 1d                       │   ║
║   │  Quoted body, clamped ~3 lines …                  │   ║
║   └──────────────────────────────────────────────────┘   ║
║  ─────────────────────────────────────────────────────── ║
║                                       ( ◔ 500 )  [ Post ] ║  ← CTA label "Post"
╚══════════════════════════════════════════════════════════╝
```

### 2.4 `ComposerModal` — poll (`mode='poll'`, `PollComposer`)

```
╔══════════════════════════════════════════════════════════╗
║  ✕                                                        ║
║  (•)  Ask a question…                                     ║  ← the poll QUESTION reuses the 512-byte textarea
║       |                                                   ║
║   ┌──── <fieldset> Poll choices ────────────────────────┐ ║
║   │  Choice 1  [____________________________]  ( ◔ 74 ) │ ║  ← each option input has its OWN ByteCounter('sm', 80)
║   │  Choice 2  [____________________________]  ( ◔ 80 ) │ ║     (mandatory; not removable)
║   │  Choice 3  [____________________________]  ( ◔ 80 )✕│ ║  ← options 3 & 4 removable
║   │              [ + Add option ]   (max 4)              │ ║  ← disabled at 4 options
║   └─────────────────────────────────────────────────────┘ ║
║   (no "Poll length" / no expiry picker — polls stay Open)  ║  ← D4: NO duration control
║  ─────────────────────────────────────────────────────── ║
║   [▦ Poll • on]                       ( ◔ 460 )  [ Post ] ║  ← Poll toggle shows active; CTA "Post"
╚══════════════════════════════════════════════════════════╝
```

> **No duration picker (D4).** On-chain polls never expire (`05-divergences-and-constraints.md` D4). X shows
> a "Poll length" stepper; we render **nothing** there. The resulting `PollCard` shows a static "Open" chip,
> never a countdown (`03-component-library.md` §6).

---

## 3. Mobile wireframes (<688px — full-screen sheet)

On mobile the composer is a **full-screen sheet**, not a centered card (`01-information-architecture.md`
§7.2). The header becomes a bar with **Cancel** + the **Post** CTA; the textarea fills the sheet.

### 3.1 Mobile — post

```
┌─────────────────────────────────────────┐
│  Cancel                        [ Post ]  │  ← top bar: Cancel (left) + pill CTA (right, disabled until valid)
├─────────────────────────────────────────┤
│  (•)  What's happening?                  │  ← Avatar(md) + textarea, autofocus, keyboard up
│       |                                  │
│                                          │
│                                          │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ RateLimitNotice (only if exhausted) │  │
│  └────────────────────────────────────┘  │
├─────────────────────────────────────────┤
│  [▦ Poll]                       ( ◔ 383 )│  ← bottom toolbar above the keyboard: Poll toggle + ByteCounter
└─────────────────────────────────────────┘
```

### 3.2 Mobile — reply / quote / poll

Same full-screen sheet; the context block (reply preview / `QuotedPostEmbed` / poll option inputs) sits
under the textarea exactly as desktop, scrolling within the sheet. The bottom toolbar keeps the
`ByteCounter`; the Poll toggle is hidden in reply/quote modes (a reply/quote cannot also be a poll).

Mobile reply context line and the `ComposeFab` entry point are governed by `01-information-architecture.md`
§5.4 (`ComposeFab` opens `mode='post'`; the `PostCardActions` Reply/Quote open the reply/quote sheet).

---

## 4. Composer body — anatomy & behavior

All visual structure is defined in `03-component-library.md` §7–§11; this section pins the **compose-surface
behavior**.

### 4.1 Avatar + textarea

- **Avatar**: `Avatar` (`03-component-library.md` §13), `size='md'` (40px), `address = viewer.address`,
  `src = viewer.avatar`. Identicon fallback from the ss58 address. Not interactive in the composer.
- **Textarea**: auto-grows from 1 row to a max (then scrolls). `fs-md` (17px, `--cg-fs-md`) for the focused
  composing experience; caret `--cg-accent`. Placeholder in `--cg-text-muted`, per `mode`:
  - `post` → "What's happening?"
  - `reply` → "Post your reply"
  - `quote` → "Add a comment"
  - `poll` → "Ask a question…"
- **Enter inserts a newline; ⌘/Ctrl+Enter submits** (X parity, §7). No rich text, no markdown — `PostBody`
  later auto-links URLs only (`03-component-library.md` §4).
- **A text emoji picker is permitted** but is **not** a media affordance: any inserted emoji is plain UTF-8
  and **counts toward the 512-byte budget** through the `ByteCounter` (`new TextEncoder().encode()` measures
  the multibyte emoji as-is). Do **not** ship an image/GIF/sticker picker. The composer **toolbar's only real
  button is Poll** (§4.4); a text emoji picker, if shipped, is a text-insert helper into the textarea — not a
  media toolbar button — and never bypasses the byte budget. Kept consistent with the §12 out-of-scope table.

### 4.2 ByteCounter ring (UTF-8 BYTES — D1)

The `ByteCounter` (`03-component-library.md` §8) is the X circular countdown ring, **counting UTF-8 bytes,
not characters**, against `maxBytes`:

| Context | `maxBytes` |
|---|---|
| post / reply / quote text | **512** (`MaxLength`) |
| poll question | **512** |
| each poll option | **80** (`MaxPollOptionLen`) — its own `ByteCounter('sm', 80)` |

- Measures with `new TextEncoder().encode(value).length` (NEVER `value.length`).
- Far from the limit: ring fills `--cg-accent`, no number. Near (≤ `warnAt`, default 32 bytes remaining):
  amber + the **remaining** number. At/over the limit: full `--cg-danger` ring + a negative number.
- **Over-limit hard block**: typing past 512 bytes is prevented and a paste is **truncated at the byte
  boundary — never splitting a multibyte UTF-8 character** (clamp to the last whole code point that fits).
  The **Post** CTA is disabled while over the limit.
- `ByteCounter` exposes `onMeasure({ over, remaining })`; the `Composer` gates the CTA off **the same
  measurement** the ring shows (single source of truth — no drift between ring and button).

### 4.3 The Post CTA pill

- Pill (`--cg-radius-pill`), filled `--cg-accent`, label `--cg-accent-contrast`. Hover `--cg-accent-hover`.
- Label by mode: `post`/`quote`/`poll` → **"Post"**; `reply` → **"Reply"**.
- **Disabled** (reduced opacity + `aria-disabled`, with a tooltip explaining why) when ANY of:
  1. text is empty after trim (post/reply); **quote** requires ≥1 non-whitespace byte (a zero-comment quote
     is indistinguishable from a Repost — nudge to Repost, `03-component-library.md` §10); **poll** requires
     a non-empty question;
  2. over the 512-byte limit (or any poll option over 80 bytes);
  3. poll mode with fewer than **2** non-empty options (after trimming empties);
  4. `submitState === 'pending'`;
  5. capacity says unpostable — `draftStatus !== 'ok'` (§5);
  6. `viewer.status !== 'ready'` — then the CTA is **relabeled** and re-routed, not merely greyed (§5.3).

### 4.4 Poll toggle & option editor

- The toolbar **[▦ Poll]** toggle switches `mode` between `post` ↔ `poll` (only available from a top-level
  post; hidden in reply/quote). Toggling **on** reveals the `PollComposer` `<fieldset>` (2 mandatory inputs);
  toggling **off** discards option inputs (confirm if any option has content — reuse the dirty-discard prompt,
  §7.3).
- Option editor rules (`03-component-library.md` §11): `2 ≤ options ≤ 4`; the first two are not removable
  (no `✕`); options 3 and 4 have a remove `✕`; **+ Add option** is disabled at 4. Each option has its own
  `ByteCounter('sm', 80)`. Empty trailing options are **dropped client-side** before submit; the result must
  still have ≥ 2 non-empty options or the CTA stays disabled.

---

## 5. Capacity gate & session gating (the two hard pre-conditions)

Before the **Post** CTA enables, two orthogonal gates must pass: the viewer must be **identity-bound**
(`04-data-layer.md` §5) and the draft must be **within capacity** (`04-data-layer.md` §4). Both surface
*inside the composer*.

### 5.1 Capacity-as-rate-limit (no battery — D5)

The composer computes a `DraftStatus` from `useCapacity(api, viewer.address, bestBlock)` +
`draftStatus(view, byteLen, K)` (`04-data-layer.md` §4.1), where `byteLen = TextEncoder().encode(text).length`
and `K` is the action's capacity cost. **There is NO `CapacityBattery`** anywhere in this surface
(`00-overview.md`; `04-data-layer.md` §4). The only capacity surface is a single `RateLimitNotice`
(`03-component-library.md`, variant `'inline'`) slim banner above the toolbar:

| `DraftStatus` | Post CTA | `RateLimitNotice` copy (one line, Twitter-style) |
|---|---|---|
| `ok` | **enabled** | *(no notice)* |
| `no_weight` (posting weight 0) | disabled | "Lock ADA to start posting." → links to `/settings` vault |
| `too_long` (draft needs > capacity ceiling) | disabled | "This is too long to post at your current capacity. Shorten it." |
| `charging` (regenerating from 0) | disabled | "You are over the rate limit. Try again shortly." |
| `wait` (under budget, postable in N blocks) | disabled | "You are over the rate limit. Try again shortly." |

- **Never render N blocks, a percentage, or a meter.** The `blocks` value MAY be used internally to
  **auto-re-enable** the CTA when capacity regenerates (poll `useCapacity` each block; flip to `ok`) — but is
  never shown (D5).
- The notice is `role="status"`; the `no_weight` link is a real `<a href="/settings/">`.

### 5.2 The reactive race (pool rejection)

The capacity gate is advisory; the runtime `CheckCapacity::validate()` is authoritative. If the user submits
in the narrow window where the client thought `ok` but the pool rejects with `ExhaustsResources`, the
`TxUpdate` stream emits `phase:'error'` and `stringifyError` maps `/ExhaustsResources/i` → **"You are over the
rate limit. Try again shortly."** (`04-data-layer.md` §4.2). For a **modal that already closed optimistically**,
this surfaces as a **rate-limit `Toast`** (`Toast` kind `'rate-limit'`) AND the optimistic pending card is
rolled back AND the composer is **re-opened with the draft restored** (§7.4). For the **`/compose` full page**
(which may still be visible during pending), it surfaces inline as the `RateLimitNotice`.

### 5.3 Session / identity gating (D7)

The composer is gated by `viewer.status` (`03-component-library.md` §0.2) / `SessionState`
(`04-data-layer.md` §5.1). The CTA is **relabeled and re-routed**, never silently dead:

| `viewer.status` / SessionState | Textarea | Post CTA | On click |
|---|---|---|---|
| `not-connected` / `disconnected` | read-only, dimmed | label **"Connect wallet"** | open `ConnectWalletButton` flow / route `/welcome`; the draft is **not** auto-replayed after connect (v1 — leave a follow-up hook to remember intent) |
| `not-identity-bound` / `connected_unbound` | read-only | label **"Finish setup"** | route `/welcome` (the CIP-8 bind step); inline prompt "Finish setting up your account to post." with a Bind button calling `useIdentity.bind(walletId)` |
| `binding` | read-only | spinner, disabled | — |
| `ready` / `bound` / `bound_no_stake` / `bound_staked` | editable | label per §4.3 | submit (§6) |

> **Voting power is NOT a compose gate.** `bound_no_stake` can post, reply, quote, and create polls exactly
> like `bound_staked`; stake only affects vote/poll **weight** (`04-data-layer.md` §5.2). The composer never
> blocks on missing stake.

### 5.4 Combined precedence

Evaluate gates in this order so the CTA shows the most actionable label:
**(1) session** (`not-connected`/`not-identity-bound` win — show "Connect wallet"/"Finish setup") →
**(2) validity** (empty / over-limit / <2 poll options — disabled, neutral tooltip) →
**(3) capacity** (`DraftStatus !== 'ok'` — disabled + `RateLimitNotice`) →
**(4) pending** (`submitState==='pending'` — spinner) →
otherwise **enabled**.

---

## 6. Extrinsics & submission (exact arg encoding)

Every mode maps to **exactly one extrinsic** via the `mutations` module (`04-data-layer.md` §3.1). The
composer calls `onSubmit(draft: ComposerDraft)` and the surface wires the corresponding `submit*`:

| `mode` | `ComposerDraft` fields | `mutations.ts` fn | Extrinsic | Arg encoding | Cost |
|---|---|---|---|---|---|
| `post` | `{ text }` | `submitPost(api, signer, text)` | `Microblog.post_message` | `{ text: Binary.fromText(text), parent: undefined }` (→ `None`) | **feeless** + capacity |
| `reply` | `{ text, parentId }` | `submitReply(api, signer, text, parentId)` | `Microblog.post_message` | `{ text: Binary.fromText(text), parent: parentId }` (→ `Some(u64)`) | feeless + capacity |
| `quote` | `{ text, quotedId }` | `submitQuote(api, signer, text, quotedId)` | `Microblog.quote_post` | `{ text: Binary.fromText(text), quoted_id: quotedId }` (`u64`) | feeless + capacity |
| `poll` | `{ text, pollOptions }` | `submitCreatePoll(api, signer, text, options)` | `Microblog.create_poll` | `{ question: Binary.fromText(text), options: options.map(Binary.fromText) }` (`Vec<Vec<u8>>`) | feeless + capacity |

Encoding rules (`04-data-layer.md` §3.1):
- **Strings → bytes**: `Binary.fromText(s)` (PAPI `Binary`); this is the UTF-8 byte encoding the chain stores
  as `Vec<u8>`. The byte length the composer validated (`ByteCounter`) is exactly the on-chain length.
- **`parent: Option<u64>`**: pass `undefined` for a top-level post (PAPI encodes the absent optional as
  `None`); pass the `bigint` parent id for a reply (`Some`).
- **`quoted_id` / `post_id`**: `bigint` (u64). Never `Number()` (`04-data-layer.md` §0 u64 discipline).
- **Poll options**: `options.map(Binary.fromText)`; the surface first **drops empty/whitespace-only options**
  and asserts `2 ≤ options.length ≤ 4` and each `≤ 80` bytes before calling `submitCreatePoll`.

All four are **feeless signed** writes submitted via `signSubmitAndWatch` and watched to phase by `watchTx`
(`04-data-layer.md` §3.2). `create_poll` and the three post variants all emit **`PostCreated`** carrying the
new `u64` id (a poll also emits `PollCreated`); `extractPostId` reads the id from `PostCreated`
(`04-data-layer.md` §3.2).

### 6.1 Optimistic submit lifecycle (`04-data-layer.md` §3.3)

```
USER hits Post / ⌘Enter
  1. VALIDATE (bytes, options, session, capacity) — if blocked, do nothing (CTA was disabled anyway).
  2. APPLY optimistic insert:
       post/quote/poll → insert a `pending` PostCard (clientId) at top of the relevant Timeline
       reply          → insert a `pending` PostCard at top of the thread's reply list (useThread.addOptimisticReply)
  3. CLOSE the composer immediately (modal dismiss + history.back(); full page → router.push('/'))
       — keep the draft in memory in case of rollback (§7.4).
  4. SUBMIT via mutations.ts; subscribe to the TxUpdate phase stream.
  5. phase 'inBestBlock' (ok): SWAP the pending clientId card for the real id from PostCreated
       (postId in TxUpdate). For a reply, bump the parent's reply count on reconcile. SILENT — no toast.
  6. phase 'finalized': no UI change (already shown at inBestBlock — Twitter-speed).
  7. phase 'invalid'|'error': REMOVE the pending card, ROLL BACK, and:
       - capacity (ExhaustsResources) → rate-limit Toast + RE-OPEN composer with the draft restored
       - any other dispatch/signer/network error → failure Toast + RE-OPEN composer with the draft restored
```

- **Feeless social actions are silent on success** — the composer does not toast "Posted!"; the pending card
  simply becomes real (`04-data-layer.md` §3.4). The only toasts from this surface are **failure** and
  **rate-limit**.
- **Draft preservation on failure (§7.4)** is mandatory: never lose the user's text on a rollback.

---

## 7. Keyboard, focus & dirty-discard

### 7.1 Shortcuts

| Key | Action | Scope |
|---|---|---|
| **n** | open a new top-level `ComposerModal` (`mode='post'`) | global (surface-owned, not while typing in another input) — see `03-component-library.md` §0.5 / `01-information-architecture.md` |
| **⌘/Ctrl + Enter** | submit the current composer (equiv. clicking Post) | inside the composer |
| **Enter** | newline (does **not** submit) | inside the textarea |
| **Esc** | close the composer — if **dirty**, raise the discard-confirm (§7.3); if clean, close immediately | inside the composer modal/page |

### 7.2 Focus management

- On open, **autofocus** the textarea (`autoFocus` true for modal/sheet), caret at end. Mobile: the sheet
  raises the keyboard.
- `ComposerModal` is `role="dialog" aria-modal="true"` with a **focus trap**; on close, focus returns to the
  element that opened it (the "Post" pill, the FAB, or the originating Reply/Quote button) — `03-component-library.md`
  §7 a11y.
- The full-page `/compose` is not a dialog (no trap); focus starts in the textarea, `Tab` reaches Cancel/Post.

### 7.3 Dirty-discard confirm

A composer is **dirty** when: the text is non-empty after trim, OR (poll mode) any option input has content,
OR (reply/quote) the comment is non-empty. On **Esc**, **dim-click**, **Cancel**, the browser **Back** while
the modal is the top history entry, or toggling **Poll off** with option content, show a small confirm:

```
┌───────────────────────────────────┐
│  Discard post?                    │
│  This can't be undone.            │
│        [ Cancel ]   [ Discard ]   │  ← Discard = --cg-danger; Cancel returns to the composer
└───────────────────────────────────┘
```

- "Discard" closes and clears the draft; "Cancel" keeps the composer open with the draft intact.
- A **clean** composer skips the confirm and closes immediately.

### 7.4 Draft preservation across rollback

When a submit fails (§6.1 step 7), the composer was already closed optimistically. The surface must **re-open
the same composer** (same `mode`, `replyTo`/`quoted`/`pollDraft` context) with `text`/`pollOptions`
**restored** from the in-memory draft, so the user can retry or edit. This is required for both the
rate-limit and the generic-error paths (`03-component-library.md` §7 "text is **restored**").

---

## 8. Data bindings

The composer is a **write surface** — it has **no feed read binding** of its own. Its only reads are
context-resolution for reply/quote and capacity:

| Read | When | Query / source | Caps gate |
|---|---|---|---|
| Reply parent (for "Replying to @handle" + preview) | `mode='reply'`, cold `/compose/?reply=<id>` | `ONE_POST` (`04-data-layer.md` §6) by `id`; in-app overlay reuses the `PostVM` already in the list (no extra fetch) | — (always available; PAPI-direct `getPost`) |
| Quoted post (for `QuotedPostEmbed`) | `mode='quote'`, cold `/compose/?quote=<id>` | `ONE_POST` by `id`; in-app overlay passes the `PostVM` from the card | — |
| Viewer avatar/name | always | `viewer.avatar` / `viewer.displayName` (from `AppShell` context; profile from indexer or identicon fallback) | `profiles` (else identicon + truncated ss58) |
| Capacity view | always (gate) | `useCapacity(api, viewer.address, bestBlock)` (`04-data-layer.md` §4.1) | — |
| Session state | always (gate) | `sessionState(useSigner, useIdentity)` (`04-data-layer.md` §5.1) | — |

- **`ONE_POST`** (exact name from `04-data-layer.md` §6) is the single-post resolver used to hydrate
  reply/quote context on a cold deep link. PAPI-direct uses `getPost(id)`; if the id is missing/pruned the
  composer still opens but renders the context block as the muted "This post is unavailable." stub
  (`03-component-library.md` §5) rather than failing.
- **Writes only** — the composer never holds a `FeedSource.watch()` subscription; the timeline behind it
  keeps streaming (`01-information-architecture.md` §7.1 — reads keep flowing behind the open modal).

---

## 9. Every UI state (exhaustive)

| State | Trigger | Rendering | Source |
|---|---|---|---|
| **idle / empty** | open, no text | placeholder, CTA disabled, `ByteCounter` ring empty (`--cg-text-muted` track) | `03-component-library.md` §7 |
| **typing (valid)** | text within limits, `DraftStatus='ok'`, `ready` | ring fills `--cg-accent`, CTA enabled | §4.2/§5 |
| **near limit** | ≤ 32 bytes remaining | ring amber + remaining number; CTA still enabled | §4.2 |
| **at/over limit** | > 512 bytes (or a poll option > 80) | ring full `--cg-danger` + negative number; input blocked at byte boundary; CTA disabled | §4.2 |
| **poll: too few options** | < 2 non-empty options | CTA disabled, hint "Add at least 2 options." | §4.4 |
| **poll: max options** | 4 options | "+ Add option" disabled | §4.4 |
| **pending (optimistic)** | submitted | **modal/sheet closes**, a `pending` `PostCard` (opacity 0.6, inline `Spinner`) appears atop the timeline/thread; `submitState='pending'` | §6.1; `03-component-library.md` §1 pending-optimistic |
| **success** | `inBestBlock` ok | pending card reconciles to a real card — **silent**, no toast | §6.1; `04-data-layer.md` §3.4 |
| **error** | `phase:'error'`/`invalid` (signer reject, network, dispatch) | pending card removed; **failure `Toast`**; composer re-opens with draft restored | §6.1/§7.4 |
| **rate-limited** | `DraftStatus≠'ok'` (proactive) or `ExhaustsResources` (reactive) | proactive: CTA disabled + inline `RateLimitNotice`; reactive: rate-limit `Toast` + rollback + re-open | §5.1/§5.2 |
| **not-connected** | `disconnected` | textarea read-only/dim, CTA "Connect wallet" → `/welcome` | §5.3 |
| **not-identity-bound** | `connected_unbound` | textarea read-only, CTA "Finish setup" → `/welcome`, inline bind prompt | §5.3 |
| **binding** | `binding` | CTA spinner, disabled | §5.3 |
| **dirty-discard prompt** | Esc/Cancel/back/poll-off while dirty | confirm dialog (§7.3) | §7.3 |
| **context unavailable** | `mode='reply'`/`'quote'` and `ONE_POST` 404 | muted "This post is unavailable." stub for the context block; composer still usable | §8; `03-component-library.md` §5 |

---

## 10. Responsive behavior

Breakpoints from `01-information-architecture.md` §5.1:

| Width | Presentation | Notes |
|---|---|---|
| **Desktop ≥1020px** | `ComposerModal` = centered dialog card over `--cg-overlay` scrim; opened from the LeftNav full-width "Post" pill or a card Reply/Quote | scrim dim-click closes (dirty-confirm); `/compose` full page available for deep links |
| **Tablet 688–1019px** | same centered `ComposerModal`; opened from the LeftNav **round accent icon** "Post" button (no label) | no `RightRail`; otherwise identical composer |
| **Mobile <688px** | **full-screen sheet** with the Cancel + Post top bar; opened from the `ComposeFab` (post) or a card Reply/Quote | textarea fills the sheet; toolbar (`ByteCounter` + Poll toggle) sits above the keyboard; autofocus raises the keyboard |

- The `ComposeFab` (mobile only) always opens `mode='post'`; reply/quote sheets are opened by
  `PostCardActions` (`01-information-architecture.md` §5.4).
- The `/compose` full page renders the same `Composer` at every width with its focused header (Cancel + Post),
  no blurred sticky header (`01-information-architecture.md` §5.5).

---

## 11. Accessibility

- **Dialog semantics**: `ComposerModal` is `role="dialog" aria-modal="true"`, labelled by a visually-hidden
  "Compose post" (or "Reply"/"Quote"/"Create poll" per mode), with a **focus trap** and `Esc`-to-close
  (dirty-confirm). On close, focus returns to the trigger (`03-component-library.md` §7).
- **Textarea**: a real `<textarea>` with an accessible label ("Post text" / "Your reply" / "Add a comment" /
  "Poll question"). `⌘/Ctrl+Enter` submit is documented in the label's description.
- **ByteCounter**: `role="progressbar"` with `aria-valuemin=0`, `aria-valuemax=512` (or 80), `aria-valuenow`
  in **bytes**, `aria-label="N of 512 bytes used"`; over-limit adds `aria-invalid`. The remaining count is
  announced via `aria-live="polite"` **only** when ≤ 20 bytes remain (avoid spam) — `03-component-library.md` §8.
- **Poll options**: the option set is a `<fieldset>` with a visually-hidden legend "Poll choices"; each input
  is labelled "Choice {n}"; remove buttons `aria-label="Remove choice {n}"`; "+ Add option" announces
  remaining capacity (`03-component-library.md` §11).
- **CTA disabled**: use `aria-disabled` + a tooltip stating the reason (empty / over limit / finish setup /
  rate limit) rather than removing the button — keeps it discoverable.
- **RateLimitNotice**: `role="status"` inline; the reactive rate-limit `Toast` rides the `aria-live="polite"`
  `Toaster` region (`03-component-library.md` §0.5).
- **Reply/quote context links**: the "Replying to @handle" handle and the `QuotedPostEmbed` are real anchors
  to `/u/[address]` / `/post/[id]` (the embed is read-only inside the composer — `onOpen` no-op).
- **Reduced motion**: the like-pop is N/A here; the optimistic pending fade-in collapses to opacity-only under
  `prefers-reduced-motion` (`02-design-system.md` motion guards).

---

## 12. Out-of-scope affordances (do NOT render)

Per the locked scope and D1, the X composer toolbar is **stripped to one button** (Poll). Explicitly omit
(not even as disabled stubs):

| X affordance | Why omitted |
|---|---|
| Image / video / GIF upload | No media field on-chain; posts are text-only ≤512 bytes (D1) |
| Emoji-as-media / sticker picker | A *text* emoji is fine (counts bytes); a media/sticker picker is not |
| Location | Not modeled on-chain |
| Audience selector ("Everyone" / circles) | No visibility model — all posts are public |
| Schedule / draft scheduling | No scheduling primitive |
| Poll **duration** picker | Polls never expire (D4) — render nothing there |
| "Add to thread" (+) multi-tweet self-thread | Out of scope (a reply chain is the manual equivalent) |
| Alt-text, tagging | Media-only features |

---

## 13. Notifications hook (DEFERRED — leave the seam)

Not built in v1. The compose surface is where the **reply** and **quote** edges that a future notifications
feed folds are *created*: a `reply` produces a `Post.parent` edge targeting the parent author, and a `quote`
produces a `Post.quote` edge targeting the quoted author. A future `useNotifications(who)`
(`04-data-layer.md` §5.4) would surface "X replied to your post" / "X quoted your post" from these exact
edges (`posts(filter:{ parentId:{ in: myPostIds }})` and `posts(filter:{ quoteId:{ in: myPostIds }})`).
**Do not build it now** — just keep this note so the compose flows stay notification-friendly (the reply/quote
extrinsics already carry the targeting ids).

---

## 14. Implementation checklist (ordered)

- [ ] **Route + presentation (§1):** ensure `/compose/` (`ComposePage`) renders the full-page `Composer` with
      the Cancel + Post header; wire `<ModalRouteHost>` (`AppShell`) to open `ComposerModal` for
      `modalStore.kind ∈ {compose,reply,quote,poll}` with `history.pushState` URL sync
      (`/compose/?reply=`/`?quote=`/`?poll=1`).
- [ ] **Mode resolution (§1):** map `useSearchParams()` (`reply`/`quote`/`poll`) → `mode`; precedence
      `reply > quote > poll`; cold-load context via `ONE_POST` (PAPI-direct `getPost` fallback).
- [ ] **Composer body (§4):** `Avatar(md)` + autogrow `<textarea>` (`--cg-fs-md`), per-mode placeholders,
      Enter=newline / ⌘Ctrl+Enter=submit; **no media/GIF/location/audience** toolbar buttons (§12).
- [ ] **ByteCounter wiring (§4.2):** UTF-8 byte count via `TextEncoder`; 512 for text/question, 80 per poll
      option; over-limit hard block (truncate paste at the code-point boundary); CTA gated off `onMeasure`.
- [ ] **Post CTA (§4.3):** pill (`--cg-radius-pill`, `--cg-accent`/`--cg-accent-contrast`); label per mode;
      disabled rules (empty/over-limit/<2 options/pending/capacity/session) per §5.4 precedence.
- [ ] **Poll editor (§4.4):** Poll toggle (top-level only); `<fieldset>` 2–4 options, first two mandatory,
      3/4 removable, "+ Add option" disabled at 4, per-option `ByteCounter('sm',80)`; drop empty options +
      assert ≥2 before submit.
- [ ] **Capacity gate (§5.1):** `useCapacity` + `draftStatus` → CTA disable + inline `RateLimitNotice` copy
      table; auto-re-enable on regeneration (no number rendered); **no `CapacityBattery`**.
- [ ] **Reactive rate-limit (§5.2):** `stringifyError` `ExhaustsResources` → "You are over the rate limit.
      Try again shortly."; modal path → rate-limit `Toast` + rollback + re-open with draft.
- [ ] **Session gating (§5.3):** relabel CTA "Connect wallet" / "Finish setup" by `viewer.status`; route
      `/welcome`; inline bind prompt calling `useIdentity.bind(walletId)` for `connected_unbound`.
- [ ] **Extrinsics (§6):** `onSubmit(draft)` → `submitPost`/`submitReply`/`submitQuote`/`submitCreatePoll`
      with exact arg encoding (`Binary.fromText`, `parent: Option<u64>`, `quoted_id`/`post_id` as `bigint`,
      `options.map(Binary.fromText)`).
- [ ] **Optimistic submit (§6.1):** insert `pending` card → close composer → watch phase → swap real id on
      `inBestBlock` (silent) → rollback + Toast + re-open on error; keep the draft in memory throughout.
- [ ] **Keyboard & focus (§7):** `n` opens new post; ⌘Ctrl+Enter submit; Esc close with dirty-confirm; focus
      trap + return-focus for the modal; autofocus textarea (sheet raises keyboard on mobile).
- [ ] **Dirty-discard (§7.3):** discard confirm on Esc/Cancel/back/poll-off-with-content; clean composer
      closes immediately.
- [ ] **Draft preservation (§7.4):** on any submit failure, re-open the same composer with `text`/`pollOptions`
      restored.
- [ ] **Responsive (§10):** centered `ComposerModal` (desktop/tablet) vs full-screen sheet (mobile); FAB opens
      `mode='post'`; reply/quote sheets from `PostCardActions`.
- [ ] **Accessibility (§11):** dialog/aria-modal/focus-trap; textarea label; `ByteCounter` progressbar +
      polite live region ≤20 bytes; poll `<fieldset>`; `aria-disabled` + tooltip on CTA; `RateLimitNotice`
      `role="status"`.
- [ ] **Notifications seam (§13):** confirm reply/quote carry the targeting ids (`parent`/`quoted_id`); leave
      the deferred note — do not build the surface.
```
