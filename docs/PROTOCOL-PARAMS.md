# Protocol parameters

Every tunable the chain runs on, in one place, with the value and the file + symbol you'd edit to change
it. This is a snapshot of **spec_version 221**.

Two things to keep in mind:

- **For live truth, ask a node** (`state_getRuntimeVersion`, `state_getMetadata`). This file mirrors
  the source, but the running chain is the authority. If they ever disagree, the node wins and this
  file is stale.
- **Most of these are compile-time constants.** Changing one means recompiling the runtime and
  shipping it as an upgrade ([UPGRADES.md](UPGRADES.md)) — it is not a config file the node reads at
  boot. A few can't change at all after genesis (noted below).

Each row names the **symbol**, not a line number: grep the symbol in the file. (Line-pinned links rotted
on every commit, which is how this table was wrong before.)

## Before you change anything

- **Encoding-affecting changes bump `spec_version`.** New/changed calls, storage, events, or
  transaction extensions change the metadata → bump `spec_version` (`runtime/src/lib.rs` — `VERSION`)
  and regenerate the frontend's PAPI descriptors (`rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`).
- **Pure bound/value tweaks (a different `MaxLength`, a new cost, a `CARDANO_NET` flip) don't change
  the descriptors — but shipping one to the LIVE chain still bumps `spec_version`**, for two
  operational reasons, not an encoding one: `System::apply_authorized_upgrade` refuses a
  non-increasing spec, and the deployed frontend blocks posting against a chain whose spec differs
  from its build (so the bump rides a lockstep `DESCRIPTOR_SPEC_VERSION` redeploy, with no descriptor
  regen needed). A value tweak that ships inside a **fresh genesis** (the mainnet-cutover path)
  carries no bump of its own. Non-encoding, non-behavioral changes (logging, comments, tests) never
  bump anything on their own — they ride whatever release ships them.
- **Block time / slot duration cannot change after the chain has started** — doing so bricks block
  production. It's fixed for the life of this chain.
- **Some values are contracts with the outside world, not free knobs:**
  - `transaction_version` (8) — only bump when the extrinsic byte format changes.
  - `SS58Prefix` (42) — changes every printed address.
  - `VaultPolicyId` — the live L1 script hash; changing it means you redeployed the vault (see the
    contracts gotcha in [CLAUDE.md](../CLAUDE.md)).
  - Pallet indices — never renumber (on-wire contract).

## Consensus & timing

All in `runtime/src/configs/mod.rs` unless noted.

