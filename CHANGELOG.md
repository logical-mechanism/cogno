# Changelog

What's changed in cogno-chain, newest first — written for people, not compilers. Each entry leads
with what it *means*; the runtime `spec_version` it shipped in is noted at the end where it matters.

The live chain runs **`spec_version` 203** (`transaction_version` 3). There is no tagged public
release yet: this is a running preprod testnet, so the on-chain `spec_version` is the real version
number. It only moves when the runtime's logic or encoding changes — most app work moves nothing.

## Recent — app only (no chain change)

- **Reputation on the timeline.** An author's community reputation now shows next to their name in
  the feed, not just on their profile.
- **Repost removed.** The bare "repost" button is gone. Quoting a post (with your own comment) and
  up-voting it already cover amplification, and a plain repost surfaced nowhere useful — so quote is
  now the single way to boost a post. *(The old repost call still exists in the runtime and will be
  retired the next time the chain's code changes.)*
- **Better threads and replies.** Long reply chains page behind a "Show more" control, the composer
  shows who you're replying to, and the view scrolls to your reply after you post it.
- **Follower/following lists** with tappable counts and a "who to follow" suggestion — all read
  straight from the node.
- **Device-local bookmarks and mute/hide.** Saved and muted lists live in your browser only — there
  is no bookmark or mute stored on-chain (a public chain can't keep those private).

## Community reputation — vote on accounts, not just posts

- You can now up- or down-vote an **account** to signal trust, the same way you vote on a post. It's
  an anti-impersonation / anti-Sybil signal, weighted by your Cardano stake, shown on profiles and in
  people lists. You can't vote on yourself, and the target must have a bound identity.
- *Runtime:* `spec_version` 201 → 202. Encoding unchanged (`transaction_version` stays 3).

## Governance fuel — admin fees that refill themselves

- Privileged actions (registering validator keys, committee motions) are paid from a small
  **non-transferable, self-refilling fuel budget** the committee grants to an account, instead of a
  fee token that could run dry and deadlock its own top-up. Fuel can never be transferred or spent on
  posting — it exists only to pay admin fees, and regenerates toward its allowance over time.
- Onboarding a new validator or committee seat is now **fund-first**: grant the account a fuel
  allowance before you seat it (an unfunded seat is rejected on-chain).
- *Runtime:* `spec_version` 202 → 203. Encoding unchanged (`transaction_version` stays 3).

## Toolchain — polkadot-sdk stable2606

- Upgraded the whole Rust workspace to polkadot-sdk `stable2606` and pinned the toolchain to rustc
  1.93.0.
- *Runtime:* `spec_version` 200 → 201. Encoding byte-identical.

## The all-Rust restart (fresh genesis)

The backend was consolidated to a single all-Rust stack and the chain relaunched at a fresh genesis:

- **No sudo, ever.** There is no admin superuser. Every privileged action goes through a 3-of-5
  committee that exists from the first block and can start as one seat and federate out by vote.
- **Cardano is observed in-protocol.** Talk-capacity weight is written only by a consensus-verified
  observer built into the node — no off-chain follower or relayer, and no way to set weight by hand.
- **Observe-only.** Nothing is written back to Cardano; the anchoring path and its relayer were
  removed. All reads (feed, thread, search, profile) are served by the node itself — no external
  indexer.

## Open-source readiness

- Relicensed to **Apache-2.0** with a `NOTICE` attributing every upstream — the Polkadot SDK template,
  the partner-chains consensus primitives, the `substrate-validator-set` fork, the Aiken stdlib
  compiled into the L1 script, and the fonts and icons the frontend redistributes. `NOTICE` also states
  plainly that the distributed node binary and runtime WASM are a combined work carrying GPL-3.0-only
  code (`pallet-skip-feeless-payment`), even though this project's own source is Apache-2.0.
- Added `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `POLICY.md` (content is permanent and
  nobody — including the operator — can remove it), issue/PR templates, `CODEOWNERS`, and Dependabot.

## Deliberately left for mainnet (not bugs)

Honestly-labeled testnet choices, flagged `MAINNET PREREQUISITE` in the source: `MinAuthorities = 1`,
GRANDPA equivocation reporting as a no-op (no slashing), an independent audit of the CIP-8 verifier,
production key custody, and db-sync over TLS.
