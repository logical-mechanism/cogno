# Changelog

What's changed in cogno-chain, newest first — written for people, not compilers. Each entry leads
with what it *means*; the runtime `spec_version` it shipped in is noted at the end where it matters.

The live chain runs **`spec_version` 204** (`transaction_version` 3). There is no tagged public
release yet: this is a running preprod testnet, so the on-chain `spec_version` is the real version
number. It only moves when the runtime's logic or encoding changes — most app work moves nothing.

## Talk-capacity you have to earn, and an observer that says when it stops

The first in-place upgrade of the running chain — everything before this shipped at a fresh genesis.
It carries the project's first live storage migration, which **deletes data** (see below).

- **Locking ADA no longer hands you a full battery.** Talk-capacity is supposed to accrue: your
  Cardano weight fills a bucket over time, and posting spends it. But the bucket's clock was only ever
  restamped when you *spent*, never when your weight *changed* — so the first time weight arrived, the
  whole period you'd spent at zero weight got re-priced at your new weight and paid out at once. A
  fresh lock effectively arrived pre-charged, and unlocking and re-locking farmed the same credit
  again. Weight changes now settle the bucket at the **old** weight before the new one takes effect.
  You will notice this: a first lock now charges up from empty over a couple of minutes at today's
  regen rate, instead of letting you post immediately. That delay is the fix, not a regression — at a
  production-tuned regen window the old behaviour was a free-posting exploit.
- **Repost is gone from the chain, not just the app.** The button went a while ago; now the call, its
  two storage maps, its event and its error are removed from the runtime, and the migration drops the
  rows the chain still held. Quote remains the single way to amplify a post.
- **A stalled observer is now loud.** The Cardano observer is the only thing that can write stake
  weight, so if it silently stops, weight quietly freezes and nothing says so. The chain now records
  when an observation last landed and raises an on-chain **`ObservationStalled`** event (once per
  episode) if five minutes pass without one, then **`ObservationResumed`** when it recovers. Read
  `CardanoObserver.Stalled` to know whether the observer is healthy. The alarm arms only once the
  chain has accepted its first observation — a chain that never started is not a chain that stopped,
  which is what keeps `--dev` (no db-sync, so it never observes at all) from crying wolf every run.
- **The observation is honestly priced.** Its block weight was a hand-written placeholder that
  under-charged by orders of magnitude at the top of its range — a real risk of a block too slow to
  make its slot. It is now benchmarked. That measurement also showed the old participant ceiling
  (4096) would cost ~180% of a block's compute budget in the worst case, so the ceiling is now
  **1024** — still ~146x the live participant count, and a bound the chain can actually afford. The
  self-refilling governance-fuel budget got the same treatment (its per-block regeneration hook was
  also running on an estimate).

### If you run tooling against this chain

- **`StakeSet` / `VotingPowerSet` are no longer per-block heartbeats.** They used to fire every block
  even when nothing changed; the observer now writes only on an actual change, so on a quiet chain
  they go quiet. That is health, not silence. **`ObservationApplied` is the per-block liveness
  signal** — if you alert on `StakeSet` as a keepalive, move it.
- **Historical `Reposted` events no longer decode against current metadata.** Anything replaying
  history from before this upgrade must fetch metadata **at the historical block hash**, which is
  standard practice; a tool pinned to latest metadata will fail on those old events.
- **`EnrichedPost.repost_count` and `.reposted` are now permanently `0` / `false`.** The fields are
  kept on the wire — and the read API's version is unchanged — purely so the already-deployed
  frontend keeps decoding the feed. Do not read meaning into them.
- **The frontend must be redeployed with this upgrade.** It pins the `spec_version` it was built
  against and blocks posting on a mismatch, so a spec-203 bundle talking to a spec-204 chain is
  read-only until the new bundle ships.

- *Runtime:* `spec_version` 203 → 204. Encoding unchanged (`transaction_version` stays 3) — a removed
  call does not move it, and nothing else changed shape. Microblog storage version 4 → 5.

## Recent — app only (no chain change)

- **Reputation on the timeline.** An author's community reputation now shows next to their name in
  the feed, not just on their profile.
- **Repost removed.** The bare "repost" button is gone. Quoting a post (with your own comment) and
  up-voting it already cover amplification, and a plain repost surfaced nowhere useful — so quote is
  now the single way to boost a post. *(Retired from the runtime itself in `spec_version` 204, above.)*
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
  compiled into the L1 script, and the fonts, icons and emoji artwork the frontend redistributes.
  `NOTICE` also records the one place where a dependency's crate metadata disagrees with its own source
  headers: `pallet-skip-feeless-payment` publishes `license = "GPL-3.0-only"` (an upstream
  `license.workspace` packaging slip) while every one of its source files carries
  `SPDX-License-Identifier: Apache-2.0`. We read the headers as the operative grant. The `sc-*` client
  crates the node links are GPL-3.0-or-later WITH Classpath-exception-2.0, which permits exactly this
  linking; the strict-GPL `polkadot-*`/XCM tree is kept out of the shipped binary by gating
  `frame-benchmarking-cli` behind the `runtime-benchmarks` feature.
- Added `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `POLICY.md` (content is permanent and
  nobody — including the operator — can remove it), issue/PR templates, `CODEOWNERS`, and Dependabot.

## Deliberately left for mainnet (not bugs)

Honestly-labeled testnet choices, flagged `MAINNET PREREQUISITE` in the source: `MinAuthorities = 1`,
GRANDPA equivocation reporting as a no-op (no slashing), an independent audit of the CIP-8 verifier,
production key custody, and db-sync over TLS.
