# How the node observes Cardano

On cogno-chain the right to post is not paid for with a fee. It is metered by a regenerating,
stake-weighted **talk-capacity** that is *earned* by locking ADA in the `talk_vault` contract on
Cardano L1. Something has to turn "this identity has 250 ADA locked" into on-chain weight. That
something is the **`cardano-observer` inherent** (pallet index 16).

Cardano is **observed, not bridged**. Every block, each node reads the current `talk_vault` UTxO set
out of a local, read-only Cardano **db-sync** and credits the resulting locked-ADA weight to the bound
accounts. There is no bridge, no message-passing, and nothing is written back to Cardano — the chain
supplies its own Aura/GRANDPA safety and simply *reads* Cardano as a data source.

This doc covers how that read works, why it is deterministic enough to be a consensus rule, and what an
operator must run. For the wider picture see [`ARCHITECTURE.md`](ARCHITECTURE.md); the weight→capacity
curve lives in [`ECONOMICS.md`](ECONOMICS.md).

## The observer is the sole writer of weight

The `cardano-observer` inherent is the **only** thing that writes talk-stake weight. This is worth
stating plainly because it removes a whole class of trusted component:

- There is **no `set_stake` extrinsic.** The old privileged "trusted follower injects the weight" call
  was deleted. Weight cannot be set by a transaction, by the committee, or by sudo (there is no sudo).
- There is **no off-chain follower service.** The read happens *inside the node*, on the block-import
  path, as an inherent — not in a separate daemon that the chain trusts.
- The observer writes both weights it derives: vault lovelace → `AllowedStake` (posting weight) and
  each bound stake credential's total Cardano stake (`epoch_stake`) → `VotingPower` (voting weight).

Enforcement is **on from genesis** (`EnforceWeight` defaults to `true`), so from block 0 the verified
observation is what drives weight and capacity. The only knob is an emergency freeze — see below.

## The read: one db-sync snapshot per block

The Cardano read lives in the shared `cogno-dbsync` crate (`cogno-dbsync/src/dbsync.rs` +
`reduction.rs`). The node's inherent-data provider is the sole consensus **writer** that calls it; the
node's boot-time `config_check` probe calls the *same* crate **read-only** (a non-blocking startup
check), so the one read path is exercised without a second implementation. Both reach db-sync through
the `DBSYNC_URL` (or `DBSYNC`) environment variable. (`cogno-chain-cli query weight` reads the resulting
on-chain `TalkStake` ledger over RPC — it does not read db-sync.)

Each block, `read_observation` runs **one read-only Postgres MVCC snapshot** and returns three things
from that single consistent view (so the tip, the anchor, and the matched UTxOs can never diverge
across an inter-call rollback):

1. **freshness** — `max(block.slot_no)`, the db-sync tip. If this node's db-sync is behind the block's
   reference slot, the node abstains (see verification, below).
2. **the anchor** — the single `block` row with the greatest `slot_no <= reference`: the latest stable
   Cardano block at or under the reference. Cardano settles to ≤1 block per slot, so this row is unique
   and identical across every fully-synced db-sync.
3. **the vault UTxOs** — every UTxO at the vault script address, shaped in SQL into the exact JSON the
   pure reduction consumes byte-for-byte.

The reduction (`observe_as_of`) then keeps, per beacon, the single largest qualifying UTxO and emits a
canonically-sorted `(beacon, lovelace)` set. That set — plus the voting-power `(stake_credential,
lovelace)` set from `epoch_stake` — is the observation the node carries into the block.

## Consensus-critical byte-identity invariants

These rules govern the read exactly. **Every full node must re-derive a byte-identical observation; a
divergence is a chain fork.** Do not "optimize" any of them.

- **Spentness is read from `tx_in` — never `consumed_by_tx_id`.** The denormalized `consumed_by_tx_id`
  column is config-dependent and was observed NULL for a known-spent vault UTxO on the live instance.
  `tx_in` is canonical ledger data, identical on every correctly-synced db-sync.
- **Coins and quantities are read as `::text` strings.** Locked lovelace can exceed 2⁵³
  (`MaxStakeWeight` is 4.5×10¹⁶), so a JSON `Number`/float would lose precision. The strings are parsed
  by strict integer parsers (pure ASCII digits only).
- **The vault UTxO set is selected by `tx_out.payment_cred = <script hash>`.** The vault script address
  equals the beacon policy id, and `payment_cred` is indexed, so the whole read runs in ~15 ms. (The
  asset-driven query would sequential-scan millions of `ma_tx_out` rows.)
- **A fail-closed ABSTAIN when `tx_in` is absent.** The read probes `EXISTS (SELECT 1 FROM tx_in)`. On a
  `--consumed-tx-out` db-sync `tx_in` is empty, so the read abstains rather than silently reading a
  spent vault as still locked. It never falls back to `consumed_by_tx_id`.
