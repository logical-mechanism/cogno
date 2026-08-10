# Changelog

What's changed in cogno-chain, newest first — written for people, not compilers. Each entry leads
with what it *means*; the runtime `spec_version` it shipped in is noted at the end where it matters.

There is no tagged public release yet: this is a running preprod testnet, so the on-chain
`spec_version` is the real version number. It only moves when the runtime's logic or encoding
changes — most app work moves nothing.

Ask the chain what it is running rather than trusting a number written down here, which is stale the
moment the next upgrade is enacted:

```bash
curl -sH 'content-type: application/json' \
  -d '{"id":1,"jsonrpc":"2.0","method":"state_getRuntimeVersion"}' https://cogno.forum/rpc \
  | jq -c '.result | {specVersion, transactionVersion}'
```

At the time of writing (9 August 2026) that answers 225 / 8, which is what this repo builds too. They
will not always agree: a runtime is only live once a governed upgrade has enacted it, so the repo is
routinely a step or two ahead.

## One post can no longer take over the timeline — app only

A post is capped at 512 bytes, which sounds like it bounds how much screen it can occupy. It does not:
eight of those bytes are enough to write an image link, and the client rendered every one of them as a
full-width block. A single post could unroll to dozens of image blocks and thousands of pixels, pushing
everything else off the screen. Newlines alone did much the same without any images at all.

- **A long post collapses behind "Show more."** Over-long bodies are clamped, and images past the first
  are hidden behind a control that reveals them three at a time, so a flood stays something you keep
  choosing to load. The click-to-reveal cover that stops images fetching until you ask is unchanged —
  this is about *layout*, which that cover never bounded.
- **The governance and explore filters fit on a phone.** The filter axes collapse behind a disclosure
  instead of wrapping into a wall of controls; "Clear all" really clears both axes now, instead of
  putting one straight back; clearing a filter no longer throws your keyboard focus to the top of the
  page; and the filters keep working after a reload, or when you open a link that already carries them.
- **A shared "unvoted" governance link no longer hides polls from signed-out readers.** The lens is
  meant to fail open for a reader whose eligibility is unknown, and one branch of it did not — it
  dropped every poll that was not still open.
- **A profile website is labelled from the URL itself** rather than a regular expression that could
  mislabel it, with over-long path segments clamped.

## A verified badge for constitutional committee members

The role tags already covered stake pool operators and dReps. Constitutional committee membership now
gets the same treatment: prove the hot credential with a CIP-8 signature and the badge appears on your
profile.

Two honest caveats. It is **display-only** — a committee badge carries no weight and there is no
committee chamber in governance polls, unlike the SPO and dRep badges. And membership is taken only
from the ledger's record of the committee actually *sitting* at the observed epoch, which is stricter
than it sounds: the obvious-looking tables are not membership. A row lands in them for every governance
proposal that names a credential, enacted or not, and on preprod that is hundreds of thousands of rows
belonging to proposals that never passed. Reading them would hand a badge to all of them.

The consequence on preprod today is that the correct answer is an empty set: every sitting member
registered a *script* hot key, and a script cannot produce a CIP-8 signature, so none of them can claim
the badge. That is the implementation working, not failing.

*Node-side only: this changes what the observer reads, with no runtime change and no `spec_version` bump.*

## Two reads that got slower as the chain grew

Both were on the public, unmetered read API — the one anyone can call against any account over the
public RPC — and both did work proportional to an account's whole history rather than to the page you
asked for.

- **The Upvotes tab loads past its first page.** It used to collect an account's entire like history
  and re-sort it on *every* page request, and in the app it stopped after the first page regardless.
  It now walks an index that is already in the right order, reading exactly as many rows as the page
  needs, at any depth.
- **The Following timeline no longer loads your whole follow list first.** It used to materialize every
  account you follow before it looked at a single post; it now checks each post against the list as it
  goes. Nothing bounds how many people one account may follow, so that first step had no ceiling.

Neither changes the posts or their order — the runtime work is invisible from the outside. The extra
Upvotes pages come from the app fix shipping alongside it. *Runtime:* `spec_version` 223 → 225.

## Everyone gets looked at, however many people sign up

The chain reads Cardano once per block, and that read has to be bounded or a block misses its slot. The
old bound was a fixed set of credentials, which meant anyone outside it was simply not read — and being
not-read looked exactly like having no stake.

- **The scan now rotates.** Instead of a fixed set, each block reads the next window of accounts and
  carries on round the ring, so everyone is covered within one sweep. While the chain holds fewer
  accounts than the window — it does today, by a wide margin, and the window has since been widened
  eightfold — every account is still read every block, exactly as before. Past that, coverage takes
  longer rather than excluding anyone.
- **Being outside the window no longer wipes your weight.** Absence from a block's read is only treated
  as "this is gone" for accounts that block actually looked at. For everyone else the chain holds what
  it last knew.
- **You can see the coverage.** Settings → Diagnostics gained a **Credential scan** row reporting when
  the rotation last completed a full lap.
- **Releasing or losing a role badge takes effect immediately.** Both of those used to rely on the next
  read to notice, which the rotation could delay by a whole sweep — long enough for a badge the
  committee had just revoked to keep voting weight in a governance poll. Giving up a badge and having
  one revoked now both clear it in the same block.
- **The block that enacts a runtime upgrade carries no Cardano reading, and now every node enforces
  that.** The check needed nothing but the chain's own state, but it sat behind the Cardano fetch — so
  a node with no Cardano connection never reached it. This chain's public relay is exactly such a node.