| Parameter | Value | Symbol / file |
|---|---|---|
| Consensus | Aura (authoring) + GRANDPA (finality) | `node/src/service.rs` |
| **Block time** | **6 s** | `MILLI_SECS_PER_BLOCK` — `runtime/src/lib.rs` |
| Slot duration | 6 s (`= MILLI_SECS_PER_BLOCK`; can't change post-genesis) | `SLOT_DURATION` — `runtime/src/lib.rs` |
| Aura `SlotDuration` | `MinimumPeriod × 2` = 6 s | `pallet_aura::Config` |
| `MinimumPeriod` (timestamp) | 3 s (`SLOT_DURATION / 2`) | `pallet_timestamp::Config` |
| `AllowMultipleBlocksPerSlot` | `false` (one block/slot) | `pallet_aura::Config` |
| Block proposal slot portion | 2/3 of the slot | `block_proposal_slot_portion` — `node/src/service.rs` |
| GRANDPA justification period | 512 blocks | `GRANDPA_JUSTIFICATION_PERIOD` — `node/src/service.rs` |
| GRANDPA gossip duration | 333 ms | `gossip_duration` — `node/src/service.rs` |
| **`SessionPeriod`** | **10 blocks (~1 min)** — dev-tuned short | `SessionPeriod` |
| `SessionOffset` | 0 | `SessionOffset` |
| Derived MINUTES / HOURS / DAYS | 10 / 600 / 14,400 blocks | `MINUTES` — `runtime/src/lib.rs` |

Aura has no epochs — `SessionPeriod` is the nearest analog. A queued validator add/remove applies at
the next-but-one session boundary (~2 sessions, ~2 min).

## Validators & authorities

| Parameter | Value | Symbol / file |
|---|---|---|
| `MinAuthorities` | **1** — testnet floor; mainnet prereq is ≥4 (3f+1) | `pallet_validator_set::Config` |
| `MaxValidators` | 32 (must be ≤ `MaxAuthorities`) | `pallet_validator_set::Config` |
| Aura / GRANDPA `MaxAuthorities` | 32 | `pallet_aura::Config` / `pallet_grandpa::Config` |
| GRANDPA `MaxNominators` / `MaxSetIdSessionEntries` | 0 / 0 (equivocation reporting is a deliberate no-op) | `pallet_grandpa::Config` |
| `SessionKeys` | `{ aura, grandpa }` | `impl_opaque_keys!` — `runtime/src/lib.rs` |
| Session `KeyDeposit` | 0 (must stay 0 while `purge_keys` is filtered) | `pallet_session::Config` |
| `FuelGate` / `KeysGate` (seating gates) | `add_validator` rejects an account with no governance-fuel allowance (`NotFunded`) or no registered session keys (`NoSessionKeys`) — this is what enforces `fuel set-allowance` → `set-keys` → seat. Allow-all under `runtime-benchmarks` | `HasFuelAllowance` / `HasSessionKeys` — `runtime/src/configs/mod.rs` |

## Runtime core & versions

| Parameter | Value | Symbol / file |
|---|---|---|
| spec_name / impl_name | `cogno-chain-runtime` | `VERSION` — `runtime/src/lib.rs` |
| **spec_version** | **221** | `VERSION` — `runtime/src/lib.rs` |
| transaction_version | 8 | `VERSION` — `runtime/src/lib.rs` |
| `DESCRIPTOR_SPEC_VERSION` (frontend lockstep) | 221 — must equal `spec_version`; `npm run lint` fails on drift, and a mismatch blocks posting | `DESCRIPTOR_SPEC_VERSION` — `app/src/lib/chain/client.ts` |
| authoring / impl / system_version | 1 / 1 / 1 | `VERSION` — `runtime/src/lib.rs` |
| SS58 prefix | 42 (generic Substrate) | `SS58Prefix` |
| `BlockHashCount` | 2400 blocks (~4 h) | `BlockHashCount` — `runtime/src/configs/mod.rs` |
| `MaxConsumers` | 16 | `frame_system::Config` |
| `DbWeight` | `RocksDbWeight` | `frame_system::Config` |

## Block limits & fees

| Parameter | Value | Symbol / file |
|---|---|---|
| Max block weight (ref_time) | 2 s of compute (`2e12`) | `RuntimeBlockWeights` |
| Max block weight (proof_size) | `u64::MAX` (PoV effectively unbounded) | `RuntimeBlockWeights` |
| `NORMAL_DISPATCH_RATIO` | 75% | `NORMAL_DISPATCH_RATIO` / `NORMAL_DISPATCH_PERCENT` |
| Max weight ONE Normal extrinsic may declare | ~1.3 s of compute — the class allowance (75% of the block) less the 10% of `max_block` that `with_sensible_defaults` withholds for block initialization, less `ExtrinsicBaseWeight`. Enforced by `CheckWeight::check_extrinsic_weight` at POOL VALIDATION, so an over-declared call is unincludable for ever rather than deferred to a quieter block. This is what caps `MaxScanned` — see [Cardano observer](#cardano-observer) | `RuntimeBlockWeights` (`max_extrinsic`, Normal) |
| Max block length | 5 MiB (Normal class scaled to 75%) | `RuntimeBlockLength` |
| WeightToFee / LengthToFee | `IdentityFee` (1:1) | `pallet_transaction_payment::Config` |
| FeeMultiplier | 1 (fixed) | `FeeMultiplier` |
| OperationalFeeMultiplier | 5 | `pallet_transaction_payment::Config` |

Posting is feeless and metered by talk-capacity, not fees (see [ECONOMICS.md](ECONOMICS.md)); the fee
machinery above only prices the admin surface capacity doesn't meter.

## Native token (governance FUEL)

The native balance is a non-transferable governance **FUEL** token, not a user currency. Symbol and
decimals are display-only chainspec properties.

| Parameter | Value | Symbol / file |
|---|---|---|
| Symbol / decimals | FUEL / 12 | `tokenSymbol` — `node/src/gen_chainspec.rs` |
| `UNIT` | 1e12 (Balance = `u128`) | `UNIT` — `runtime/src/lib.rs` |
| `ExistentialDeposit` | 1e9 (`MILLI_UNIT`) | `EXISTENTIAL_DEPOSIT` — `runtime/src/lib.rs` |
| `MaxLocks` (Balances) | 50 | `pallet_balances::Config` |

## Talk-capacity economics (microblog)

The posting rate limit: your locked-ADA weight buys a regenerating capacity budget, and each action
spends from it. Retuned in spec 212 from the old dev-tuned showcase values to a real ~5 h refill window
(see [ECONOMICS.md](ECONOMICS.md#the-token-bucket-mechanic) for the derivation). Units are
"micro-capacity"; one post ≈ `BaseCost`. All in `runtime/src/configs/mod.rs`.

| Parameter | Value | Symbol / file |
|---|---|---|
| `CapRatio` (ceiling per weight) | 3,000 micro-cap / lovelace | `CapRatio` |
| `RegenPerBlock` | 1 micro-cap / lovelace / block, below the knee | `RegenPerBlock` |
| Refill rate | `capacity_ceiling(weight) · RegenPerBlock / CapRatio` — DERIVED from the (already-clamped) ceiling since spec 212, so the rate flattens at the same knee as the bucket. It equals `weight · RegenPerBlock` exactly below the knee | `Pallet::regen_per_block` — `pallets/microblog/src/lib.rs` |
| Empty→full regen window | 3,000 blocks (5 h) = `CapRatio / RegenPerBlock`, weight-independent **at every weight** (that is what deriving the rate from the ceiling buys) | `CapRatio`, `RegenPerBlock` |
| `Ceiling` (hard max) | 3e14 (100,000 posts); the knee is 100,000 ADA locked, and it now caps BOTH the burst and the sustained rate | `Ceiling` |
| `BaseCost` (per post) | 3,000,000,000 (= 1 post) | `BaseCost` |
| `PerByteCost` | 3,000,000 / byte | `PerByteCost` |
| `VoteCost` | 1,200,000,000 — the flat signal cost for `vote`/`clear_vote`, `vote_account`/`clear_account_vote`, `cast_poll_vote` and `close_poll` | `pallet_microblog::Config` |
| `FollowCost` | 600,000,000 | `pallet_microblog::Config` |
| `ProfileCost` (foreign) | 30,000,000,000 (= 10× `BaseCost`) | `ProfileCost` |
| `CheckCapacity` tx longevity | 8 blocks | `longevity` — `pallets/microblog/src/lib.rs` |
| Max encoded length of a metered call | 8 KiB | `MAX_METERED_CALL_LEN` — `pallets/microblog/src/lib.rs` |

`MAX_METERED_CALL_LEN` is a backstop, not a knob to tune: the per-field bounds in each dispatch body
are the real limits. It exists because the capacity price is derived from one text field (or is flat,
for foreign calls) while several metered calls carry other unbounded `Vec<u8>` arguments — `create_poll`'s
`options` and `action.anchor_url`, and all six `set_profile` fields. Those are checked only in the
dispatch body, so without a whole-extrinsic ceiling the pool admitted, gossiped and included a
multi-megabyte call for the price of one empty post, then failed it after the bytes were already in the
block body. Raising it widens that gap; lowering it below ~1.5 KiB starts rejecting well-formed calls.

At the 100-ADA `MinLock` floor that is a 100-post burst and 480 posts/day sustained (a `BaseCost`-only
post). Worst-case permanent state growth is ~290 KB/day, which is a different calculation — see
[ECONOMICS.md](ECONOMICS.md#the-token-bucket-mechanic): the largest row comes from a 512-byte post,
which costs 1.5x `BaseCost`, so it sustains 317/day at ~936 B each. At the knee (100,000 ADA) it is a
100,000-post burst and ~480,000 posts/day, about 2% of one block.

First-touch capacity starts at **0** (anti-farm), regenerates up to the ceiling, and never decays.
There's no cooldown — capacity is the only rate limit. Note there is no second line of defence for the
social calls: they are feeless (no fee floor) and `RuntimeBlockWeights` sets proof size to `u64::MAX`
(no state-growth backstop), so these constants are load-bearing on their own.

## Content bounds

| Parameter | Value | Symbol / file |
|---|---|---|
| Max post / poll-question length | 512 bytes | `MaxLength` — `pallet_microblog::Config` |
| Posts per author | UNBOUNDED. `MaxPostsPerAuthor` (10,000) was removed in spec 212 with the bounded-vec index: at the cap an author was permanently bricked (post/quote/create_poll all reverted `TooManyPosts`, with no `delete_post` and no pruning). The seq-keyed double maps index a post in O(1) at any history length, so there is nothing left for a cap to bound. `Error::TooManyPosts` (index 2) is permanently vacant | `ByAuthor` / `ByAuthorCount` — `pallets/microblog/src/lib.rs` |
| `MaxPollOptions` | 4 (min 2 enforced) | `pallet_microblog::Config` |
| `MaxPollOptionLen` | 80 bytes | `pallet_microblog::Config` |
| `MaxAnchorUrlLen` (poll governance-action anchor) | 256 bytes; must be non-empty, and only a chamber poll may carry one | `pallet_microblog::Config` |
| Following / Followers | unbounded (no `MaxFollowing`) | `pallets/microblog/src/lib.rs` |
| Direct replies per post | UNBOUNDED, and readable in full since spec 216. `thread` returns the NEWEST `MAX_THREAD_REPLIES` (512) plus `Thread::replies_next_cursor`; `replies_page` serves every page below it off the ordered `RepliesByParentSeq` spine. Before that the 512 was a truncation of the OLDEST replies with no cursor at all | `MAX_THREAD_REPLIES` / `RepliesByParentSeq` — `pallets/microblog/src/lib.rs` |
| `MAX_PEOPLE_SCAN` (people reads) | 10,000 rows EXAMINED per call — a PER-PAGE budget since spec 217, not a truncation. `search_people` / `who_to_follow` walk a hash-ordered map and both FILTER inside the budget, so before the cursor a bound account whose address hashed past position 10,000 was permanently invisible (its exact display name returned "No people found") and the follower-count sort ranked a truncated pool. Both now take an `after` cursor and return `PeoplePage { people, next_cursor }`; ranking is per PAGE, so a caller wanting the best N overall chases and ranks the union. The value is deliberately unchanged: raising it buys a bigger unmetered read (`Profiles::iter()` full-decodes each ~1 KB profile before the bound-account gate rejects it), while reach is what the cursor buys | `MAX_PEOPLE_SCAN` — `runtime/src/apis.rs` |

Profile field bounds (`pallet-profile`; there is no separate "handle" — `display_name` is the only name),
all in `pallet_profile::Config`:

| Field | Bytes |
|---|---|
| `MaxName` (display name) | 64 |
| `MaxBio` | 256 |
| `MaxAvatar` (URL/CID ref) | 128 |
| `MaxBanner` (URL/CID ref) | 256 |
| `MaxLocation` | 64 |
| `MaxWebsite` (URL ref) | 256 |

## Polls & vote weighting

A poll stores vote COUNTS only — the weight is derived at read time from each voter's current Cardano
`VotingPower`, so a stake change re-prices open polls. A chamber poll adds a governance lens on top:
`PollKind::Governance` surfaces both the SPO and the dRep chamber, `PollKind::Spo` only the SPO one,
`PollKind::Drep` only the dRep one. Lenses are reported separately and never summed. A permissionless
`close_poll` freezes the result. Wired in `runtime/src/configs/mod.rs` (`impl pallet_microblog::Config`).

| Parameter | Value | Symbol / file |
|---|---|---|
| `MaxClosePage` | 64 — how many voters (or chamber scratch rows) ONE `close_poll` call processes before it saves its cursor and returns. Added in spec 219 when the tally was paged: this is the work-per-block bound that replaced the population bound, and it is the only thing `close_poll`'s weight is declared against. A poll with fewer voters than this closes in a single call, identically to the pre-219 atomic close. The per-item cost is WRITE-dominated (a chamber scratch row per role badge the voter holds), so the compile-time ceiling `MAX_CLOSE_PAGE_CEILING` is 301 — far below what a reads-only reading would suggest | `pallet_microblog::Config` |
| `MaxObservedAccounts` (accounts a tally joins over) | 1024 (= the observer's `MaxScanned`) — the cap the two READ-side adapters (`ObservedStakers::stakers`, `ChamberRolesProvider::role_holders`) apply when they walk the observer's basis. ⚠ Since spec 219 it no longer appears in any weight declaration and no longer gates whether a poll can be finalized: `close_poll` pages its tally and walks the poll's VOTERS, so the frozen result counts everyone who voted regardless of this cap. What it still bounds is read LATENCY — `staker_weights()` is rebuilt on every unmetered `state_call` — and the live `poll()` join, which is still truncated at the cap while a poll is open. So at and above 1024 the live read and the frozen result can disagree, and the FROZEN one is correct. Closing that gap is B′6 in `docs/OBSERVATION-READ-SHAPE-PLAN.md` | `pallet_microblog::Config` |
| Roles folded per voter in a chamber tally | 32 since spec 217, was 16 (the observed-badge cap — see [Cardano role tags](#cardano-role-tags)). This is a WEIGHT input, not a display bound: the tally sums each folded pool's delegated stake and counts distinct roles, so a truncated mSPO under-reports both, and `close_poll` freezes that permanently | `MAX_OBSERVED_ROLES_PER_ACCOUNT` — `pallets/cardano-roles/src/lib.rs` |
| Poll deadline (`close_at`) | REQUIRED since spec 211, and validated into `[now + MinPollDuration, now + MaxPollDuration]`. (A pre-211 `None` poll already in storage keeps floating and can never be frozen.) | `create_poll` — `pallets/microblog/src/lib.rs` |
| `MinPollDuration` | 100 blocks (10 min) | `pallet_microblog::Config` |
| `MaxPollDuration` | 1,296,000 blocks (90 days) | `pallet_microblog::Config` |

## Cardano observer

How the node reads Cardano to credit weight (see [IN-PROTOCOL-OBSERVATION.md](IN-PROTOCOL-OBSERVATION.md)).
These are consensus-critical — a change here can fork the chain. All in `runtime/src/configs/mod.rs`.

| Parameter | Value | Symbol / file |
|---|---|---|
| `MaxChangesPerBlock` | 256 per axis (vault / stake / role). A CHURN batch size, not a population bound — nothing caps how many identities may hold weight. A larger change set fills one page and the rest drains over the following blocks, so overrunning it costs latency, never correctness. Worst case is three full pages ≈ 10% of `max_block` | `pallet_cardano_observer::Config` |
| `MaxRolesPerAccount` | 32 — a per-IDENTITY bound on the observed badge set. EQUAL to `MAX_OBSERVED_ROLES_PER_ACCOUNT` since spec 217, where it used to be double it; a `const _: () = assert!(…)` in `configs/mod.rs` now enforces that the sink cap never exceeds it. Equality is safe only because BOTH layers reserve the non-SPO slots (`Pallet::bounded_roles` in the observer, `Pallet::bound_observed_roles` in cardano-roles) — without that, whichever bound bit first would truncate naively in SPO-first order and drop a multi-pool operator's dRep badge | `pallet_cardano_observer::Config` |
| `MaxScanned` | 1024 — the size of the observer's per-block credential scan WINDOW, and the bound on the arrays it feeds into the db-sync query. Those scans read the claims of the accounts in one window of cogno-gate's scan rotation (`scan_window`), and the rotation is grown by the bare-unsigned, feeless `link_stake_signed` / `claim_role_signed`, so an unbounded scan was a free way to grow every node's per-block work. ⚠⚠ Spec 220 stopped this bounding the POPULATION. It used to be a hash-ordered PREFIX of the ledger, so a credential past it was never scanned in any block and that identity silently held no voting power and no role badge — with `blake2_128`, which is grindable offline, deciding who. It is a rotating window now: per-block work is bounded exactly as before, and every account is covered within `ceil(accounts / MaxScanned)` blocks whatever the population is. Raising it buys sweep TIME at the cost of db-sync query time per block; it no longer decides who gets observed at all. The vault axis is discovered by policy id and has no scan. The node alarms on `scan_sweep_blocks` (coverage latency), NOT on the scan being full — under a window a full scan is what every healthy block looks like. Remaining limits: the db-sync query timeout (measured: no single query reaches its 2 s budget until N ≈ 130,000) and read-path latency via `MaxObservedAccounts` | `pallet_cardano_observer::Config` |
| `StallAfter` | 50 blocks (5 min) before `ObservationStalled` latches. A draining backlog is NOT a stall — each of those blocks applies a page and stamps the clock; `PendingChanges` is the signal for that | `pallet_cardano_observer::Config` |
| `MinLock` | 100 ADA (100,000,000 lovelace) | `ObsMinLock` |
| `MaxStakeWeight` | 45e15 lovelace (~total ADA supply; over-cap entry skipped) | `pallet_cardano_observer::Config` |
| `MaxVotingPower` | 45e15 lovelace (over-cap entry skipped) | `pallet_cardano_observer::Config` |
| `CARDANO_NET` | `Preprod` — THE one-line cutover selector; every row below derives from it (a partial flip cannot build) | `CARDANO_NET` / `CARDANO_PARAMS` |
| `StabilitySlots` | 600 slots (~10 min, a testnet-observability choice; the `Mainnet` arm carries 3k/f = 129,600). ⚠ RAISING this on a LIVE chain lowers every future reference at a stroke (the reference is `shelley_start_slot + elapsed − StabilitySlots`), so the next block's reference lands BELOW the one already applied. Before spec 213 that returned `ReferenceRegressed` from a `Mandatory` dispatch — `BadMandatory`, the whole block discarded — and since the reference derives from the PARENT's slot, the discarded block left the next reference unchanged and authoring wedged permanently. Since 213 the bound SKIPS instead: authoring continues, weight holds at its last value, and `ObservationStalled` latches until the reference climbs back past the last applied one (~1 s of wall clock per slot raised) | `CARDANO_PARAMS.stability_slots` |
| Shelley anchor | preprod: unix 1,655,769,600 / slot 86,400 (mainnet arm: 1,596,059,091 / 4,492,800) | `CARDANO_PARAMS.shelley_start_unix` / `.shelley_start_slot` |
| `StakeEpochLookback` | 1 epoch | `pallet_cardano_observer::Config` |
| `VaultPolicyId` | `168a9710…` (live L1 script hash, network-independent — do not change lightly) | `TALK_VAULT_POLICY_ID` |
| `EnforceWeight` default | `true` (observer is sole weight writer from genesis) | `pallets/cardano-observer/src/lib.rs` |
| `CardanoNetwork` | 0 (testnet/preprod; 1 = mainnet) — ONE derived constant both CIP-8 pallets share | `CardanoNetworkId` |

`MaxScanned` caps CREDENTIALS scanned, which on the role axis is not the same number as entries emitted.
The vault and voting-power axes emit one entry per identity, but an mSPO emits one `SpoCalidus` entry per
declaring pool and the owner path one `SpoOwner` entry per owned pool. Against the live preprod db-sync
the owner path alone resolves 739 (credential, pool) rows across 635 credentials, with one credential
owning 17 pools — so `cogno_observer_observed_roles` runs well ahead of the credential count and is worth
watching on its own.

None of that is a ceiling any more. Before spec 215 the emitted entries were bounded too, and overrunning
that bound made `create_inherent` abstain — dropping the whole inherent and freezing the sole weight
writer chain-wide. Now the observation is a delta with no size bound at all: a large change set pages and
drains. What `MaxScanned` still does is bound the SCOPING sets — how many accounts' credentials one
block's db-sync query covers. Since spec 220 that is a work-per-block knob and nothing more: the scan is
a rotating window, so a credential outside this block's scope is read a few blocks later rather than
never, and `scan_sweep_blocks` is how many "a few" is.

Which credential falls past it stopped being a question in spec 220, because nothing falls past it any
more. Until spec 217 both scans took a hash-ordered prefix, and the scan is the SCOPE of the node's read
— so a credential outside it is absent from the observation, which `derive_call` could not tell apart
from "the stake went to zero". It emitted an explicit unlock and the account's voting power was ZEROED.
Hash order shifts as the map grows, the calls that grow it are bare-unsigned and feeless, and
`blake2_128` is grindable offline, so evicting a chosen account's weight cost about two thousand
key-generation trials and nothing else. Spec 217 closed the EVICTION half by pinning every credential
already holding a live observer basis row, and said in the code that the other half was still open: a
credential that had never been credited and sat past the cap was still never scanned, so a flood could
starve a genuine new binder out of ever being observed.

Spec 220 closes it, and subsumes the pin rather than adding to it. cogno-gate keeps a dense slot table
over every identity-bound account, and the observer holds a cursor into it and reads `MaxScanned`
consecutive slots a block, wrapping at the end. Coverage is complete within `ceil(accounts / MaxScanned)`
blocks; nothing is ever dropped, so there is nothing left for a pin to protect. Position in the rotation
is ARRIVAL ORDER, which is the security property — a resumable cursor over the old hash order would look
equivalent and is not, because an attacker who keeps minting credentials into the gap between a public
cursor and a victim keeps the cursor from ever reaching it.

The rotation is over ACCOUNTS rather than credentials. One window feeds all four db-sync arrays, so an
account is wholly in scope or wholly out of it — which is what keeps the role sink's whole-set overwrite
correct, since an account seen with only some of its credentials would be written back having lost the
rest of its badges. `derive_call` learned the scope with it: absence from the observation clears a basis
row only INSIDE the window, and outside it the row is held until its slot comes round. The vault axis
keeps the naive rule, because it is discovered by policy id and its snapshot really is complete.

Two things stop a held row becoming a permanent one. A bind that goes away tears its observed state down
explicitly (`OnBindTeardown`), and a basis row naming an account that is not enrolled in the rotation at
all is cleared on sight, since no window can ever cover it.

What an operator watches changed with it. "The scan reached `MaxScanned`" now describes every healthy
block on any chain larger than one window, so the two alerts written on it were retired; the signal is
`cogno_observer_scan_sweep_blocks`, which is how long a complete sweep takes and therefore how long a new
bind waits to be credited and how stale a chamber weight can be when `close_poll` freezes it. `1` means
the whole ledger fits in one window, which is the live chain today.


## Governance (sudo-free)

Every privileged call goes through a 3-of-5 committee — there is no sudo (see [ARCHITECTURE.md](ARCHITECTURE.md)).
All in `runtime/src/configs/mod.rs`.

| Parameter | Value | Symbol / file |
|---|---|---|
| Committee threshold | 3-of-5 supermajority, `needed = ceil(n·3/5)` (1→1, 3→2, 5→3, 7→5) | `AuthorityOrigin` (`EnsureProportionAtLeast<3, 5>`) |
| Committee max members | 7 | `FollowerMaxMembers` |
| Allowed committee sizes | 1 or ≥3, all seats DISTINCT, at most `FollowerMaxMembers`. Empty, 2-seat, duplicate-bearing and over-max sets are all rejected (mirrored at genesis). Since spec 213 distinctness is checked FIRST: `pallet_collective::set_members` writes a repeated account through verbatim, and the origin then measures `ayes · 5 ≥ 3 · Members::len()` against a denominator that counts duplicates while `DuplicateVote` caps the reachable ayes at the DISTINCT seats — so `set_members([A,A,A])` used to clear the size rules while seating ONE key, bricking `AuthorityOrigin` permanently. `MaxMembers` is checked here too because the pallet only `log::error!`s an overflow rather than rejecting it | `CognoCallFilter` (wired as `BaseCallFilter`) / `testnet_genesis` — `runtime/src/genesis_config_presets.rs` |
| New committee seat | must already hold a governance-fuel allowance — a `set_members` adding an unfunded account fails `CallFiltered`; sitting members are exempt | `CognoCallFilter` |
| Motion duration | 7 days (100,800 blocks) | `FollowerMotionDuration` |
| Max active proposals | 100 | `FollowerMaxProposals` |
| `MaxProposalWeight` | 50% of `max_block` (1 s of ref_time) | `MaxProposalWeight` |
| `DefaultVote` | `AbstainAsNay` | `pallet_collective::Config` |
| Genesis members | dev: 1 seat (//Alice); local_testnet: 5 seats | `runtime/src/genesis_config_presets.rs` |
| TxPause (break-glass, spec 211) | committee `pause`/`unpause` of any `(pallet, call)` name, enforced via `BaseCallFilter`. Never pausable: both inherents, the committee itself, the upgrade path | `pallet_tx_pause::Config` / `TxPauseWhitelist` |
| TxPause `MaxNameLen` | 256 bytes (over-long names read as paused, fail-closed) | `pallet_tx_pause::Config` |

Governance-fuel (the regenerating admin-fee budget that funds seated accounts):

| Parameter | Value | Symbol / file |
|---|---|---|
| `MaxFuelAllowance` | 1,000 UNIT | `MaxFuelAllowance` |
| `MinFuelAllowance` | 1.001 UNIT (ED + UNIT) | `MinFuelAllowance` |
| `FuelRegenPeriod` | 10 blocks (~1 min); tops each funded account to its ceiling | `FuelRegenPeriod` |
| `MaxFundedAccounts` | 64 (covers 32 validators + 7 committee) | `pallet_governance_fuel::Config` |

## CIP-8 identity (cogno-gate)

The on-chain identity proof (see [TRUSTLESS-IDENTITY.md](TRUSTLESS-IDENTITY.md)).

| Parameter | Value | Symbol / file |
|---|---|---|
| `cose_sign1` max | 512 bytes | `link_identity_signed` / `link_stake_signed` — `pallets/cogno-gate/src/lib.rs`; `claim_role_signed` — `pallets/cardano-roles/src/lib.rs` |
| `cose_key` max | 128 bytes | `link_identity_signed` / `link_stake_signed` — `pallets/cogno-gate/src/lib.rs`; `claim_role_signed` — `pallets/cardano-roles/src/lib.rs` |
| payload bstr max | 256 bytes | `pallets/cogno-gate/src/cip8.rs` |
| `IdentityHash` | 32 bytes (blake2b_256 of owner Address) | `pallets/cogno-gate/src/lib.rs` |
| `StakeCredential` | 28 bytes | `pallets/cogno-gate/src/lib.rs` |
| Role credential | 28 bytes — a bare credential, or the payment credential of a headered address | `verify_bind_proof_role` — `pallets/cogno-gate/src/cip8.rs` |
| Bind tx priority / longevity | 100 / 32 blocks | `validate_unsigned` — `pallets/cogno-gate/src/lib.rs` |

The optional `thread_pointer` argument (and its `ThreadOf` storage) was REMOVED in spec 211 — it was an
unauthenticated free-text field with no on-chain or frontend reader. `cogno-gate` error index 2
(`BadThread`) is permanently vacant. Spec 212 adds the migration that sweeps the rows the live chain
still held (`pallet_cogno_gate::migrations::v1`, storage version 0 → 1) — dropping the declaration
stopped the writes, but the rows themselves would otherwise stay in every state root forever, under a
prefix nothing declares.

## Cardano role tags

Verifiable SPO / dRep / CC badges (see [VERIFIABLE-ROLE-TAGS.md](VERIFIABLE-ROLE-TAGS.md)). Claiming a role
key is a permissionless CIP-8 self-proof (bare-unsigned and feeless, reusing the cogno-gate verifier); the
badge itself is written only by the cardano-observer inherent, so the observed side sits under `MaxScanned`
(the per-`RoleKind` claimed-credential scan cap — no longer a bound on the observation itself, which is a
delta since spec 215).

| Parameter | Value | Symbol / file |
|---|---|---|
| `RoleCredential` | 28 bytes (blake2b-224 key hash: Calidus key hash / drep ID / CC hot credential) | `RoleCredential` — `pallets/cardano-roles/src/lib.rs` |
| Observed badges per account | 32 since spec 217, was 16 — over-cap sets are truncated, not cleared. Since spec 211 the fill runs in TWO passes (dRep/CC first, bounded to a reserve of 4, then SPO pools), so a large mSPO keeps its dRep/CC badge and only surplus pools past the cap are dropped, deterministically. At 16 that left 12..=16 usable SPO slots against a live preprod credential owning 17 pools and mainnet mSPOs running 20-30, so the under-count was waiting on a real operator; the truncation was also SILENT, and now WARNs on the pallet's log target. Raising the cap does NOT need a storage migration for decode (widening a `BoundedVec` bound is decode-compatible) — but it does need the observer's role basis cleared, or `derive_call` sees no difference and never rewrites an already-truncated row (`cardano-observer::migrations::v2`). NARROWING it is the unsafe direction: `ObservedRoles` is `ValueQuery`, so an over-long row decodes to a silently EMPTY badge set | `MAX_OBSERVED_ROLES_PER_ACCOUNT` — `pallets/cardano-roles/src/lib.rs`; the two-pass fill is `Pallet::bound_observed_roles` — same file |
| Claim tx priority / longevity | 100 / 32 blocks | `CLAIM_TX_PRIORITY` / `CLAIM_TX_LONGEVITY` — `pallets/cardano-roles/src/lib.rs` |
| `unclaim_role` fee | feeless only when the caller actually holds that claim; a no-op unclaim is fee-bearing | `unclaim_role` — `pallets/cardano-roles/src/lib.rs` |
| Role-proof single use | `SpentRoleNonce[(account, role)]` records the 16-byte nonce of the last accepted claim and SURVIVES `unclaim_role`, so the exact bytes of an accepted proof cannot be replayed to re-attach a badge the holder removed (the calls are bare-unsigned, so any third party could re-submit them). A fresh proof with a new nonce always works. Residual: only the LAST nonce is remembered, so an account past two claim/unclaim cycles can still be hit by a replay of an older proof. Closing it does not need a `role/v1` grammar change — either remember every nonce (key the map by it too, which makes an append-only map with no prune verb behind a feeless bare-unsigned call), or require the nonce to be strictly increasing (O(1), but the client can no longer mint a random one, so it is a lockstep frontend change). Neither is taken here; the residual only re-attaches the holder's own credential, and `unclaim_role` undoes it for free | `SpentRoleNonce` — `pallets/cardano-roles/src/lib.rs` |
| Revoke tombstone | permanent — a revoked `(role, credential)` can never be re-claimed by anyone | `TombstonedRoleCred` — `pallets/cardano-roles/src/lib.rs` |
| `RoleAuthorityOrigin` | 3-of-5 committee, and it gates `revoke_role` only — claiming is permissionless | `pallet_cardano_roles::Config` (`AuthorityOrigin`) |
| `WeightInfo` | `()` — conservative hand-set placeholders, not benchmarked (mainnet prereq). Each is a COMPUTE floor plus an explicit `RocksDbWeight` term for the storage its dispatch body touches, so the totals are claim ≈530 M / unclaim ≈245 M / revoke ≈350 M `ref_time` (claim 80 M + 6 reads + 3 writes; unclaim 20 M + 1 read + 2 writes; revoke 25 M + 1 read + 3 writes). Before spec 211 the `RocksDbWeight` term was missing entirely, so all three under-declared by roughly 5x. | `impl WeightInfo for ()` — `pallets/cardano-roles/src/weights.rs` |