- **Largest-UTxO-wins per identity — never summed.** For each beacon the reduction keeps only the single
  largest qualifying UTxO. Summing would let one identity inflate its weight by splitting a lock across
  many UTxOs (anti-Sybil).

The whole read is bounded by a 2-second timeout, and **any** failure (connect, query, timeout,
malformed row, missing `tx_in`) collapses to the **empty observation** — the node abstains, it never
guesses. A stopped or lagging db-sync therefore never stalls block production.

## The determinism contract

The observation is only a valid consensus rule if every node computes the same bytes. Two design
choices make that true.

**The reference slot is a pure function of the parent block, not the live tip.** Reading "unspent
*now*" would depend on when and where the read ran. Instead every node derives one reference slot from
the **parent** block's Aura slot:

```
parent_unix   = parent_aura_slot × slot_length_ms / 1000
cardano_slot  = SHELLEY_START_SLOT + (parent_unix − SHELLEY_START_UNIX)   // Shelley: 1 slot/s
reference     = cardano_slot − STABILITY_SLOTS
```

All of it is checked arithmetic. Release WASM is built with overflow checks off, so a pre-Shelley or
wrong-network input would *wrap* rather than error; every step uses `checked_sub`/`checked_add` and maps
any failure to the empty observation. The anchor is pinned to the **Shelley** start
(`1655769600` / slot `86400` on preprod), **not** the Byron `systemStart` — preprod ran a 20-day Byron
prefix, so pinning `systemStart` would offset every slot by 86400 and brick the read. Mainnet anchors
must be verified against the mainnet genesis before any cutover.

**The stability window keeps the read inside immutable history.** `STABILITY_SLOTS` is `3k/f` = 129,600
slots (~36 h) for mainnet/preprod — the Praos common-prefix horizon past which Cardano cannot roll back.
A smaller value (currently 600 slots, ~10 min) is used **only** on this labeled testnet for prompt
observability. One consequence: because grant and clamp share this single conservative cursor, an unlock
takes up to a full window to zero out. That is safe (weight can never be double-counted) and is a
mainnet tuning parameter.

The reduction is pinned by a committed golden fixture
(`cogno-dbsync/src/fixtures/observation-equivalence.json`): the canonical SCALE bytes and the
input-commitment pre-image are asserted byte-for-byte, so a reduction change that would fork the chain
fails a test instead.

## The header seal

The reference the observation was taken as-of is a `CardanoRef { slot, block_hash }`. The `slot` is the
parent-derived value above; `block_hash` is the header hash of the anchor — the latest stable Cardano
block at or under that slot.

The node's custom proposer (`node/src/consensus/`) seals this `CardanoRef` into **each block header** as
a `cobs` `PreRuntime` digest. This makes the specific stable Cardano block that underlay the read a
first-class, externally-auditable artifact: anyone reading only cogno-chain headers can see which
Cardano block each block was anchored to.

The seal is a **mirror, not a gate**. What importers re-validate is the *inherent's* `CardanoRef` (slot
**and** `block_hash`) against their own read, so a forged or regressing anchor is caught there — it is
safe to compare `block_hash` because the anchor is a single unique `block` row in immutable history, and
a node whose own db-sync is behind abstains before it could reach a false mismatch. The **header digest
itself is not decoded on import**: an author who sealed an anchor contradicting the observation it
applied would still be accepted, so a header-only auditor is trusting the author's seal to match the
inherent. The decoder that would make the digest consensus-binding is implemented and unit-tested in
`node/src/consensus/cardano_digest.rs`, staged for a future runtime upgrade.

## Verification: mismatch rejects, can't-check defers

The observation travels as inherent data. The `observe` dispatchable is `DispatchClass::Mandatory` and
inherent-only (`is_inherent` is true), so it can never enter the public transaction pool.

On import, `check_inherent` compares the author's observation against the importer's **own** read at the
same reference and returns one of three outcomes (`InherentError`):

- **`Mismatch` (fatal).** The importer read *different* Cardano data — the reduced entries differ and the
  input commitments differ. The block is permanently rejected. Matching is **exact**, never a tolerance
  band: a band would let a malicious author inject an observation no honest node agrees with.
- **`ComputeDiverged` (fatal).** Author and importer agree on the raw inputs (identical
  `inputs_commitment`) but reduced them to different entries — i.e. the same data reduced differently, a
  determinism bug or a binary version skew. Split out from `Mismatch` purely as a diagnostic; both are
  fatal. The commitment is only consulted when the entries already disagree, so it never rejects on its
  own.
- **`CannotVerify` (non-fatal).** The importer's *own* db-sync is behind the reference or down, so it
  accepts the block without verifying it. This is what keeps a lagging node from forking the chain — but
  it means a bad block is caught only if at least one honest, caught-up, full-execution verifier is in
  the set.

