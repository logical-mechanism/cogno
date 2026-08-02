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
lovelace)` set from `epoch_stake` — is the observation the node hands to the runtime as inherent data.

What goes into the BLOCK is the difference between that snapshot and what has already been applied. See
[Snapshot in, delta on the wire](#snapshot-in-delta-on-the-wire).

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

On import, `check_inherent` re-derives the delta from the importer's **own** read at the same reference,
against the same on-chain basis, and compares it to the author's. (Before spec 215 it compared the raw
observations; it has to compare the derived delta now, or nothing would establish that the author's page
was the one the rules produce.) It returns one of three outcomes (`InherentError`):

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

There is one further case, and it is not an `InherentError` at all: **the block that enacts a runtime
upgrade is accepted without being verified.** The author and the importer genuinely do not see the same
state there, and the asymmetry belongs to the SDK rather than to this pallet. The author builds through
`sc_block_builder::BlockBuilder`, which calls `Core::initialize_block` — and therefore
`on_runtime_upgrade` — and then runs `inherent_extrinsics` on that same runtime instance, so
`create_inherent` derives against **post-migration** state. The importer arrives through
`check_inherents_with_data(client, parent_hash, ..)`, whose runtime side is `data.check_extrinsics(&block)`
with no `initialize_block` anywhere, so it derives against the **raw parent** state.

That was invisible while verification was a data comparison. It matters now that the check re-derives from
storage: a migration that writes anything `derive_call` reads makes the two sides produce different deltas
for one block, and a difference is fatal — every importing node would reject the upgrade and the chain
would stop. Spec 215's own migration seeds the three bases the delta is taken against, so this was not
hypothetical.

`check_inherent` detects the case by comparing `System::LastRuntimeUpgrade` at the parent (still the
outgoing `spec_version`) against the running runtime's, which is exactly "this block runs
`on_runtime_upgrade`", and returns `Ok` for it. The exemption is one block wide, it costs no more than the
`CannotVerify` path already concedes, the Mandatory dispatchable's own enforcement still runs on every
node, and verification resumes at the next block. It also covers future migrations touching the resolver
maps (`AccountOf`, `AccountOfStakeCred`, `RoleCredIndex`), which the delta derivation reads too.

`check_inherent` is a network-edge gate — it is not re-run inside `execute_block` and is skipped on warp/
state sync. So anything that must hold on **every** node — reference monotonicity, the `MaxStakeWeight`
skip, account resolution, weight application, the explicit unlock — is enforced inside the Mandatory
`observe` dispatchable, which *does* run in `execute_block` and whose dispatch error invalidates the
block.

## Snapshot in, delta on the wire

The node reads the whole of Cardano's relevant state every block, exactly as described above, and hands
that full snapshot over as inherent *data*. What crosses into the block is the **difference** against
what the chain has already applied.

That split is possible because `create_inherent` runs **inside the runtime, against the parent block's
state** — the block builder executes `BlockBuilder::inherent_extrinsics` there. So it can compare the
node's snapshot against the on-chain basis (`LastObserved` / `LastObservedStake` / `LastObservedRoles`)
and emit only what moved. `check_inherent` runs against the *same* parent state on the import path, so
every importer re-derives the identical delta from its own read and compares. The two sides agree by
construction; no new runtime API and no node-side state access are involved.

A change is `(key, Some(value))` for a new or moved value and `(key, None)` for "no longer observed".
Absence from the delta means **unchanged**.

### Why this replaced a full snapshot per block

The observation used to be a full set in every block, bounded by a `MaxObserved` of 1024. That number
was documented as a size bound but behaved as a hard cap on how many accounts could hold posting power,
and crossing it was a cliff rather than a degradation: `create_inherent` did
`BoundedVec::try_from(..).ok()?`, so one entry over the bound dropped the *entire* inherent. Since this
pallet is the sole weight writer and the reference is a pure function of the parent block, that
abstention repeated every slot — the 1025th locker froze weight updates for the other 1024,
permanently, until somebody unlocked. `MaxObserved` is gone, and with it the cliff: nothing bounds how
many accounts can hold posting power.

One ceiling did survive, on a different axis and for a different reason. The vault set is discovered by
policy id and is genuinely unbounded, but the stake and role observations are *scoped* to credentials the
runtime enumerates, and those scans are capped at `MaxScanned` (1024) because `link_stake_signed` and
`claim_role_signed` are feeless bare-unsigned calls — an uncapped scan is a free way to grow every node's
per-block db-sync query until it blows its timeout. A credential past that cap is not scanned, so it is
not observed; and because the observer cannot tell "outside the scan" from "stake went to zero", it
zeroes that account rather than merely failing to credit it. That is a per-identity omission the node
alarms on (`ObserverScanCapped`), not the chain-wide freeze the old overrun caused, and the chain is
three orders of magnitude below it — but it is the number to size before the stake or role ledger grows.

### Paging and the backlog

`MaxChangesPerBlock` (256 per axis) bounds a block's **churn**, not its population. A larger change set
fills one page and records the remainder in `PendingChanges`; because each applied page advances the
basis the next block diffs against, the following block's delta *is* the remainder, and the queue
drains. Overrunning the bound costs latency, never correctness, and `create_inherent` can no longer
return `None` for a size reason at all.

While a backlog exists, `LastReference` is **held**. It advances only on a block that carried its whole
change set, so it reads as "Cardano observed *and applied* through here" rather than "the newest
reference some part of which landed". A backlogged block emits `ObservationBacklogged` carrying the
depth.

## Applying the observation

For each vault change, the `observe` dispatchable, atomically:

1. for `Some(lovelace)`, resolves `account = CognoGate::AccountOf[beacon]`; an unbound beacon is
   skipped, not an error (a bind must precede weight).
2. applies the `MinLock` floor (100,000,000 lovelace): below it, weight is 0.
3. **skips, never rejects, an over-cap entry.** If weight exceeds `MaxStakeWeight`, that one entry is
   dropped and counted — a single absurd value must not brick a Mandatory block. (This deliberately
   differs from the old `set_stake`, which rejected the whole call.)
4. sets weight via talk-stake's internal entry point and primes microblog capacity in the same write,
   preserving the going-forward-only / unlock→0 / never-delete-the-row invariants, and records the
   applied value in the basis the next diff reads.
5. for `None`, sets weight 0 and removes the basis row. The account comes from the **basis**, not from a
   fresh resolve: a beacon whose identity has since been revoked or rebound no longer resolves to the
   account holding the weight, and zeroing the wrong one would leave `AllowedStake` standing with no
   locked ADA behind it.

Steps 1–3 are also applied when the delta is *derived*, and an entry that would be skipped never enters
it. If it did, it would be emitted, skipped, left out of the basis, and emitted again next block — for
ever, holding a page slot a real change needed.

The voting-power half runs the same discipline over `epoch_stake` totals. There is no floor and no
largest-wins there — the node supplies one total per credential, read at `StakeEpochLookback` epochs
before the reference's epoch (a fully-closed, immutable snapshot).

The role half is the exception to per-key changes: its unit is a whole **account's** badge set. The
sink overwrites an account's set in one go, and an account can reach several badges through several
credentials (an mSPO's pools, plus a dRep tag). A per-credential delta could split one account across
two blocks, and the first block's overwrite would drop the badges the second was going to restore. So
the resolve-and-aggregate step happens during derivation and each change carries the account's complete
new set.

Each result is recorded in an `ObservationApplied` / `VotingPowerObserved` / `RolesObserved` event,
counted over the block's **changes** rather than over the whole observed population.

## Emergency freeze

`set_enforcement(false)` is **not** a cutover flip — it is an emergency weight-**freeze**. When frozen,
the inherent keeps verifying the read cross-node (`check_inherent` is flag-independent) but stops writing
`AllowedStake`/`VotingPower`, and the **basis is held along with the writes**, so the very same change
set is re-derived on every frozen block and lands intact on the first enforcing one. (Advancing the
basis while freezing the writes would record an unlock as applied without ever zeroing it.) This lets a determinism bug be halted before a bad observation corrupts
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
  `cgnoobsv`. Runtime **spec_version 216 / transaction_version 8**, genesis `0x73eaa4bf`.
- Read + reduction: `cogno-dbsync/` (`dbsync.rs` = SQL/IO, `reduction.rs` = pure reduction). The
  on-chain result is read back with `cogno-chain-cli query weight` (over RPC).
- Constants (`runtime/src/configs/mod.rs`): `MinLock = 100_000_000`; `MaxStakeWeight = MaxVotingPower =
  45×10¹⁵`; `StabilitySlots = 600` (testnet; mainnet 129,600); Shelley anchor `1655769600` / slot
  `86400`; `StakeEpochLookback = 1`; `MaxChangesPerBlock = 256`; `MaxRolesPerAccount = 32`;
  `MaxScanned = 1024`; `StallAfter = 50` blocks (5 min).
- Live vault policy / script hash: `168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7`
  (`contracts/vault.json`) — never move it.
- Identity keys: 32-byte beacon name = `AccountOf` key; 28-byte stake credential = `AccountOfStakeCred`
  key, both resolved from `pallet-cogno-gate`.
