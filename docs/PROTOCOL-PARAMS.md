# Protocol parameters

Every tunable the chain runs on, in one place, with the value and the file + symbol you'd edit to change
it. This is a snapshot of **spec_version 213**.

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
  - `transaction_version` (7) — only bump when the extrinsic byte format changes.
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
| **spec_version** | **213** | `VERSION` — `runtime/src/lib.rs` |
| transaction_version | 7 | `VERSION` — `runtime/src/lib.rs` |
| `DESCRIPTOR_SPEC_VERSION` (frontend lockstep) | 213 — must equal `spec_version`; `npm run lint` fails on drift, and a mismatch blocks posting | `DESCRIPTOR_SPEC_VERSION` — `app/src/lib/chain/client.ts` |
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
| `NORMAL_DISPATCH_RATIO` | 75% | `NORMAL_DISPATCH_RATIO` |
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
| `MaxObservedAccounts` (accounts a tally joins over) | 1024 (= the observer's `MaxObserved`) — declares `close_poll`'s worst case, which then refunds down to the rows actually scanned | `pallet_microblog::Config` |
| Roles folded per voter in a chamber tally | 16 (the observed-badge cap — see [Cardano role tags](#cardano-role-tags)) | `MAX_OBSERVED_ROLES_PER_ACCOUNT` — `pallets/cardano-roles/src/lib.rs` |
| Poll deadline (`close_at`) | REQUIRED since spec 211, and validated into `[now + MinPollDuration, now + MaxPollDuration]`. (A pre-211 `None` poll already in storage keeps floating and can never be frozen.) | `create_poll` — `pallets/microblog/src/lib.rs` |
| `MinPollDuration` | 100 blocks (10 min) | `pallet_microblog::Config` |
| `MaxPollDuration` | 1,296,000 blocks (90 days) | `pallet_microblog::Config` |

## Cardano observer

How the node reads Cardano to credit weight (see [IN-PROTOCOL-OBSERVATION.md](IN-PROTOCOL-OBSERVATION.md)).
These are consensus-critical — a change here can fork the chain. All in `runtime/src/configs/mod.rs`.

| Parameter | Value | Symbol / file |
|---|---|---|
| `MaxObserved` | 1024 (hard cap, full snapshot/block; node WARNs at 75%) | `pallet_cardano_observer::Config` |
| `StallAfter` | 50 blocks (5 min) before `ObservationStalled` latches | `pallet_cardano_observer::Config` |
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
badge itself is written only by the cardano-observer inherent, so the observed side sits under `MaxObserved`.

| Parameter | Value | Symbol / file |
|---|---|---|
| `RoleCredential` | 28 bytes (blake2b-224 key hash: Calidus key hash / drep ID / CC hot credential) | `RoleCredential` — `pallets/cardano-roles/src/lib.rs` |
| Observed badges per account | 16 — over-cap sets are truncated, not cleared. Since spec 211 the fill runs in TWO passes (dRep/CC first, then SPO pools), so a large mSPO keeps its dRep/CC badge and only surplus pools past the cap are dropped, deterministically. Residual limitation: an mSPO with more than ~14 pools still under-counts its OWN SPO-chamber weight (the dropped pools' delegated stake is not summed), and raising the cap needs a storage migration | `MAX_OBSERVED_ROLES_PER_ACCOUNT` — `pallets/cardano-roles/src/lib.rs`; the two-pass fill is `RoleApply` — `runtime/src/configs/mod.rs` |
| Claim tx priority / longevity | 100 / 32 blocks | `CLAIM_TX_PRIORITY` / `CLAIM_TX_LONGEVITY` — `pallets/cardano-roles/src/lib.rs` |
| `unclaim_role` fee | feeless only when the caller actually holds that claim; a no-op unclaim is fee-bearing | `unclaim_role` — `pallets/cardano-roles/src/lib.rs` |
| Revoke tombstone | permanent — a revoked `(role, credential)` can never be re-claimed by anyone | `TombstonedRoleCred` — `pallets/cardano-roles/src/lib.rs` |
| `RoleAuthorityOrigin` | 3-of-5 committee, and it gates `revoke_role` only — claiming is permissionless | `pallet_cardano_roles::Config` (`AuthorityOrigin`) |
| `WeightInfo` | `()` — conservative hand-set placeholders, not benchmarked (mainnet prereq). Each is a COMPUTE floor plus an explicit `RocksDbWeight` term for the storage its dispatch body touches, so the totals are claim ≈405 M / unclaim ≈245 M / revoke ≈350 M `ref_time` (claim 80 M + 5 reads + 2 writes; unclaim 20 M + 1 read + 2 writes; revoke 25 M + 1 read + 3 writes). Before spec 211 the `RocksDbWeight` term was missing entirely, so all three under-declared by roughly 5x. | `impl WeightInfo for ()` — `pallets/cardano-roles/src/weights.rs` |