`check_inherent` is a network-edge gate — it is not re-run inside `execute_block` and is skipped on warp/
state sync. So anything that must hold on **every** node — reference monotonicity, the `MaxStakeWeight`
skip, account resolution, weight application, the unlock clamp — is enforced inside the Mandatory
`observe` dispatchable, which *does* run in `execute_block` and whose dispatch error invalidates the
block.

## Applying the observation

For each `(beacon, lovelace)` in the verified set, the `observe` dispatchable, atomically:

1. resolves `account = CognoGate::AccountOf[beacon]`; an unbound beacon is skipped, not an error (a bind
   must precede weight).
2. applies the `MinLock` floor (100,000,000 lovelace): below it, weight is 0.
3. **skips, never rejects, an over-cap entry.** If weight exceeds `MaxStakeWeight`, that one entry is
   dropped and counted — a single absurd value must not brick a Mandatory block. (This deliberately
   differs from the old `set_stake`, which rejected the whole call.)
4. sets weight via talk-stake's internal entry point and primes microblog capacity in the same write,
   preserving the going-forward-only / unlock→0 / never-delete-the-row invariants.
5. **unlock clamp:** any account credited last block (`LastObserved`) that is absent from the current set
   is set to weight 0. This is why the full observed set is carried every block and `LastObserved` is
   stored — a bare digest could not tell you *which* identities dropped out.

The voting-power half runs the same discipline over `epoch_stake` totals: resolve the bound stake
credential, skip over-`MaxVotingPower` values, apply `VotingPower`, clamp anything that dropped out.
There is no floor and no largest-wins there — the node supplies one total per credential, read at
`StakeEpochLookback` epochs before the reference's epoch (a fully-closed, immutable snapshot). Each
result is recorded in an `ObservationApplied` / `VotingPowerObserved` event.

## Emergency freeze

`set_enforcement(false)` is **not** a cutover flip — it is an emergency weight-**freeze**. When frozen,
the inherent keeps verifying the read cross-node (`check_inherent` is flag-independent) but stops writing
`AllowedStake`/`VotingPower`, and the clamp baseline is held so an unlock that happens mid-freeze is
still clamped on re-enable. This lets a determinism bug be halted before a bad observation corrupts
weight, then fixed via a committee-governed runtime upgrade. It is gated by the 3-of-5 committee
(`EnforceOrigin`), the same origin that gates identity revoke, validator changes, and upgrades. Weight
simply holds at its last values while frozen.

## Operator requirements

Every **verifying** validator must run its own buried Cardano indexer: a `cardano-node` plus Cardano
db-sync. The consensus read touches only the one vault policy, so per-block cost is a single ~15 ms
indexed snapshot, but the standing cost is a Cardano relay-class machine (roughly 24 GB RAM, ~250 GB SSD,
a 1–2 day initial sync) alongside the node. Point the node at it with `DBSYNC_URL`. A one-shot
`config_check` runs at boot: with `DBSYNC_URL` set it probes the live vault under the pinned policy and
logs the result; unset, it logs the config and the chain still produces and finalizes (the observer
simply abstains).

**MAINNET PREREQUISITE:** db-sync must run **FULL / non-pruned** (retaining block and spend history back
to the ~36 h reference), **`tx_in`-enabled** (NOT `--consumed-tx-out` — spentness is read from `tx_in`,
and the read fails closed otherwise), and over **TLS**. The current preprod setup connects `NoTls` over a
private LAN to a read-only `cogno_reader` role; TLS is the mainnet gap.

## Trust posture

With a single block producer the sole author is also the only checker, so the "every node re-derives"
property buys **auditability, not trustlessness** — the observation rule is the runtime's own verified
code, re-runnable by anyone against the chain, but no independent verifier exists to out-vote a bad
author. The read is **trust-minimized, not trustless**, until at least three independent producers each
run their own db-sync. That is a validator-decentralization step, separate from the observation
mechanism itself, which is complete and enforcing today.

## Key values and paths

- Pallet: `pallet-cardano-observer` @ index 16 (`pallets/cardano-observer/src/lib.rs`); inherent id
  `cgnoobsv`. Runtime **spec_version 204 / transaction_version 3**, genesis `0x73eaa4bf`.
- Read + reduction: `cogno-dbsync/` (`dbsync.rs` = SQL/IO, `reduction.rs` = pure reduction). The
  on-chain result is read back with `cogno-chain-cli query weight` (over RPC).
- Constants (`runtime/src/configs/mod.rs`): `MinLock = 100_000_000`; `MaxStakeWeight = MaxVotingPower =
  45×10¹⁵`; `StabilitySlots = 600` (testnet; mainnet 129,600); Shelley anchor `1655769600` / slot
  `86400`; `StakeEpochLookback = 1`; `MaxObserved = 4096`.
- Live vault policy / script hash: `168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7`
  (`contracts/vault.json`) — never move it.
- Identity keys: 32-byte beacon name = `AccountOf` key; 28-byte stake credential = `AccountOfStakeCred`
  key, both resolved from `pallet-cogno-gate`.
