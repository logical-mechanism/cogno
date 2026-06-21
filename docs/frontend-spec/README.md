# cogno-chain Frontend Spec

This directory is the complete frontend design specification for re-skinning the cogno-chain app (`app/`) into a faithful **Twitter/X clone** — same dense single-column timeline, pill buttons, three-column desktop / bottom-tab mobile shell, heart/repost/reply/share action row, optimistic interactions — wearing the **cogno-chain** name and **cogno teal/verdigris** accent (replacing Twitter's blue), **dark-first**. Underneath, every social action is a real feeless app-chain extrinsic: posts are 512-byte UTF-8 text, "Like" is a stake-weighted on-chain upvote, "Repost" is permanent, polls never expire, posting is metered by a regenerating talk-capacity instead of fees, and login is a Cardano wallet's CIP-8 signature. The spec is the design contract a team builds the new UI against; it does not change the data layer, only re-skins the presentation and extends the existing `FeedSource` seam.

Four **locked decisions** (user, 2026-06-21) govern the whole spec: (1) **the trust/honesty layer is dropped entirely** — no honesty badges, no "signed ≠ finalized", no anchor/block-number marginalia, no operator/trusted-follower labels; the UI is **optimistic** (action appears instantly, reconciles on confirm, rolls back with a quiet toast), and the only chain realities surfaced are a graceful **rate-limit** notice when talk-capacity is exhausted and a quiet failure toast on tx error. (2) **Branding** is the cogno-chain wordmark + the cogno accent, but X's exact layout, component set, spacing rhythm, and interaction patterns. (3) **Dark-first** theme with a working light toggle, both fully tokenized under `--cg-*`. (4) **Chain-backed surfaces only** — home, explore/search, profile, thread/detail, compose (+replies/quotes/polls), follows, votes/reposts/quotes, onboarding/auth, settings. Out of scope: DMs, Lists, Trends/Topics, in-post media uploads, bookmarks, monetization. Notifications are **deferred** with a clean indexer-event hook left on every relevant surface.

## The 13 docs

| File | What it owns | Read it first if you're building… |
|---|---|---|
| [00-overview.md](00-overview.md) | Vision, the Reading-Room→Twitter pivot, the Twitter-feature → chain-capability mapping, in/out scope, the doc map, the four guiding principles, the canonical divergence list. | …anything — it's the orientation map. |
| [01-information-architecture.md](01-information-architecture.md) | The route map, the **static-export dynamic-route strategy** (`generateStaticParams` placeholder + nginx `try_files` SPA fallback), the App Router tree, AppShell/LeftNav/RightRail/BottomTabBar/ComposeFab, breakpoints, modal routes, sticky-header pattern, scroll restoration, auth-gating of nav. | …the shell, routing, navigation, or any deep-linkable route. |
| [02-design-system.md](02-design-system.md) | The **`--cg-*` token system** (color/type/space/radius/shadow/motion/z/focus), dark + light themes via `[data-theme]`, the cogno accent (AA-derived), the X type scale, iconography, the drop-in `tokens.css`. **Source of truth for every token.** | …any visual surface — bind to these tokens, never raw values. |
| [03-component-library.md](03-component-library.md) | The shared component kit: `PostCard`, `PostCardHeader/Actions`, `PostBody`, `QuotedPostEmbed`, `PollCard`, `Composer` family, `ByteCounter`, `FollowButton`, `Avatar`/`DisplayName`/`Handle`, `Toaster/Toast`, `RateLimitNotice`, `EmptyState`, `Spinner/Skeleton`, `ConnectWalletButton`, `SearchBar`, plus pinned props for the surface-owned composites. | …any component, or any surface that composes them. |
| [04-data-layer.md](04-data-layer.md) | The UI↔chain contract: the extended `FeedSource`/`FeedCaps` seam, the corrected GraphQL queries (**`deleted` removed**), the PAPI-direct fallback, the action→extrinsic `mutations` module, the optimistic-update/rollback engine, capacity-as-rate-limit, the session-state machine, the hooks inventory. | …data wiring, queries, mutations, hooks, or session/gating logic. |
| [05-divergences-and-constraints.md](05-divergences-and-constraints.md) | The **canonical constraints registry** (D1–D12): every place cogno diverges from Twitter, decided once with a one-line rationale — text/512-bytes, weighted Like+downvote+score, permanent reposts, no-expiry polls, capacity rate-limit, ss58 handles, wallet auth, static export, fee-bearing profiles, banned-not-deleted, optimistic UI, counts vocabulary. | …deciding any chain-vs-Twitter behavior — this is the binding answer. |
| [06-surface-home.md](06-surface-home.md) | Home `/` — `Timeline` + `TimelineTabs` (For you / Following), the inline composer + collapse-on-scroll, the new-posts pill, feed keyboard nav, the home data wiring + cap gating. | …the home timeline. |
| [07-surface-profile.md](07-surface-profile.md) | Profile `/u/[address]` — `ProfileHeader` (address-seeded banner, xl avatar, counts), `ProfileTabs` (Posts/Replies/Likes, no Media), pinned post, banned treatment, `EditProfileModal` trigger, who-is-this fallback, address resolution. | …the profile surface. |
| [08-surface-thread.md](08-surface-thread.md) | Thread/detail `/post/[id]` — `ThreadView` (ancestor walk + focal detail + replies), the weighted score/stats row, inline `ReplyComposer`, poll/quote on focal, scroll-to-focal, deep-link load. | …the conversation/post-detail surface. |
| [09-surface-compose.md](09-surface-compose.md) | Compose `/compose` + `ComposerModal` — the four modes (post/reply/quote/poll), modal-vs-page presentation, ByteCounter, the capacity + session gates, exact extrinsic encoding, optimistic submit, dirty-discard, draft preservation. | …the compose/write engine. |
| [10-surface-explore-search.md](10-surface-explore-search.md) | Explore `/explore` — `SearchBar` + firehose (`Latest`/order toggle), query mode (People / Latest result tabs), who-to-follow rail, the `caps.search` indexer gate + PAPI-direct degraded state. | …explore, search, or discovery. |
| [11-surface-onboarding-auth.md](11-surface-onboarding-auth.md) | Onboarding `/welcome` + `ConnectWalletButton` — the connect → derive sr25519 → CIP-8 `link_identity_signed` bind stepper, the optional vault-lock + stake-bind power-ups, the write-intent gate target, the dev-account note. | …auth, onboarding, or the write-gate funnel. |
| [12-surface-settings.md](12-surface-settings.md) | Settings `/settings` — the seven sections (Account, Profile, Vault & posting power, Appearance, Network, Advanced, About), endpoint config (silent, not honesty-framed), theme, vault lock/exit, stake bind, the fee-bearing profile-edit funding state. | …settings, endpoints, vault, theme, or dev controls. |
| [README.md](README.md) | This index: orientation, the doc table, reading order, implementation handoff, and the divergences callout. | …getting oriented. |

## Reading order

Read the **foundation** docs first — every surface assumes them:

1. **[00-overview.md](00-overview.md)** — the mandate, scope, and feature mapping.
2. **[05-divergences-and-constraints.md](05-divergences-and-constraints.md)** — the D1–D12 constraints registry every surface honors.
3. **[01-information-architecture.md](01-information-architecture.md)** — routes, the shell, and the static-export routing strategy.
4. **[02-design-system.md](02-design-system.md)** — the `--cg-*` tokens (settle these before any pixels).
5. **[04-data-layer.md](04-data-layer.md)** — the `FeedSource` seam, queries, mutations, hooks, session states.
6. **[03-component-library.md](03-component-library.md)** — the shared kit, which binds to 02 + 04.

Then the **surfaces** (06–12), each of which composes the foundation and can be built in any order:

7. [06-surface-home.md](06-surface-home.md) · [07-surface-profile.md](07-surface-profile.md) · [08-surface-thread.md](08-surface-thread.md) · [09-surface-compose.md](09-surface-compose.md) · [10-surface-explore-search.md](10-surface-explore-search.md) · [11-surface-onboarding-auth.md](11-surface-onboarding-auth.md) · [12-surface-settings.md](12-surface-settings.md)

## Implementation handoff

The split is deliberate: once the **foundation docs (00, 05, 01, 02, 04, 03) are settled**, each surface doc (06–12) is self-contained enough to be implemented in **its own context window**. A surface doc names the routes (01), tokens (02), components (03), queries/mutations/hooks/gates (04), and divergences (05) it depends on by filename and section, and adds only its own composition, wireframes, states, responsive behavior, accessibility, and an ordered implementation checklist. So a team can parallelize: one engineer per surface, all binding to the same frozen foundation, with no surface redefining a token, component, query, or constraint that a foundation doc owns. The rule each surface restates: **use the canonical `--cg-*` tokens and canonical component/route names verbatim; never import a concrete reader or build a raw extrinsic at a call site; honor every D1–D12 divergence.**

---

> ### ⚠ Known divergences from Twitter
>
> cogno-chain is a clone of X's *look and feel*, not its *semantics*. Before building any surface, read **[05-divergences-and-constraints.md](05-divergences-and-constraints.md)** — it is the single binding registry for every place the chain forces a behavior change, decided once:
>
> - **D1** Posts are **text-only, 512 BYTES UTF-8** (not 280 chars); no media; `ByteCounter` counts bytes; avatar is a URL field. A text emoji picker is allowed (it counts toward the byte budget); media/sticker/GIF pickers are not.
> - **D2** **"Like" = a stake-weighted UP vote** (the heart); the **down-vote** is secondary (overflow); the weighted **score** shows only on post-detail.
> - **D3** **Reposts are permanent** — no un-repost; a one-time confirm; the filled state is terminal.
> - **D4** **Polls never expire** — "Open" chip, no countdown; 2–4 options ≤ 80 bytes; results are **% by weight**.
> - **D5** **Feeless but capacity rate-limited** — no battery/meter ever; exhaustion surfaces as a Twitter-style `RateLimitNotice`.
> - **D6** **No unique @handles** — handle = truncated **ss58** (mono); display names non-unique; identicon avatar fallback.
> - **D7** **Login = Cardano wallet + derived key + CIP-8 bind**; the "verified" concept is dropped.
> - **D8** **Static export / no server** — search & pagination need an indexer; deep links via nginx SPA fallback (`try_files $uri $uri/ /404.html`).
> - **D9** **Profile edits + pins are fee-bearing** (the only ones) — needs a funded account, a distinct "fund your account" state (not a rate limit).
> - **D10** **Moderation = revoke → banned** — banned authors are **dimmed, never removed**; nothing is ever deleted (the `Post.deleted` field is gone — purge every reference).
> - **D11** **Optimistic UI** — instant render, silent reconcile, rollback + toast; no block-number marginalia.
> - **D12** **Counts vocabulary** — `upCount` by the heart, `repostCount`, reply count, `downCount` in overflow/detail, `score`+weights only on detail; all weight fields are **BigInt** (may be negative); no view counts.
