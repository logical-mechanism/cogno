# Protocol parameters

Every tunable the chain runs on, in one place, with the value and the file + symbol you'd edit to change
it. This is a snapshot of **spec_version 204** — the runtime that's live on preprod.

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
  Pure bound/value tweaks (a different `MaxLength`, a new cost) are metadata-visible too, so they also
  bump. Non-encoding changes (logging, comments, tests) must **not** bump it.
- **Block time / slot duration cannot change after the chain has started** — doing so bricks block
  production. It's fixed for the life of this chain.
- **Some values are contracts with the outside world, not free knobs:**
  - `transaction_version` (3) — only bump when the extrinsic byte format changes.
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

## Runtime core & versions

| Parameter | Value | Symbol / file |
|---|---|---|
| spec_name / impl_name | `cogno-chain-runtime` | `VERSION` — `runtime/src/lib.rs` |
| **spec_version** | **204** | `VERSION` — `runtime/src/lib.rs` |
| transaction_version | 3 | `VERSION` — `runtime/src/lib.rs` |
| authoring / impl / system_version | 1 / 1 / 1 | `VERSION` — `runtime/src/lib.rs` |
| SS58 prefix | 42 (generic Substrate) | `SS58Prefix` |
| `BlockHashCount` | 2400 blocks (~4 h) | `BlockHashCount` — `runtime/src/lib.rs` |
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
spends from it. **These values are dev-tuned** — the v1 target is a ~5 h regen window. Units are
"micro-capacity"; one post ≈ `BaseCost`. All in `runtime/src/configs/mod.rs`.

| Parameter | Value | Symbol / file |
|---|---|---|
| `CapRatio` (ceiling per weight) | 50 micro-cap / lovelace | `CapRatio` |
| `RegenPerBlock` | 2 micro-cap / lovelace / block | `RegenPerBlock` |
| `Ceiling` (hard max) | 5e12 (~100k posts) | `Ceiling` |
| `BaseCost` (per post) | 50,000,000 (= 1 post) | `BaseCost` |
| `PerByteCost` | 50,000 / byte | `PerByteCost` |
| `VoteCost` | 20,000,000 | `pallet_microblog::Config` |
| `FollowCost` | 10,000,000 | `pallet_microblog::Config` |
| `ProfileCost` (foreign) | 500,000,000 (= 10× `BaseCost`) | `ProfileCost` |
| `CheckCapacity` tx longevity | 8 blocks | `longevity` — `pallets/microblog/src/lib.rs` |

First-touch capacity starts at **0** (anti-farm), regenerates up to the ceiling, and never decays.
There's no cooldown — capacity is the only rate limit.

## Content bounds

| Parameter | Value | Symbol / file |
|---|---|---|
| Max post / poll-question length | 512 bytes | `MaxLength` — `pallet_microblog::Config` |
| `MaxPostsPerAuthor` (on-chain index) | 10,000 | `pallet_microblog::Config` |
| `MaxPollOptions` | 4 (min 2 enforced) | `pallet_microblog::Config` |
| `MaxPollOptionLen` | 80 bytes | `pallet_microblog::Config` |
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
| `StabilitySlots` | 600 slots (~10 min, testnet) | `STABILITY_SLOTS_TESTNET` (mainnet `STABILITY_SLOTS_MAINNET` = 129,600, held unused) |
| Shelley anchor (preprod) | unix 1,655,769,600 / slot 86,400 | `ObsShelleyStartUnix` / `ObsShelleyStartSlot` |
| `StakeEpochLookback` | 1 epoch | `pallet_cardano_observer::Config` |
| `VaultPolicyId` | `168a9710…` (live L1 script hash — do not change lightly) | `ObsVaultPolicyId` |
| `EnforceWeight` default | `true` (observer is sole weight writer from genesis) | `pallets/cardano-observer/src/lib.rs` |
| `CardanoNetwork` | 0 (testnet/preprod) | `pallet_cogno_gate::Config` |

## Governance (sudo-free)

Every privileged call goes through a 3-of-5 committee — there is no sudo (see [ARCHITECTURE.md](ARCHITECTURE.md)).
All in `runtime/src/configs/mod.rs`.

| Parameter | Value | Symbol / file |
|---|---|---|
| Committee threshold | 3-of-5 supermajority, `needed = ceil(n·3/5)` (1→1, 3→2, 5→3, 7→5) | `AuthorityOrigin` (`EnsureProportionAtLeast<3, 5>`) |
| Committee max members | 7 | `FollowerMaxMembers` |
| Allowed committee sizes | 1 or ≥3 (empty and 2-seat rejected) | `BaseCallFilter` |
| Motion duration | 7 days (100,800 blocks) | `FollowerMotionDuration` |
| Max active proposals | 100 | `FollowerMaxProposals` |
| `DefaultVote` | `AbstainAsNay` | `pallet_collective::Config` |
| Genesis members | dev: 1 seat (//Alice); local_testnet: 5 seats | `runtime/src/genesis_config_presets.rs` |

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
| `cose_sign1` max | 512 bytes | `link_identity_signed` — `pallets/cogno-gate/src/lib.rs` |
| `cose_key` max | 128 bytes | `link_identity_signed` — `pallets/cogno-gate/src/lib.rs` |
| payload bstr max | 256 bytes | `pallets/cogno-gate/src/cip8.rs` |
| `IdentityHash` | 32 bytes (blake2b_256 of owner Address) | `pallets/cogno-gate/src/lib.rs` |
| `StakeCredential` | 28 bytes | `pallets/cogno-gate/src/lib.rs` |
| Thread pointer | ≤10 bytes (5 raw / 10 hex) | `pallets/cogno-gate/src/lib.rs` |
| Bind tx priority / longevity | 100 / 32 blocks | `validate_unsigned` — `pallets/cogno-gate/src/lib.rs` |
