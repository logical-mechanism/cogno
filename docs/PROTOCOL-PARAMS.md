# Protocol parameters

Every tunable the chain runs on, in one place, with the value and the exact spot in the code you'd
edit to change it. This is a snapshot of **spec_version 203** — the runtime that's live on preprod.

Two things to keep in mind:

- **For live truth, ask a node** (`state_getRuntimeVersion`, `state_getMetadata`). This file mirrors
  the source, but the running chain is the authority. If they ever disagree, the node wins and this
  file is stale.
- **Most of these are compile-time constants.** Changing one means recompiling the runtime and
  shipping it as an upgrade ([UPGRADES.md](UPGRADES.md)) — it is not a config file the node reads at
  boot. A few can't change at all after genesis (noted below).

## Before you change anything

- **Encoding-affecting changes bump `spec_version`.** New/changed calls, storage, events, or
  transaction extensions change the metadata → bump `spec_version` ([runtime/src/lib.rs:284](../runtime/src/lib.rs#L284))
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

| Parameter | Value | Defined in |
|---|---|---|
| Consensus | Aura (authoring) + GRANDPA (finality) | `node/src/service.rs` |
| **Block time** | **6 s** (`MILLI_SECS_PER_BLOCK` = 6000 ms) | [lib.rs:301](../runtime/src/lib.rs#L301) |
| Slot duration | 6 s (`= MILLI_SECS_PER_BLOCK`; can't change post-genesis) | [lib.rs:305](../runtime/src/lib.rs#L305) |
| Aura `SlotDuration` | `MinimumPeriod × 2` = 6 s | [configs/mod.rs:321](../runtime/src/configs/mod.rs#L321) |
| `MinimumPeriod` (timestamp) | 3 s (`SLOT_DURATION / 2`) | [configs/mod.rs:352](../runtime/src/configs/mod.rs#L352) |
| `AllowMultipleBlocksPerSlot` | `false` (one block/slot) | [configs/mod.rs:320](../runtime/src/configs/mod.rs#L320) |
| Block proposal slot portion | 2/3 of the slot | [service.rs:544](../node/src/service.rs#L544) |
| GRANDPA justification period | 512 blocks | [service.rs:224](../node/src/service.rs#L224) |
| GRANDPA gossip duration | 333 ms | [service.rs:569](../node/src/service.rs#L569) |
| **SessionPeriod** | **10 blocks (~1 min)** — dev-tuned short | [configs/mod.rs:577](../runtime/src/configs/mod.rs#L577) |
| SessionOffset | 0 | [configs/mod.rs:578](../runtime/src/configs/mod.rs#L578) |
| Derived MINUTES / HOURS / DAYS | 10 / 600 / 14,400 blocks | [lib.rs:310](../runtime/src/lib.rs#L310) |

Aura has no epochs — `SessionPeriod` is the nearest analog. A queued validator add/remove applies at
the next-but-one session boundary (~2 sessions, ~2 min).

## Validators & authorities

| Parameter | Value | Defined in |
|---|---|---|
| `MinAuthorities` | **1** — testnet floor; mainnet prereq is ≥4 (3f+1) | [configs/mod.rs:660](../runtime/src/configs/mod.rs#L660) |
| `MaxValidators` | 32 (must be ≤ MaxAuthorities) | [configs/mod.rs:663](../runtime/src/configs/mod.rs#L663) |
| Aura `MaxAuthorities` | 32 | [configs/mod.rs:319](../runtime/src/configs/mod.rs#L319) |
| GRANDPA `MaxAuthorities` | 32 | [configs/mod.rs:340](../runtime/src/configs/mod.rs#L340) |
| GRANDPA `MaxNominators` / `MaxSetIdSessionEntries` | 0 / 0 (equivocation reporting is a deliberate no-op) | [configs/mod.rs:341](../runtime/src/configs/mod.rs#L341) |
| SessionKeys | `{ aura, grandpa }` | [lib.rs:53](../runtime/src/lib.rs#L53) |
| Session `KeyDeposit` | 0 (must stay 0 while `purge_keys` is filtered) | [configs/mod.rs:604](../runtime/src/configs/mod.rs#L604) |

## Runtime core & versions

| Parameter | Value | Defined in |
|---|---|---|
| spec_name / impl_name | `cogno-chain-runtime` | [lib.rs:64](../runtime/src/lib.rs#L64) |
| **spec_version** | **203** | [lib.rs:284](../runtime/src/lib.rs#L284) |
| transaction_version | 3 | [lib.rs:290](../runtime/src/lib.rs#L290) |
| authoring / impl / system_version | 1 / 1 / 1 | [lib.rs:285](../runtime/src/lib.rs#L285) |
| SS58 prefix | 42 (generic Substrate) | [configs/mod.rs:73](../runtime/src/configs/mod.rs#L73) |
| `BlockHashCount` | 2400 blocks (~4 h) | [lib.rs:314](../runtime/src/lib.rs#L314) |
| `MaxConsumers` | 16 | [configs/mod.rs:312](../runtime/src/configs/mod.rs#L312) |
| `DbWeight` | RocksDbWeight | [configs/mod.rs:305](../runtime/src/configs/mod.rs#L305) |

## Block limits & fees

| Parameter | Value | Defined in |
|---|---|---|
| Max block weight (ref_time) | 2 s of compute (`2e12`) | [configs/mod.rs:65](../runtime/src/configs/mod.rs#L65) |
| Max block weight (proof_size) | `u64::MAX` (PoV effectively unbounded) | [configs/mod.rs:66](../runtime/src/configs/mod.rs#L66) |
| `NORMAL_DISPATCH_RATIO` | 75% | [configs/mod.rs:58](../runtime/src/configs/mod.rs#L58) |
| Max block length | 5 MiB (Normal class scaled to 75%) | [configs/mod.rs:70](../runtime/src/configs/mod.rs#L70) |
| WeightToFee / LengthToFee | `IdentityFee` (1:1) | [configs/mod.rs:383](../runtime/src/configs/mod.rs#L383) |
| FeeMultiplier | 1 (fixed) | [configs/mod.rs:376](../runtime/src/configs/mod.rs#L376) |
| OperationalFeeMultiplier | 5 | [configs/mod.rs:382](../runtime/src/configs/mod.rs#L382) |

Posting is feeless and metered by talk-capacity, not fees (see [ECONOMICS.md](ECONOMICS.md)); the fee
machinery above only matters for the rare priced/operational call.

## Native token (governance FUEL)

The native balance is a non-transferable governance **FUEL** token, not a user currency. Symbol and
decimals are display-only chainspec properties.

| Parameter | Value | Defined in |
|---|---|---|
| Symbol / decimals | FUEL / 12 | [gen_chainspec.rs:211](../node/src/gen_chainspec.rs#L211) |
| `UNIT` | 1e12 (Balance = `u128`) | [lib.rs:317](../runtime/src/lib.rs#L317) |
| ExistentialDeposit | 1e9 (MILLI_UNIT) | [lib.rs:322](../runtime/src/lib.rs#L322) |
| `MaxLocks` (Balances) | 50 | [configs/mod.rs:357](../runtime/src/configs/mod.rs#L357) |

## Talk-capacity economics (microblog)

The posting rate limit: your locked-ADA weight buys a regenerating capacity budget, and each action
spends from it. **These values are dev-tuned** — the v1 target is a ~5 h regen window, noted at
[configs/mod.rs:687](../runtime/src/configs/mod.rs#L687). Units are "micro-capacity"; one post ≈ `BaseCost`.

| Parameter | Value | Defined in |
|---|---|---|
| `CapRatio` (ceiling per weight) | 50 micro-cap / lovelace | [configs/mod.rs:695](../runtime/src/configs/mod.rs#L695) |
| `RegenPerBlock` | 2 micro-cap / lovelace / block | [configs/mod.rs:696](../runtime/src/configs/mod.rs#L696) |
| `Ceiling` (hard max) | 5e12 (~100k posts) | [configs/mod.rs:697](../runtime/src/configs/mod.rs#L697) |
| `BaseCost` (per post) | 50,000,000 (= 1 post) | [configs/mod.rs:698](../runtime/src/configs/mod.rs#L698) |
| `PerByteCost` | 50,000 / byte | [configs/mod.rs:699](../runtime/src/configs/mod.rs#L699) |
| `VoteCost` | 20,000,000 | [configs/mod.rs:738](../runtime/src/configs/mod.rs#L738) |
| `RepostCost` | 20,000,000 (repost is retired; constant still present) | [configs/mod.rs:739](../runtime/src/configs/mod.rs#L739) |
| `FollowCost` | 10,000,000 | [configs/mod.rs:740](../runtime/src/configs/mod.rs#L740) |
| `ProfileCost` (foreign) | 500,000,000 (= 10× BaseCost) | [configs/mod.rs:704](../runtime/src/configs/mod.rs#L704) |
| CheckCapacity tx longevity | 8 blocks | [pallets/microblog/src/lib.rs:1521](../pallets/microblog/src/lib.rs#L1521) |

First-touch capacity starts at **0** (anti-farm), regenerates up to the ceiling, and never decays.
There's no cooldown — capacity is the only rate limit.

## Content bounds

| Parameter | Value | Defined in |
|---|---|---|
| Max post / poll-question length | 512 bytes | [configs/mod.rs:728](../runtime/src/configs/mod.rs#L728) |
| `MaxPostsPerAuthor` (on-chain index) | 10,000 | [configs/mod.rs:729](../runtime/src/configs/mod.rs#L729) |
| `MaxPollOptions` | 4 (min 2 enforced) | [configs/mod.rs:742](../runtime/src/configs/mod.rs#L742) |
| `MaxPollOptionLen` | 80 bytes | [configs/mod.rs:743](../runtime/src/configs/mod.rs#L743) |
| Following / Followers | unbounded (no `MaxFollowing`) | `pallets/microblog/src/lib.rs` |

Profile field bounds (pallet-profile; there is no separate "handle" — `display_name` is the only name):

| Field | Bytes | Defined in |
|---|---|---|
| `MaxName` (display name) | 64 | [configs/mod.rs:919](../runtime/src/configs/mod.rs#L919) |
| `MaxBio` | 256 | [configs/mod.rs:920](../runtime/src/configs/mod.rs#L920) |
| `MaxAvatar` (URL/CID ref) | 128 | [configs/mod.rs:921](../runtime/src/configs/mod.rs#L921) |
| `MaxBanner` (URL/CID ref) | 256 | [configs/mod.rs:922](../runtime/src/configs/mod.rs#L922) |
| `MaxLocation` | 64 | [configs/mod.rs:923](../runtime/src/configs/mod.rs#L923) |
| `MaxWebsite` (URL ref) | 256 | [configs/mod.rs:924](../runtime/src/configs/mod.rs#L924) |

## Cardano observer

How the node reads Cardano to credit weight (see [IN-PROTOCOL-OBSERVATION.md](IN-PROTOCOL-OBSERVATION.md)).
These are consensus-critical — a change here can fork the chain.

| Parameter | Value | Defined in |
|---|---|---|
| `MaxObserved` | 4096 (hard cap, full snapshot/block; node WARNs at 75%) | [configs/mod.rs:881](../runtime/src/configs/mod.rs#L881) |
| `MinLock` | 100 ADA (100,000,000 lovelace) | [configs/mod.rs:847](../runtime/src/configs/mod.rs#L847) |
| `MaxStakeWeight` | 45e15 lovelace (~total ADA supply; over-cap entry skipped) | [configs/mod.rs:884](../runtime/src/configs/mod.rs#L884) |
| `MaxVotingPower` | 45e15 lovelace (over-cap entry skipped) | [configs/mod.rs:892](../runtime/src/configs/mod.rs#L892) |
| `StabilitySlots` | 600 slots (~10 min, testnet); mainnet const 129,600 held unused | [configs/mod.rs:840](../runtime/src/configs/mod.rs#L840) |
| Shelley anchor (preprod) | unix 1,655,769,600 / slot 86,400 | [configs/mod.rs:844](../runtime/src/configs/mod.rs#L844) |
| `StakeEpochLookback` | 1 epoch | [configs/mod.rs:895](../runtime/src/configs/mod.rs#L895) |
| `VaultPolicyId` | `168a9710…` (live L1 script hash — do not change lightly) | [configs/mod.rs:852](../runtime/src/configs/mod.rs#L852) |
| `EnforceWeight` default | `true` (observer is sole weight writer from genesis) | `pallets/cardano-observer/src/lib.rs` |
| `CardanoNetwork` | 0 (testnet/preprod) | [configs/mod.rs:771](../runtime/src/configs/mod.rs#L771) |

## Governance (sudo-free)

Every privileged call goes through a 3-of-5 committee — there is no sudo (see [ARCHITECTURE.md](ARCHITECTURE.md)).

| Parameter | Value | Defined in |
|---|---|---|
| Committee threshold | 3-of-5 supermajority, `needed = ceil(n·3/5)` (1→1, 3→2, 5→3, 7→5) | [configs/mod.rs:562](../runtime/src/configs/mod.rs#L562) |
| Committee max members | 7 | [configs/mod.rs:502](../runtime/src/configs/mod.rs#L502) |
| Allowed committee sizes | 1 or ≥3 (empty and 2-seat rejected) | [configs/mod.rs:135](../runtime/src/configs/mod.rs#L135) |
| Motion duration | 7 days (100,800 blocks) | [configs/mod.rs:498](../runtime/src/configs/mod.rs#L498) |
| Max active proposals | 100 | [configs/mod.rs:500](../runtime/src/configs/mod.rs#L500) |
| DefaultVote | AbstainAsNay | [configs/mod.rs:535](../runtime/src/configs/mod.rs#L535) |
| Genesis members | dev: 1 seat (//Alice); local_testnet: 5 seats | `runtime/src/genesis_config_presets.rs` |

Governance-fuel (the regenerating admin-fee budget that funds seated accounts):

| Parameter | Value | Defined in |
|---|---|---|
| `MaxFuelAllowance` | 1,000 UNIT | [configs/mod.rs:418](../runtime/src/configs/mod.rs#L418) |
| `MinFuelAllowance` | 1.001 UNIT (ED + UNIT) | [configs/mod.rs:425](../runtime/src/configs/mod.rs#L425) |
| `FuelRegenPeriod` | 10 blocks (~1 min); tops each funded account to its ceiling | [configs/mod.rs:430](../runtime/src/configs/mod.rs#L430) |
| `MaxFundedAccounts` | 64 (covers 32 validators + 7 committee) | [configs/mod.rs:476](../runtime/src/configs/mod.rs#L476) |

## CIP-8 identity (cogno-gate)

The on-chain identity proof (see [TRUSTLESS-IDENTITY.md](TRUSTLESS-IDENTITY.md)).

| Parameter | Value | Defined in |
|---|---|---|
| cose_sign1 max | 512 bytes | [pallets/cogno-gate/src/lib.rs:257](../pallets/cogno-gate/src/lib.rs#L257) |
| cose_key max | 128 bytes | [pallets/cogno-gate/src/lib.rs:258](../pallets/cogno-gate/src/lib.rs#L258) |
| payload bstr max | 256 bytes | [pallets/cogno-gate/src/cip8.rs:262](../pallets/cogno-gate/src/cip8.rs#L262) |
| IdentityHash | 32 bytes (blake2b_256 of owner Address) | [pallets/cogno-gate/src/lib.rs:71](../pallets/cogno-gate/src/lib.rs#L71) |
| StakeCredential | 28 bytes | [pallets/cogno-gate/src/lib.rs:77](../pallets/cogno-gate/src/lib.rs#L77) |
| Thread pointer | ≤10 bytes (5 raw / 10 hex) | [pallets/cogno-gate/src/lib.rs:141](../pallets/cogno-gate/src/lib.rs#L141) |
| Bind tx priority / longevity | 100 / 32 blocks | [pallets/cogno-gate/src/lib.rs:532](../pallets/cogno-gate/src/lib.rs#L532) |