*Runtime:* `spec_version` 219 → 223. Encoding unchanged throughout (`transaction_version` stays 8).

### If you run a node

The window size is read out of the runtime, so a node binary and a runtime must agree about the shape
of that record. When it gains a field, **upgrade the runtime first and the node binaries second** — a
new node reading an old runtime cannot decode it, abstains, and freezes weight for the whole chain
until the upgrade lands. This is the reverse of the ordering for a consensus-level change.

## Finalizing a poll no longer depends on how many people are on the chain

Closing a poll counted every observed account in one go, and it declared that cost up front. Past
roughly 8,600 observed accounts the declaration alone would have exceeded what a block can accept, and
`close_poll` is the only way a poll is ever finalized — so every poll on the chain would have become
impossible to close, permanently, with no superuser to force one through.

- **The tally is now paged.** It walks the poll's *voters* a page at a time from a stored cursor and
  takes as many blocks as it needs. The population is out of the calculation entirely.
- **A frozen result is no longer a truncated one.** The old count joined against a capped set of
  stakers; it now counts every voter, so the number frozen into a closed poll is the real one.
- **A weight that moves mid-count is now reported.** A tally that spans several blocks can straddle an
  observer update, and when it does the chain says so with a `PollTallySmeared` event instead of
  quietly reporting a blend.

*Runtime:* `spec_version` 219. Encoding unchanged (`transaction_version` stays 8); no migration.

## You can release your own stake key, and a ban cannot be dodged

Binding a stake key was permanent, which was never intended — it was permanent because nothing had been
written to undo it.

- **`unlink_stake` is yours to call.** Releasing the stake credential you bound is a self-service
  action, free when you actually hold one, and your voting power drops to zero in the same block. The
  credential becomes available to bind again, by you or by anyone.
- **Releasing it cannot be used to dodge a ban.** A committee revoke motion is public, so an account
  facing one could have unlinked first and left the motion with no credential to tombstone. The
  committee can now ban a stake credential by name, whether or not any account currently holds it.
- **Replaying the proof you just used cannot re-attach what you released.** A bind proof is valid
  forever by design, so releasing a credential would otherwise have let a bystander re-submit the
  original bytes and re-bind it to you. The nonce inside a proof is now spent when it lands.

  Two gaps in that are known and deliberate, both griefing at worst — a replay re-attaches *your* own
  credential to *your* own account, and releasing it again is still free. Only the most recent nonce is
  remembered, so an account that has bound and released more than once can still be hit by a replay of
  an older proof. And a bind made before this upgrade left no record to spend, so for those accounts the
  first release leaves the original proof replayable exactly once; re-binding closes it for good.
- **Bans and badge revocations can be batched.** One committee motion can now revoke many identities or
  many role badges, skipping entries that are already gone rather than failing the whole batch.

*Runtime:* `spec_version` 218. Encoding unchanged (`transaction_version` stays 8).

## Nobody loses standing to a stranger's arrival

Three limits in the chain had the same shape: a fixed number of things would be looked at, and *which*
things was decided by an internal ordering nobody chose and nobody could see. That is fine while the
numbers are small. It stops being fine the moment somebody works out that the ordering can be aimed.

- **Your voting power can no longer be taken away by other people signing up.** Each block the node
  reads Cardano for a bounded set of registered stake keys. A key outside that set looks exactly like a
  key whose stake went to zero, so it was treated as one — and which keys fell outside shifted every
  time somebody new registered. Registering is free and unlimited, and the ordering can be steered by
  generating keys until one lands where you want it, so a specific person's voting power could be
  removed on purpose, by a stranger, at no cost. The chain now always looks at everyone it has already
  credited, and spends what is left over on people it has not seen yet. Being counted once means staying
  counted. The same protection covers verified role badges and the chamber weight that rides on them.
  What is still true: someone who has never been credited and falls outside the set has to wait for
  room, so a flood can delay a newcomer even though it can no longer rob anyone.
- **Searching for someone by name now finds them.** People search looked at the first ten thousand
  profiles in that same invisible order and stopped, with no way to ask for the next ten thousand. If
  the account you wanted sat past the line, typing their exact display name returned "No people found",
  permanently. Both people search and the "Who to follow" panel now page properly. The one honest
  caveat, which the wording used to hide: the ranking is per page rather than across the whole chain,
  so "Refine your search to see others" has gone — it was advice that could not have worked.
- **Operators running many pools keep all of them.** A profile could show at most sixteen verified role
  badges, which sounds generous until you notice a single operator on the test network already runs
  seventeen pools, and operators on the main network run twenty to thirty. The surplus was dropped in
  silence — and those badges are not decoration: governance polls add up the stake behind each one, so
  a large operator was quietly voting with less weight than they hold, and closing a poll froze that
  under-count for good. The cap is now thirty-two, and when it does bite the node says so in its log
  instead of pretending the set was complete.

## Long conversations stop losing their newest replies

A post's replies were only ever readable through one call, and that call sorted them oldest-first and
returned the first 512. Past that the rest were unreachable, and the ones it dropped were the newest —
the end a conversation is read at. So a busy thread looked finished when it was not, and a reply you had
just posted could fail to come back at all.

- **A thread now returns its newest replies, plus a way to walk back through the rest.** Nothing is
  unreachable any more, however long the conversation gets.
- **"Show older replies" fetches from the chain.** It used to page only what one read had already
  returned, with a line at the foot admitting the remainder could not be reached. That line is gone
  because the remainder is now reachable.
- **The read got cheaper as well as complete.** Serving one page used to mean walking and sorting every
  reply a post had; it now costs one lookup per reply actually returned, at any depth.

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
