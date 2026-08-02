//! # Cardano-observer pallet (cogno-chain) — in-protocol deterministic observation (D4 weight rung)
//!
//! **Sets `talk-stake` weight from a consensus-verified Substrate INHERENT** carrying the
//! deterministically-observed Cardano `talk_vault` state, replacing the trusted off-chain
//! `talk_stake.set_stake` write. Every importing validator independently re-derives the same Cardano
//! read and rejects the block on mismatch, so the locked-ADA weight becomes a consensus-verified
//! OUTPUT rather than a trusted oracle injection. Aura+GRANDPA are unchanged. Full design +
//! determinism contract: `docs/IN-PROTOCOL-OBSERVATION.md`.
//!
//! ## What is inherent data vs on-chain logic
//! The ONLY thing carried as inherent data is the raw observed `(beacon, lovelace)` set as-of a stable
//! reference slot (the node-side `InherentDataProvider` does that IO, byte-identically across nodes
//! via the shared `cogno-dbsync` reduction logic). Everything else is
//! deterministic on-chain logic that lives here: the `beacon → account` lookup
//! ([`Config::BeaconResolver`] = cogno-gate `AccountOf` in the runtime), the MIN_LOCK floor, the
//! `MaxStakeWeight` bound, weight application + capacity priming ([`Config::WeightSink`] = a
//! talk-stake + microblog adapter), and the delta against the previously-applied basis.
//!
//! ## Snapshot in, DELTA on the wire (spec 215)
//! The node still reads and supplies the FULL Cardano snapshot as inherent DATA, exactly as before.
//! What crosses into the block is the DIFFERENCE. [`ProvideInherent::create_inherent`] runs
//! **in-runtime against the parent block's state** (the block builder executes
//! `BlockBuilder::inherent_extrinsics` there), so it can diff the node's snapshot against the
//! previously-applied basis ([`LastObserved`] / [`LastObservedStake`] / [`LastObservedRoles`]) and
//! emit only what MOVED. [`ProvideInherent::check_inherent`] runs against the SAME parent state (the
//! import path calls `BlockBuilder::check_inherents` at the parent hash), so an importer re-derives
//! the identical delta from its own snapshot and byte-compares. Author and importer agree by
//! construction; no new runtime API and no node-side state access are involved.
//!
//! Two consequences that used to be the pallet's sharpest edge:
//!
//! - **Per-block cost is O(changes), not O(participants).** A quiet block carries an empty delta.
//! - **There is no population ceiling and no cliff.** A change set larger than
//!   [`Config::MaxChangesPerBlock`] fills one page, records the remainder in [`PendingChanges`], and
//!   DRAINS over the following blocks — the basis advances as each page applies, so the next block's
//!   diff is the remainder. `create_inherent` can no longer return `None` for a size reason, which is
//!   what used to freeze the sole weight writer chain-wide (see [`PendingChanges`]).
//!
//! Absence from `changes` now means UNCHANGED. An unlock is carried EXPLICITLY as
//! `(key, None)`, derived by the same diff (present in the basis, absent from the snapshot), so the
//! old second full-set clamp pass is gone.
//!
//! ## The two enforcement layers
//! - [`ProvideInherent::check_inherent`] does the CROSS-NODE read match only: the importer re-derives the
//!   delta from its OWN node's read at the same reference and compares it to the author's. When the derived
//!   vault `changes` differ, the carried `inputs_commitment` (a `blake2_256` of the pre-reduction candidate
//!   set — the partner-chains `selection_inputs_hash` analog) splits the failure: differing commitments ⇒
//!   [`InherentError::Mismatch`] ("saw different Cardano data"); identical commitments ⇒
//!   [`InherentError::ComputeDiverged`] ("same data, different derived output" — a determinism bug in the
//!   reduction OR in the diff, both of which are the pallet's own code). BOTH are
//!   **fatal** → block rejected; the split is diagnostic. The importer's own source being behind is
//!   [`InherentError::CannotVerify`] (**non-fatal** → accept without verifying — never fork on a slow
//!   node). `check_inherent` is NOT run by every node (warp/state sync skip it; it is not re-run in
//!   `execute_block`), so anything that must hold for EVERY node is enforced in the Mandatory
//!   dispatchable below, which DOES run in `execute_block`.
//! - The `observe` dispatchable is `DispatchClass::Mandatory` and `is_inherent`-only (pool-inadmissible,
//!   the mutual-exclusion invariant). It enforces, on every node: reference monotonicity, the
//!   stability sanity bound, the `MaxStakeWeight` skip-not-reject, account resolution, weight + capacity
//!   application, the explicit unlock, and the basis bookkeeping the next block's diff reads.
//!
//! ## Honest posture
//! `check_inherent`'s "every producer re-derives" is load-bearing only with MULTIPLE independent block
//! producers — on a single-operator stack this is **D4-SHAPED, not D4-TRUST** (it buys consensus-pinned
//! auditability, not trust). In the all-Rust restart this inherent is the **SOLE weight writer**:
//! `talk_stake::set_stake`/`set_voting_power` (the old trusted committee path) were DELETED, and
//! `EnforceWeight` defaults to **`true`** from genesis, so the verified observation writes `AllowedStake`/
//! `VotingPower` from block 0. [`Call::set_enforcement`]`(false)` is now an EMERGENCY GOVERNANCE REVERT
//! (freeze weight, keep verifying) rather than a shadow default — see [`EnforceWeight`]. The single-
//! operator honesty caveat is unchanged: enforcement being on is consensus-pinned auditability, and the
//! trustlessness graduates automatically as validators federate (≥3 independent producers).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;
pub mod migrations;
#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub mod weights;
pub use weights::*;

use codec::{Decode, DecodeWithMemTracking, Encode, MaxEncodedLen};
use frame_support::{
    traits::Get, BoundedVec, CloneNoBound, DebugNoBound, EqNoBound, PartialEqNoBound,
};
use scale_info::TypeInfo;
use sp_inherents::{InherentIdentifier, IsFatalError};
use sp_runtime::traits::{Saturating, Zero};

/// Off-chain node logs only (the on-chain audit trail is the `ObservationApplied` event).
pub const LOG_TARGET: &str = "runtime::cardano-observer";

/// How many of an account's [`Config::MaxRolesPerAccount`] slots are reserved for NON-SPO badges (dRep,
/// CC) when its role set does not fit. Mirrors the runtime `RoleApply` sink's own reserve, for the same
/// reason and at the same size — see `Pallet::bounded_roles`. "At most one of each" is what the reduction
/// emits today, but nothing in the type enforces that, so the reserve is capped rather than open-ended:
/// an uncapped non-SPO pass could fill every slot and starve the pools instead, which is the same bug
/// inverted.
pub const NON_SPO_RESERVE: usize = 4;

/// The 8-byte inherent identifier under which the node-side `InherentDataProvider` supplies the
/// observed Cardano vault state.
pub const INHERENT_IDENTIFIER: InherentIdentifier = *b"cgnoobsv";

/// A 32-byte beacon name == the L1 beacon `token_name` == the cogno-gate `AccountOf` key
/// (= `blake2b_256(plutus_data_cbor(owner Address))`; derived off-chain at bind, never re-derived here).
pub type BeaconName = [u8; 32];

/// A 28-byte Cardano STAKE credential == the cogno-gate `AccountOfStakeCred` key (the reward-address key
/// hash a voter proved via the stake-key CIP-8). The VOTING-POWER analog of [`BeaconName`]: the inherent
/// observes each BOUND stake credential's total Cardano stake (`epoch_stake`) and projects it to
/// talk-stake `VotingPower`, exactly as it observes vault lovelace → `AllowedStake`.
pub type StakeCredential = [u8; 28];

/// The stable Cardano reference the observation was taken as-of (carried in the inherent). The `slot`
/// is a deterministic function of the PARENT block (so author + importer agree) and is the as-of
/// reference. `block_hash` is the SEALED stable-block anchor: the header hash of the latest stable
/// Cardano block AT/UNDER `slot` — the partner-chains McHash anchor. The custom proposer seals it into the block
/// HEADER (the `cobs` PreRuntime digest, an external-auditability artifact), and
/// [`ProvideInherent::check_inherent`] now re-validates BOTH `slot` + `block_hash` + `entries` cross-node.
/// This is safe (it does NOT spuriously fork) because the anchor is the latest stable block ≤ `slot`,
/// resolved from Cardano db-sync as the single `block` row at `max(slot_no) <= slot` — db-sync's `block`
/// table holds EVERY block, so that row is UNIQUE and identical across every fully-synced db-sync (≤1
/// block/slot on settled history; the reference is ≥ the stability window old = immutable Cardano history).
/// An importer whose db-sync is BEHIND the reference abstains (→ `CannotVerify`) via the node-side
/// point-existence guard in the IDP, never reaching a FALSE mismatch here. (MAINNET
/// PREREQUISITE: db-sync must run full / non-pruned, retaining block history back to the reference.)
#[derive(
    Encode,
    Decode,
    DecodeWithMemTracking,
    Clone,
    PartialEq,
    Eq,
    Debug,
    TypeInfo,
    MaxEncodedLen,
    Default,
)]
pub struct CardanoRef {
    pub slot: u64,
    pub block_hash: [u8; 32],
}

/// The observation supplied as inherent DATA by the node: the FULL Cardano snapshot as-of `reference`,
/// in unbounded `Vec`s. It is NOT what goes into the block — [`ProvideInherent::create_inherent`] diffs
/// it against the on-chain basis and puts only the resulting bounded DELTA in the [`Call::observe`]
/// extrinsic. Nothing here is bounded, so no size of Cardano state can make the node fail to supply an
/// observation. Entries are canonical-sorted ascending by the 32 beacon bytes — the SAME canonical order
/// the `cogno-dbsync` reduction produces.
///
/// `inputs_commitment` is the `blake2_256` of the canonical SCALE encoding of the PRE-REDUCTION
/// structural candidate set (every vault UTxO the as-of reduction consumes, before the time-filter /
/// largest-wins fold) — the partner-chains `selection_inputs_hash` analog. It lets
/// [`ProvideInherent::check_inherent`] distinguish "the importer saw DIFFERENT Cardano data" (commitments
/// differ ⇒ [`InherentError::Mismatch`]) from "the importer COMPUTED a different reduced output from the
/// SAME data" (commitments agree but `entries` differ ⇒ [`InherentError::ComputeDiverged`], a determinism
/// bug / version skew) — where today both collapse to one `Mismatch`. The node computes it over its own
/// db-sync read (`inputs_commitment` in `node/src/cardano_observer.rs`); the runtime only COMPARES the
/// author's value (carried in the [`Call::observe`] extrinsic) against the importer's own — it never
/// re-derives it (no Cardano read in-runtime). It is only consulted when the reduced `entries` already disagree,
/// so it never causes a rejection on its own.
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct CardanoObservation {
    pub reference: CardanoRef,
    pub inputs_commitment: [u8; 32],
    pub entries: alloc::vec::Vec<(BeaconName, u128)>,
    /// The VOTING-POWER observation (spec 115): for every BOUND stake credential, its total Cardano stake
    /// (`epoch_stake` snapshot) at the deterministic as-of epoch, canonical-sorted ascending by the 28
    /// credential bytes. Unlike `entries` (a largest-wins reduction over a UTxO candidate set, hence the
    /// `inputs_commitment`), this is a DIRECT read of immutable per-epoch totals for an on-chain-known set,
    /// so there is no reduction to diverge — a cross-node difference is always a data `Mismatch`.
    pub stake_entries: alloc::vec::Vec<(StakeCredential, u128)>,
    /// The ROLE observation (spec 206): for every CLAIMED role credential that resolves to a currently-live
    /// Cardano role (an active pool via a Calidus registration, a bound stake key that owns a live pool, and
    /// — in later phases — a live dRep / seated CC member), a [`RoleEntry`] carrying the role source, the
    /// credential (which the runtime resolves to an account), and the display id. Canonical-sorted; like
    /// `stake_entries` it is a DIRECT read (the Calidus-witness verification is over immutable on-chain
    /// bytes), so a cross-node difference is always a data `Mismatch`, never a `ComputeDiverged`.
    pub role_entries: alloc::vec::Vec<RoleEntry>,
}

/// The inherent error. The node-side `try_handle_error` branches on this: `Mismatch` and
/// `ComputeDiverged` are propagated (`Some(Err(_))` → block rejected); `CannotVerify` is swallowed
/// (`Some(Ok(()))` → accept without verifying). A blanket-swallow would defeat the entire
/// fork-protection.
// Variant indices are ON-WIRE between the AUTHORING and IMPORTING node binaries (the encoded error
// crosses the inherent-data boundary), so they are pinned explicitly at their pre-pin ordinals —
// the encoding is byte-identical. Never renumber; append only.
#[derive(Encode, Decode, Debug)]
pub enum InherentError {
    /// The author's observation reflects DIFFERENT Cardano data than the importer's own read at the same
    /// reference (the reduced `entries` differ AND the input commitments differ). FATAL.
    #[codec(index = 0)]
    Mismatch,
    /// The importer's own Cardano data source is behind the reference / unavailable. NON-FATAL.
    #[codec(index = 1)]
    CannotVerify,
    /// The author and importer agree on the raw Cardano inputs (identical `inputs_commitment`) but the
    /// author's REDUCED `entries` differ from the importer's — i.e. the same data reduced to a different
    /// observed set. This is a determinism divergence in the shared reduction (a bug / a version skew
    /// between binaries), not a data disagreement. FATAL (a divergent reduction must not be consensus-
    /// pinned), but reported distinctly so operators can tell it apart from a genuine data fork.
    #[codec(index = 2)]
    ComputeDiverged,
}

impl IsFatalError for InherentError {
    fn is_fatal_error(&self) -> bool {
        match self {
            InherentError::Mismatch => true,
            InherentError::CannotVerify => false,
            InherentError::ComputeDiverged => true,
        }
    }
}

/// Resolve a 32-byte beacon to its bound posting account. Implemented by cogno-gate (`AccountOf`) in
/// the runtime; a fixture map in tests. Keeps this pallet decoupled from cogno-gate (no Cargo cycle).
pub trait BeaconResolver<AccountId> {
    fn resolve(beacon: &BeaconName) -> Option<AccountId>;
}

/// Apply an observed weight to an account: set talk-stake weight + prime/clamp the microblog capacity
/// row, via their existing internal entry points (preserving the going-forward-only / unlock→0 /
/// never-delete-the-row invariants; see docs/ECONOMICS.md). `weight == 0` is the unlock clamp. Implemented
/// by a talk-stake + microblog adapter in the runtime; a recorder in tests.
pub trait WeightSink<AccountId> {
    fn set_weight(who: &AccountId, weight: u128);
}

/// Resolve a 28-byte STAKE credential to its bound posting account. Implemented by cogno-gate
/// (`AccountOfStakeCred`) in the runtime; a fixture map in tests. The voting-power analog of
/// [`BeaconResolver`].
pub trait StakeResolver<AccountId> {
    fn resolve(stake_cred: &StakeCredential) -> Option<AccountId>;
}

/// Apply an observed VOTING POWER to an account (talk-stake `apply_voting_power` in the runtime; a
/// recorder in tests). The voting-power analog of [`WeightSink`]; `weight == 0` is the unlock clamp.
pub trait VotingPowerSink<AccountId> {
    fn set_voting_power(who: &AccountId, weight: u128);
}

/// The set of currently-bound stake credentials, exposed to the node-side IDP via [`CardanoObserverApi`]
/// so it knows WHICH credentials to read `epoch_stake` for (unlike vaults, which are discovered by a fixed
/// policy-id filter, a stake credential is votable only once bound on-chain). Implemented in the runtime by
/// enumerating cogno-gate `AccountOfStakeCred`.
pub trait BoundStakeCredentials {
    fn bound_stake_credentials() -> alloc::vec::Vec<StakeCredential>;
}

/// A 28-byte Cardano credential in the role axis (a claimed role-key hash, or an observer-resolved
/// display id such as a poolID). Same width as [`StakeCredential`]; named distinctly for the role code.
pub type RoleCredential = [u8; 28];

/// WHICH Cardano role a [`RoleEntry`] carries + HOW the runtime resolves its credential to an account.
/// On-wire in `role_entries` (the inherent), so `#[codec(index)]` PINS every discriminant — append only.
#[derive(
    Encode,
    Decode,
    DecodeWithMemTracking,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Debug,
    TypeInfo,
    MaxEncodedLen,
)]
pub enum RoleSource {
    /// SPO proven via a Calidus key: `credential` = the Calidus-key hash, resolved via the roles-pallet
    /// `RoleCredIndex[Spo]`; `id` = the specific live pool whose cold key authorized that Calidus key. An
    /// mSPO declaring one key from several pools yields ONE entry per pool (each cold-key-signed), so the
    /// chamber tally sums their delegated stake. Unlike `SpoOwner` it is CLAIM-backed (user-removable); a
    /// pool naming a key it doesn't co-own can only affect DISPLAY, never weight. See `reduce_role_observation`.
    #[codec(index = 0)]
    SpoCalidus,
    /// SPO via the FREE path: `credential` = a bound stake credential that owns a live pool (resolved via
    /// cogno-gate `AccountOfStakeCred`); `id` = the owned poolID. No cogno-chain claim needed.
    #[codec(index = 1)]
    SpoOwner,
    /// dRep: `credential` = the drep ID (= `id`), resolved via `RoleCredIndex[DRep]`.
    #[codec(index = 2)]
    DRep,
    /// Constitutional Committee: `credential` = the hot credential (= `id`), resolved via
    /// `RoleCredIndex[Committee]`.
    #[codec(index = 3)]
    Committee,
}

impl RoleSource {
    /// The OBSERVED role-kind index the sink writes (0 = SPO, 1 = dRep, 2 = CC) — both SPO sources
    /// collapse to SPO. Matches the roles pallet's `RoleKind` `#[codec(index)]` values.
    pub fn kind_index(&self) -> u8 {
        match self {
            RoleSource::SpoCalidus | RoleSource::SpoOwner => 0,
            RoleSource::DRep => 1,
            RoleSource::Committee => 2,
        }
    }
}

/// One observed live-role fact the node's reduction produces: a role `source` + the `credential` that
/// resolves it to an account + the `id` the profile badge displays + the `weight` a GOVERNANCE-POLL
/// chamber weights this role's vote by (spec 207). Canonical-sorted (by `source`, then `credential`, then
/// `id`, then `weight`) in the reduction, so the on-wire order is deterministic — a direct read (like
/// `stake_entries`), so a cross-node difference is always a data `Mismatch`, never a `ComputeDiverged`.
///
/// `weight` is the role's delegated Cardano stake at the as-of epoch: for `SpoOwner` / `SpoCalidus`, the
/// named pool's total delegated (block-production) stake; for `DRep`, the dRep's total delegated voting
/// stake; `0` for `Committee`. It is deterministic per `(source, id)` — the sums come from the same
/// reduction — so it never makes an otherwise-identical entry diverge across nodes.
#[derive(
    Encode,
    Decode,
    DecodeWithMemTracking,
    Clone,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Debug,
    TypeInfo,
    MaxEncodedLen,
)]
pub struct RoleEntry {
    pub source: RoleSource,
    pub credential: RoleCredential,
    pub id: RoleCredential,
    pub weight: u128,
}

/// One VAULT-axis change: `Some(weight)` sets a beacon's observed weight, `None` says the beacon is no
/// longer locked (the explicit unlock, which used to be inferred from absence in a full snapshot).
///
/// The weight is the EFFECTIVE one — [`Config::MinLock`] floor already applied — because the diff is
/// taken in the terms the apply step writes. An entry the apply step would SKIP (its beacon resolves to
/// no account, or its weight exceeds [`Config::MaxStakeWeight`]) is never emitted as a change at all, so
/// it can never occupy a page slot and starve real changes block after block.
pub type VaultChange = (BeaconName, Option<u128>);

/// One VOTING-POWER-axis change, the [`VaultChange`] analog: `Some(total)` sets a bound stake
/// credential's observed Cardano stake, `None` says it is no longer observed (unbound, or no stake).
pub type StakeChange = (StakeCredential, Option<u128>);

/// One ROLE-axis change, keyed by ACCOUNT rather than by credential.
///
/// The role sink ([`RoleSink::set_roles`]) is a whole-set OVERWRITE of one account's badges, and an
/// account can hold several roles reached through several credentials (an mSPO's pools, plus a dRep
/// badge). A per-CREDENTIAL delta could therefore split one account's set across two blocks, and the
/// first block's overwrite would drop the badges the second block was going to restore. So the diff is
/// taken over the AGGREGATED per-account sets — the same aggregation the apply step used to do inline —
/// and each change carries the account's COMPLETE new set. `None` clears every role (the account dropped
/// out of the observation entirely).
///
/// Keying by account is also what makes a lapsed CLAIM clear correctly: the account comes from the diff
/// against the basis, not from re-resolving a credential that may no longer resolve to anything.
// The `*NoBound` derives are load-bearing, not stylistic: `MaxRoles` is a `Get<u32>` witness type that
// appears only inside the `BoundedVec`, and the std derives would demand `MaxRoles: Clone + Debug + Eq`
// of it — which `ConstU32<N>` does not satisfy. `skip_type_params` does the same for `TypeInfo`.
#[derive(
    Encode,
    Decode,
    DecodeWithMemTracking,
    CloneNoBound,
    PartialEqNoBound,
    EqNoBound,
    DebugNoBound,
    TypeInfo,
    MaxEncodedLen,
)]
#[scale_info(skip_type_params(MaxRoles))]
pub struct RoleChange<AccountId, MaxRoles>
where
    AccountId: Clone + Eq + core::fmt::Debug,
    MaxRoles: Get<u32>,
{
    /// The account whose observed-role set changed.
    pub who: AccountId,
    /// The account's complete new set as `(role_kind_index, display_id, chamber_weight)`, or `None` to
    /// clear every role.
    pub roles: Option<BoundedVec<(u8, RoleCredential, u128), MaxRoles>>,
}

/// Resolve a role credential to its bound account, via the reverse map named by `source`. Implemented in
/// the runtime (roles-pallet `RoleCredIndex` + cogno-gate `AccountOfStakeCred` for the free path); a
/// fixture map in tests. The role analog of [`StakeResolver`], but source-tagged.
pub trait RoleResolver<AccountId> {
    fn resolve(source: RoleSource, credential: &RoleCredential) -> Option<AccountId>;
}

/// Overwrite `who`'s full observed-role set (each `(role_kind_index, display_id, chamber_weight)`), or
/// CLEAR it when the slice is empty (the unlock clamp). `chamber_weight` (spec 207) is the role's
/// delegated Cardano stake for governance-poll chambers — a pool's delegated stake for BOTH SPO sources,
/// a dRep's delegated voting stake, 0 for a CC badge or a pool with no delegators. Implemented by a
/// roles-pallet adapter in the runtime (`apply_roles`); a recorder in tests. The role analog of
/// [`VotingPowerSink`], but set-valued.
pub trait RoleSink<AccountId> {
    fn set_roles(who: &AccountId, roles: &[(u8, RoleCredential, u128)]);
}

/// The claimed role credentials the node-side IDP scopes its db-sync role read to (so it reads only for
/// cogno-chain claimants, not all Cardano pools/dReps). Exposed via [`CardanoObserverApi`]. The
/// `SpoOwner` free path reuses [`BoundStakeCredentials`], so this returns only the CLAIM-based
/// credentials. Implemented in the runtime by enumerating the roles-pallet `RoleCredIndex`.
pub trait BoundRoleCredentials {
    /// The claimed Calidus-key hashes (`RoleCredIndex[Spo]` keys) — the SPO/Calidus scoping set.
    fn claimed_calidus() -> alloc::vec::Vec<RoleCredential>;
    /// The claimed dRep IDs (`RoleCredIndex[DRep]` keys) — the dRep scoping set (Phase B).
    fn claimed_dreps() -> alloc::vec::Vec<RoleCredential>;
    /// The claimed committee hot credentials (`RoleCredIndex[Committee]` keys) — the CC scoping set (Phase C).
    fn claimed_committee() -> alloc::vec::Vec<RoleCredential>;
}

/// Benchmark-only setup seam. This pallet is deliberately decoupled from cogno-gate / talk-stake /
/// microblog by the resolver + sink traits above (no Cargo cycle), so `observe`'s benchmark cannot bind a
/// beacon or seed a weight by itself — the runtime implements this to write those collaborators' rows
/// directly. Same pattern as microblog's `IsAllowed::benchmark_set_allowed`; the production `Config` is
/// untouched (the associated type exists only under `runtime-benchmarks`).
///
/// The seeded state must drive `observe` down its EXPENSIVE branch: a bound account whose CURRENT weight
/// DIFFERS from the observed one, so the runtime sink's `previous != weight` guard takes the write path.
/// Seeding a matching weight would benchmark the no-op fast path and under-weight the Mandatory inherent.
#[cfg(feature = "runtime-benchmarks")]
pub trait BenchmarkSetup<AccountId> {
    /// Bind `beacon` to [`BenchmarkSetup::bench_account`]`(i)` and seed that account's vault-weight state.
    fn bench_bind_beacon(beacon: &BeaconName, i: u32);
    /// Bind `cred` to [`BenchmarkSetup::bench_account`]`(i)` and seed that account's voting-power state.
    fn bench_bind_stake_cred(cred: &StakeCredential, i: u32);
    /// The benchmark account for index `i`. Must be injective: the credit loops and the unlock-clamp bases
    /// are seeded from disjoint index ranges precisely so they resolve to disjoint accounts.
    fn bench_account(i: u32) -> AccountId;
}

/// The consensus-pinned observation config the node-side `InherentDataProvider` reads via the
/// [`CardanoObserverApi`] runtime API — the SINGLE source of truth, so the node and the runtime cannot
/// drift on the anchors, the stability window, or which Cardano policy to observe (design "no-drift").
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct ObserverConfig {
    pub shelley_start_unix: u64,
    pub shelley_start_slot: u64,
    pub stability_slots: u64,
    /// The 28-byte Cardano policy id (== the `talk_vault` script hash, `contracts/vault.json`) the node
    /// reads db-sync for (the vault script address `payment_cred` / beacon `multi_asset.policy`).
    /// Consensus-pinned so a misconfigured node can't silently observe the wrong policy.
    pub vault_policy_id: alloc::vec::Vec<u8>,
    /// How many epochs BEFORE the reference slot's epoch to read `epoch_stake` at (the voting-power
    /// observation). Consensus-pinned so every node reads the SAME epoch. A lookback ≥ 1 reads a
    /// fully-closed (immutable) snapshot and gives the ~2-epoch manipulation-resistant lag Cardano itself
    /// uses for leader election (CIP-1694 voting power); the node resolves the reference slot's epoch from
    /// db-sync's `block.epoch_no` (network-agnostic — no slots-per-epoch arithmetic) and subtracts this.
    pub stake_epoch_lookback: u64,
    /// The [`Config::MaxScanned`] cap, surfaced to the node so it can ALARM as the scanned credential sets
    /// approach it. Single source of truth (node + runtime read the same value), so a monitoring rule can
    /// key off it without a hard-coded duplicate.
    ///
    /// ⚠ Its meaning changed in spec 215 and the alarm changed with it. It is no longer a ceiling on the
    /// observation — nothing bounds that now, and overrunning it is no longer a chain-wide weight freeze.
    /// It caps the two per-block credential SCANS that scope the db-sync query, so it remains a real
    /// ceiling on the STAKE and ROLE axes: a credential past the cap is not scanned, so it is not
    /// observed. The vault axis is discovered by policy id and has no cap at all.
    pub max_scanned: u32,
}

sp_api::decl_runtime_apis! {
    /// Exposes the consensus-pinned [`ObserverConfig`] to the node-side observation InherentDataProvider.
    pub trait CardanoObserverApi {
        /// The current observation config (anchors, stability window, vault policy id, stake epoch lookback).
        fn observer_config() -> ObserverConfig;
        /// The set of currently-bound stake credentials (cogno-gate `AccountOfStakeCred` keys) — the
        /// credentials the node must read `epoch_stake` for, evaluated at the parent block's state.
        fn bound_stake_credentials() -> alloc::vec::Vec<StakeCredential>;
        /// The claimed role credentials (roles-pallet `RoleCredIndex` keys) — the set the node scopes its
        /// db-sync ROLE read to, evaluated at the parent block's state. Returns the three per-role vectors
        /// `(claimed_calidus, claimed_dreps, claimed_committee)`; the SPO/owner free path reuses
        /// [`Self::bound_stake_credentials`].
        fn bound_role_credentials() -> (
            alloc::vec::Vec<RoleCredential>,
            alloc::vec::Vec<RoleCredential>,
            alloc::vec::Vec<RoleCredential>,
        );
    }
}

#[frame_support::pallet]
pub mod pallet {
    use super::*;
    use frame_support::{
        inherent::{InherentData, ProvideInherent},
        pallet_prelude::*,
        traits::UnixTime,
    };
    use frame_system::{ensure_none, pallet_prelude::*};

    /// Storage version 1 (spec 215): the three `LastObserved*` clamp bases moved from
    /// `StorageValue<BoundedVec<_, MaxObserved>>` blobs to StorageMaps, which is what removes the
    /// population ceiling. Version 0 is the implicit pre-migration state — the pallet never declared a
    /// version before, so `on_chain_version` reads 0 on the live chain and
    /// `migrations::v1::MigrateV0ToV1` runs exactly once. See that module.
    pub const STORAGE_VERSION: StorageVersion = StorageVersion::new(1);

    #[pallet::pallet]
    #[pallet::storage_version(STORAGE_VERSION)]
    pub struct Pallet<T>(_);

    #[pallet::config]
    pub trait Config: frame_system::Config {
        /// The overarching runtime event type.
        #[allow(deprecated)]
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
        /// Max CHANGES carried in one block, per axis. A CHURN bound — a batch size, explicitly NOT a
        /// population bound. Nothing caps how many identities may hold weight.
        ///
        /// A change set larger than this fills one page; the rest is recorded in [`PendingChanges`] and
        /// drains over the following blocks, because each applied page advances the basis the next
        /// block's diff is taken against. The worst case a block can carry is `3 ×` this (the three
        /// axes), which is what [`Config::WeightInfo::observe`] is benchmarked over.
        ///
        /// ⚠ This is the bound whose OVERRUN used to be a cliff. It no longer is: overrunning it costs
        /// LATENCY (the tail lands a block or more later), never a dropped inherent and never a frozen
        /// weight writer. Sizing it is a block-budget question, nothing more.
        #[pallet::constant]
        type MaxChangesPerBlock: Get<u32>;
        /// Max observed roles recorded for ONE account — a per-ACCOUNT bound (how many badges one
        /// identity can hold at once: an mSPO's pools plus a dRep and a CC badge), never a population
        /// bound. Bounds [`RoleChange::roles`] and the [`LastObservedRoles`] value. A set longer than
        /// this is truncated deterministically, exactly as the runtime's own `RoleSink` already
        /// truncates to its stored set's bound.
        #[pallet::constant]
        type MaxRolesPerAccount: Get<u32>;
        /// The cap on the per-block credential SCANS that scope the node's db-sync query, and on the
        /// read-side observed-account joins ([`ObserverConfig::max_scanned`], surfaced to the node).
        ///
        /// ⚠ NOT a bound on the observation — since spec 215 nothing bounds that. This exists for a
        /// different reason that is unchanged: `link_stake_signed` / `claim_role_signed` are feeless
        /// bare-unsigned calls, so an unbounded scan of the maps they grow is a free way to enlarge every
        /// node's per-block work until the db-sync query blows its timeout. Capping the SCAN is what stops
        /// that. It also bounds the on-chain poll-tally join (`pallet_microblog::Config::MaxObservedAccounts`
        /// is wired to it), which is what lets `close_poll` declare a finite worst case.
        #[pallet::constant]
        type MaxScanned: Get<u32>;
        /// Blocks without an APPLIED observation before the on-chain stall alarm latches ([`Stalled`]).
        /// The node authors the inherent every block, so a gap this long means the sole weight writer has
        /// stopped: db-sync is down or behind, or the node's own read is failing. A large change set is
        /// NOT a stall — a draining backlog still applies a page every block and still stamps the clock.
        #[pallet::constant]
        type StallAfter: Get<BlockNumberFor<Self>>;
        /// Hard ceiling on a single account's weight (`stake-1`). An entry above it is SKIPPED (not a
        /// block error) — a bad inherent value must never be consensus-pinned nor brick the Mandatory
        /// block. (Contrast `talk_stake::set_stake`, which rejects the whole call.)
        #[pallet::constant]
        type MaxStakeWeight: Get<u128>;
        /// The L1 `min_lock` floor (lovelace): below it, observed lovelace maps to weight 0.
        #[pallet::constant]
        type MinLock: Get<u128>;
        /// The stability window in Cardano slots (the reference must be at least this far behind the
        /// block's own time — a defence-in-depth sanity bound; the node IDP enforces the real read).
        #[pallet::constant]
        type StabilitySlots: Get<u64>;
        /// Per-network Shelley anchor (NOT Byron `systemStart`) for the stability sanity bound.
        #[pallet::constant]
        type ShelleyStartUnix: Get<u64>;
        #[pallet::constant]
        type ShelleyStartSlot: Get<u64>;
        /// The 28-byte Cardano policy id (== `talk_vault` script hash) to observe. Consensus-pinned and
        /// surfaced to the node via [`CardanoObserverApi`] so every node queries the SAME policy.
        #[pallet::constant]
        type VaultPolicyId: Get<[u8; 28]>;
        /// Hard ceiling on a single account's VOTING POWER (total observed Cardano stake). An entry above it
        /// is SKIPPED (not a block error), exactly like [`Config::MaxStakeWeight`] for vault weight.
        #[pallet::constant]
        type MaxVotingPower: Get<u128>;
        /// How many epochs before the reference's epoch to read `epoch_stake` at (the voting-power lag).
        /// Consensus-pinned and surfaced to the node via [`CardanoObserverApi`].
        #[pallet::constant]
        type StakeEpochLookback: Get<u64>;
        /// Beacon → bound account (cogno-gate `AccountOf` in the runtime).
        type BeaconResolver: BeaconResolver<Self::AccountId>;
        /// Stake credential → bound account (cogno-gate `AccountOfStakeCred` in the runtime).
        type StakeResolver: StakeResolver<Self::AccountId>;
        /// Apply weight + capacity (talk-stake + microblog adapter in the runtime).
        type WeightSink: WeightSink<Self::AccountId>;
        /// Apply voting power (talk-stake `apply_voting_power` adapter in the runtime).
        type VotingPowerSink: VotingPowerSink<Self::AccountId>;
        /// Role credential → bound account, source-tagged (roles-pallet `RoleCredIndex` + cogno-gate
        /// `AccountOfStakeCred` for the free path, in the runtime).
        type RoleResolver: RoleResolver<Self::AccountId>;
        /// Apply an account's full observed-role set (roles-pallet `apply_roles` adapter in the runtime).
        type RoleSink: RoleSink<Self::AccountId>;
        /// Origin allowed to flip the enforce flag ([`Call::set_enforcement`]) — the emergency weight-freeze
        /// control. In the runtime this is `AuthorityOrigin` (the 3-of-5 FollowerCommittee; sudo-free), the
        /// same origin that gates identity `revoke`, validator add/remove, and `authorize_upgrade`.
        type EnforceOrigin: EnsureOrigin<Self::RuntimeOrigin>;
        /// The block's consensus time (`pallet_timestamp` implements `UnixTime`).
        type UnixTime: UnixTime;
        /// Dispatch weights.
        type WeightInfo: WeightInfo;
        /// Benchmark-only: seed the cogno-gate / talk-stake / microblog rows `observe`'s worst case needs
        /// (the pallet cannot reach those through its production seams). Not part of the production Config.
        #[cfg(feature = "runtime-benchmarks")]
        type BenchmarkSetup: BenchmarkSetup<Self::AccountId>;
    }

    /// The last FULLY-APPLIED Cardano reference — the monotonicity anchor. `None` before the first
    /// observation.
    ///
    /// "Fully applied" is load-bearing: it advances only on a block that carried its whole change set
    /// ([`PendingChanges`] is `0`). A block that fills a page and defers the rest holds it where it is, so
    /// the frontier never reads as "Cardano observed through here" while part of that reference is still
    /// queued. Readers treat it as a conservative lower bound on what has landed — see
    /// `estimateLockSlot` in the app, which turns it into a lock-credit ETA.
    #[pallet::storage]
    pub type LastReference<T: Config> = StorageValue<_, CardanoRef, OptionQuery>;

    /// The APPLIED vault basis: `beacon → (account, weight)` for everything the observer has actually
    /// written. This is what [`ProvideInherent::create_inherent`] diffs the node's snapshot against, and
    /// it is a StorageMap precisely so that nothing about its SIZE can fail: the old
    /// `StorageValue<BoundedVec<_, MaxObserved>>` was read and re-encoded whole every block and could not
    /// hold more than `MaxObserved` rows at all.
    ///
    /// Two properties the rest of the pallet leans on:
    ///
    /// - It records the ACCOUNT, so an unlock can be applied to the right account even after the
    ///   identity binding is gone (a revoked beacon no longer resolves, but its row still knows whom to
    ///   zero).
    /// - It records only what was APPLIED. An entry the apply step skipped is absent, so the next
    ///   block's diff naturally re-derives it — the basis can never claim credit for a write that did
    ///   not happen.
    #[pallet::storage]
    pub type LastObserved<T: Config> =
        StorageMap<_, Blake2_128Concat, BeaconName, (T::AccountId, u128), OptionQuery>;

    /// Whether the verified observation's weight is APPLIED to talk-stake/microblog. **DEFAULT: `true`** —
    /// the observer is the SOLE weight writer from genesis (there is no committee `set_stake` fallback; that
    /// path was deleted in the all-Rust restart). [`Call::set_enforcement`]`(false)` is the EMERGENCY
    /// GOVERNANCE REVERT (gated by [`Config::EnforceOrigin`] = the 3-of-5 committee): it FREEZES weight —
    /// the inherent still verifies the read cross-node ([`ProvideInherent::check_inherent`] is
    /// flag-INDEPENDENT) but stops writing `AllowedStake`/`VotingPower`, so a determinism bug can be halted
    /// before a bad observation corrupts weight, then fixed via a committee-governed runtime upgrade. In the
    /// frozen state weight simply holds at its last values. ⚠ On a single-operator stack the "every
    /// producer re-derives" property is still D4-SHAPED, not D4-TRUST — enforcement being on buys
    /// consensus-pinned auditability, not trust, until ≥3 independent producers exist.
    #[pallet::type_value]
    pub fn DefaultEnforce<T: Config>() -> bool {
        true
    }
    #[pallet::storage]
    pub type EnforceWeight<T: Config> = StorageValue<_, bool, ValueQuery, DefaultEnforce<T>>;

    /// The APPLIED voting-power basis: `stake_credential → (account, total)`, mirroring [`LastObserved`]
    /// for the vault axis and diffed the same way.
    #[pallet::storage]
    pub type LastObservedStake<T: Config> =
        StorageMap<_, Blake2_128Concat, StakeCredential, (T::AccountId, u128), OptionQuery>;

    /// The APPLIED role basis: `account → its full observed-role set`. Keyed by ACCOUNT rather than by
    /// credential because [`RoleSink::set_roles`] is a whole-set overwrite — see [`RoleChange`] for why a
    /// per-credential delta would drop badges. The stored value is exactly what was last handed to the
    /// sink, so the diff compares like with like.
    #[pallet::storage]
    pub type LastObservedRoles<T: Config> = StorageMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        BoundedVec<(u8, RoleCredential, u128), T::MaxRolesPerAccount>,
        OptionQuery,
    >;

    /// How many changes the last observation could NOT fit in its block, summed across the three axes —
    /// the backlog depth. `0` is the normal state.
    ///
    /// This is the generalization of the latched [`Stalled`] alarm to a graded signal. It exists because
    /// the failure it replaces was invisible: an observation over the old `MaxObserved` made
    /// `create_inherent` return `None`, which dropped the WHOLE inherent and froze the sole weight writer
    /// chain-wide until someone unlocked. There is no such state any more — a surplus is a page of work
    /// deferred to the next block, not a dropped inherent — but a backlog that never drains still means
    /// churn is outrunning [`Config::MaxChangesPerBlock`], and that is worth seeing on-chain rather than
    /// inferring from a node log.
    ///
    /// It is carried in the [`Call::observe`] extrinsic (so `check_inherent` verifies it cross-node like
    /// everything else) rather than recomputed here, and it gates [`LastReference`]: the reference
    /// advances only on a block that drained, so `LastReference` never claims a reference was applied in
    /// full when part of it is still queued.
    #[pallet::storage]
    pub type PendingChanges<T: Config> = StorageValue<_, u32, ValueQuery>;

    /// The block in which the last observation was APPLIED — the stall alarm's clock. `0` means "none
    /// yet": block 0 is genesis and carries no extrinsics, so a real observation can never stamp it. The
    /// `on_initialize` hook re-anchors a zero clock to the CURRENT block rather than measuring from block
    /// 0, so a chain upgraded into this alarm does not read its whole history as one long stall.
    #[pallet::storage]
    pub type LastAppliedAt<T: Config> = StorageValue<_, BlockNumberFor<T>, ValueQuery>;

    /// The latched stall alarm: `true` once the observer has gone [`Config::StallAfter`] blocks without
    /// applying an observation; cleared by the next accepted `observe`. LATCHED, not recomputed, so
    /// [`Event::ObservationStalled`] fires exactly ONCE per episode rather than every block. It ARMS only
    /// after the chain's first-ever accepted observation ([`LastReference`] is `Some`) — a chain that never
    /// started is not a chain that stopped.
    ///
    /// This is the on-chain signal that the sole weight writer has stopped ENTIRELY — no observation is
    /// landing at all, because the node's Cardano read is down or behind. It no longer has a size-related
    /// cause: since spec 215 an oversized change set drains rather than dropping the inherent, and a
    /// draining block IS an applied observation, so it stamps the clock and keeps this quiet. A backlog is
    /// reported by [`PendingChanges`] instead, which is graded rather than binary.
    #[pallet::storage]
    pub type Stalled<T: Config> = StorageValue<_, bool, ValueQuery>;

    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    // Variant indices are ON-WIRE (every client that decodes an event keys off them). SCALE derives them
    // from declaration order, so they are pinned explicitly here: the two variants appended below cannot
    // shift 0/1/2, and a future reorder is a compile-visible decision rather than a silent break.
    pub enum Event<T: Config> {
        /// A verified observation was processed as-of `reference_slot`. Since spec 215 the counts are over
        /// the block's CHANGES, not over the whole observed population: `credited` beacons had a new
        /// weight applied, `cleared` were explicitly unlocked (`None`) and zeroed, `skipped` were carried
        /// but dropped by the `MaxStakeWeight` bound or an unresolvable beacon. A quiet block reports
        /// zeroes, which now means "nothing moved" rather than "nothing is locked". `enforced` is the
        /// mode: `true` (the default) means weight was APPLIED to `AllowedStake`/capacity; `false` means
        /// frozen (emergency revert: verified but not applied), so `credited`/`cleared` count what WOULD
        /// have been applied.
        #[codec(index = 0)]
        ObservationApplied {
            reference_slot: u64,
            credited: u32,
            cleared: u32,
            skipped: u32,
            enforced: bool,
        },
        /// The VOTING-POWER half of the same verified observation, counted over CHANGES exactly as
        /// `ObservationApplied` is: `credited` stake credentials had a new voting power applied, `cleared`
        /// were explicitly dropped and zeroed, `skipped` exceeded `MaxVotingPower` or resolved to no
        /// account. `enforced` mirrors `ObservationApplied`: `true` means applied to talk-stake
        /// `VotingPower`; `false` means frozen (not applied).
        #[codec(index = 1)]
        VotingPowerObserved {
            reference_slot: u64,
            credited: u32,
            cleared: u32,
            skipped: u32,
            enforced: bool,
        },
        /// The enforce flag was set via [`Call::set_enforcement`]. `enabled = true` (the default) means the
        /// verified inherent APPLIES weight; `false` means frozen (emergency revert: verify but don't write).
        #[codec(index = 2)]
        EnforcementSet { enabled: bool },
        /// No observation has been applied for more than [`Config::StallAfter`] blocks — the SOLE weight
        /// writer has stopped, because the node's Cardano read is unavailable or behind. (A large change
        /// set is NOT a cause: it drains a page per block, and each of those blocks is an applied
        /// observation.) Latched via [`Stalled`], so it fires ONCE per episode. `last_applied` is the block
        /// the last observation landed in; `blocks` is how long the gap had run when the alarm latched.
        #[codec(index = 3)]
        ObservationStalled {
            last_applied: BlockNumberFor<T>,
            blocks: BlockNumberFor<T>,
        },
        /// An observation was applied again after a latched stall, clearing [`Stalled`]. `blocks` is the
        /// total length of the gap.
        #[codec(index = 4)]
        ObservationResumed { blocks: BlockNumberFor<T> },
        /// The ROLE half of the same verified observation (spec 206), counted over CHANGES: `credited`
        /// accounts had a new role set written, `cleared` accounts had all roles cleared (a pool retired /
        /// a claim was unclaimed or revoked). `enforced` mirrors the other two: `true` means written to
        /// `ObservedRoles`; `false` means frozen (verified but not applied). Per-account role events are
        /// emitted by the roles pallet's `apply_roles`; this is the aggregate for the observation.
        #[codec(index = 5)]
        RolesObserved {
            reference_slot: u64,
            credited: u32,
            cleared: u32,
            enforced: bool,
        },
        /// The observation's change set did not fit in one block: this block carried a full page on at
        /// least one axis and `pending` changes are deferred to the following blocks (summed across the
        /// three axes). [`LastReference`] is HELD at its previous value until the backlog drains, so the
        /// frontier never claims a reference landed in full.
        ///
        /// This is a latency signal, not a fault: the basis advances as each page applies, so the next
        /// block's diff is the remainder and the queue strictly shrinks under any churn rate the chain can
        /// actually sustain. It fires on every backlogged block (not latched like
        /// [`Event::ObservationStalled`]) because `pending` is a depth that is worth watching move.
        #[codec(index = 6)]
        ObservationBacklogged { reference_slot: u64, pending: u32 },
    }

    // Variant indices are ON-WIRE (the index IS the wire format of a `DispatchError::Module`), so
    // they are pinned explicitly at their pre-pin ordinals — the encoding is byte-identical. Never
    // renumber; a new variant takes the next free index (2). (The Event enum above is pinned the
    // same way.)
    //
    // ⚠ NEITHER VARIANT IS RETURNED ANY MORE, and neither may be. `observe` is the pallet's only
    // dispatchable and it is `DispatchClass::Mandatory`: an `Err` from a Mandatory dispatch is
    // `BadMandatory`, which discards the whole BLOCK, and because the reference is a pure function of
    // the PARENT's slot the same failure then repeats every slot forever. Both bounds are therefore
    // enforced as SKIP-not-reject inside `observe`, leaving that dispatch INFALLIBLE by construction
    // (`grep 'Error::<T>::' ` in this file returns nothing — keep it that way). The variants stay
    // declared because a retired variant would leave a permanent gap in an on-wire enum and buys
    // nothing; treat them as reserved.
    #[pallet::error]
    pub enum Error<T> {
        /// The proposed reference is older than the last accepted one (anti-regression). A
        /// malicious author cannot rewind observed Cardano state.
        #[codec(index = 0)]
        ReferenceRegressed,
        /// The proposed reference is fresher than the stability window allows (closer to the block's own
        /// time than `StabilitySlots`) — i.e. it reads history that could still roll back.
        #[codec(index = 1)]
        ReferenceTooFresh,
    }

    #[pallet::hooks]
    impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
        /// Latch the on-chain stall alarm ([`Stalled`]) when no observation has been applied for
        /// [`Config::StallAfter`] blocks. Runs BEFORE this block's inherents, so an observation landing in
        /// THIS block clears the latch again inside `observe`: the alarm can only fire on a gap that is
        /// already over the threshold at the start of the block.
        ///
        /// Deliberately OUTSIDE the consensus path — `create_inherent` / `check_inherent` are untouched. A
        /// predicate added there could reject every imported block, turning a stalled Cardano READ into a
        /// stalled CHAIN. This records THAT weight stopped, durably and alertably; the node's `log::error!`
        /// still says WHY.
        ///
        /// The alarm reports that observation STOPPED, which means it can only arm on a chain where it ever
        /// STARTED — see the [`LastReference`] guard below.
        ///
        /// The weight is stated directly rather than benchmarked: the hook is one comparison plus, at
        /// worst, three reads / one write / one event, and `DbWeight` prices exactly that. The common path
        /// (an observation applied last block) is a single read.
        fn on_initialize(now: BlockNumberFor<T>) -> Weight {
            let last = LastAppliedAt::<T>::get();
            if last.is_zero() {
                // Nothing applied since this alarm came into existence: a fresh chain, or the first block
                // of the runtime that introduced it. Anchor the window HERE — measuring from block 0 would
                // read an upgraded chain's whole history as one enormous stall and fire a false alarm.
                LastAppliedAt::<T>::put(now);
                return T::DbWeight::get().reads_writes(1, 1);
            }
            let blocks = now.saturating_sub(last);
            if blocks <= T::StallAfter::get() {
                return T::DbWeight::get().reads(1);
            }
            if Stalled::<T>::get() {
                // Already latched: once per episode, not once per block.
                return T::DbWeight::get().reads(2);
            }
            // A chain that has never applied a SINGLE observation is not stalled — it never started, and
            // "the sole weight writer has STOPPED" is a false statement about it. `--dev` is exactly this
            // chain: it has no db-sync, so the node's IDP returns no data, `create_inherent` abstains on
            // every block, and `LastAppliedAt` never moves past the anchor above. Without this guard every
            // dev run latches the alarm ~5 minutes in and logs a chain-is-broken ERROR that is pure noise,
            // and every dev chain carries `Stalled = true` in state forever. A real chain arms the alarm
            // the moment it has anything to lose — and a production chain whose observer never worked from
            // genesis has zero weight for everybody (nobody can post at all), which needs no alarm.
            //
            // ⚠ `LastReference` alone is NO LONGER that test. It used to be `Some` from the first accepted
            // observation onward, but since spec 215 it advances only on a FULLY DRAINED block. A chain
            // whose first observation is backlogged — the ordinary bootstrap, and precisely the case where
            // a stall would matter most — has applied real work, has a real growing gap, and still reads
            // `None` here. On that chain the old guard disarmed the alarm for as long as the backlog ran.
            // `PendingChanges` is non-zero exactly in that window, so the two together mean "has ever
            // applied anything", which is what this guard was always trying to ask.
            if LastReference::<T>::get().is_none() && PendingChanges::<T>::get() == 0 {
                return T::DbWeight::get().reads(4);
            }
            Stalled::<T>::put(true);
            log::error!(
                target: LOG_TARGET,
                "OBSERVATION STALLED: no observation applied for {blocks:?} blocks (last at {last:?}) — the SOLE weight writer has stopped. The node's Cardano read is unavailable or behind; a large change set cannot cause this (it drains a page per block and each of those blocks applies)",
            );
            Self::deposit_event(Event::ObservationStalled {
                last_applied: last,
                blocks,
            });
            T::DbWeight::get().reads_writes(3, 2)
        }

        /// Invariants that hold on every block, checked under `try-runtime` against a snapshot of REAL
        /// state (docs/UPGRADES.md's pre-enactment dry-run) — the only place they can be checked before
        /// they are on-chain.
        ///
        /// The three bases are StorageMaps now, so the old check is gone with the failure mode it guarded:
        /// lowering a bound could shorten a `BoundedVec` past its stored length, and `ValueQuery` answered
        /// the resulting decode failure with an EMPTY basis, silently stranding the weight of every account
        /// that had since unlocked. A map has no length prefix to overrun, and every row decodes on its
        /// own. What replaces it is the invariant the delta design actually rests on:
        ///
        /// - **A backlog can only exist on a chain that has applied an observation.** [`PendingChanges`] is
        ///   written by nothing but an applied `observe`, which also stamps [`LastAppliedAt`].
        /// - **Every role basis row is within its per-account bound**, i.e. the stored set is one the sink
        ///   could actually have been handed, and none is empty.
        #[cfg(feature = "try-runtime")]
        fn try_state(_: BlockNumberFor<T>) -> Result<(), sp_runtime::TryRuntimeError> {
            // ⚠ This deliberately does NOT pair `PendingChanges` with `LastReference`. That looks like the
            // tighter invariant and it is simply false: `LastReference` advances only on a fully drained
            // block, so a chain whose FIRST observation is backlogged legitimately has a non-zero backlog
            // and no frontier at all. That is the ordinary bootstrap, and the design's own acceptance test
            // asserts it. `LastAppliedAt` is the honest witness — it is stamped by every applied
            // observation, drained or not.
            ensure!(
                PendingChanges::<T>::get() == 0 || !LastAppliedAt::<T>::get().is_zero(),
                "PendingChanges is non-zero on a chain that has never applied an observation"
            );
            let bound = T::MaxRolesPerAccount::get() as usize;
            for (who, roles) in LastObservedRoles::<T>::iter() {
                ensure!(
                    roles.len() <= bound,
                    "a LastObservedRoles row exceeds MaxRolesPerAccount"
                );
                // A row is the set last handed to the sink; an EMPTY one is indistinguishable from "no
                // roles", which is what `remove` is for. An empty row would make the diff emit a
                // `None` clear for an account that already has nothing, every block, forever.
                ensure!(
                    !roles.is_empty(),
                    "a LastObservedRoles row is empty — it should have been removed, not stored empty"
                );
                let _ = who;
            }
            Ok(())
        }
    }

    #[pallet::call]
    impl<T: Config> Pallet<T> {
        /// Apply a verified Cardano observation. INHERENT-ONLY (`is_inherent` → true ⇒ pool-inadmissible)
        /// and `Mandatory`. Runs in `execute_block` on every node; its enforcement (monotonicity,
        /// stability bound, `MaxStakeWeight` skip, account resolution, weight/capacity application, unlock
        /// clamp) is what holds even on nodes that skip `check_inherent`.
        ///
        /// The weight is the benchmarked cost over the three change counts — one component per axis. It
        /// used to need four, two of which came from STORAGE rather than from the arguments: the old body
        /// re-scanned the entire previously-observed set every block to find the identities that had
        /// dropped out, so a block with an empty observation and a full previous set was the most
        /// expensive one there was, and no argument said so. There is no such scan now. An unlock is an
        /// ordinary `(key, None)` change that costs what any other change costs, so the arguments describe
        /// the whole cost and the worst case is simply three full pages.
        ///
        /// That also means the declared weight no longer scales with the number of participants at all,
        /// which is the point: it is bounded by `3 × MaxChangesPerBlock` forever, whatever the chain grows
        /// to.
        #[pallet::call_index(0)]
        #[pallet::weight((
            T::WeightInfo::observe(
                changes.len() as u32,
                stake_changes.len() as u32,
                role_changes.len() as u32,
            ),
            DispatchClass::Mandatory,
        ))]
        pub fn observe(
            origin: OriginFor<T>,
            reference: CardanoRef,
            inputs_commitment: [u8; 32],
            changes: BoundedVec<VaultChange, T::MaxChangesPerBlock>,
            stake_changes: BoundedVec<StakeChange, T::MaxChangesPerBlock>,
            role_changes: BoundedVec<
                RoleChange<T::AccountId, T::MaxRolesPerAccount>,
                T::MaxChangesPerBlock,
            >,
            pending: u32,
        ) -> DispatchResult {
            ensure_none(origin)?; // inherents dispatch with the None origin

            // `inputs_commitment` (the blake2_256 of the author's pre-reduction candidate set) is verified
            // CROSS-NODE in `check_inherent` (it splits a `Mismatch` from a `ComputeDiverged` when reads
            // disagree). The Mandatory dispatchable does NOT re-derive or apply it: there is no db-sync
            // in-runtime, and the consensus-pinned auditable artifact is the commitment carried in THIS
            // extrinsic — recomputable by anyone against an archived db-sync at `reference.slot`.
            let _ = inputs_commitment;

            // ── Both reference bounds are SKIP-not-reject ──────────────────────────────────────────
            //
            // This dispatch is `DispatchClass::Mandatory`: a returned `Err` is `BadMandatory`, which
            // discards the WHOLE BLOCK rather than just the extrinsic. So NO validation in this body may
            // return Err — the same discipline the `MaxStakeWeight` bound below already follows.
            //
            // For the anti-regression bound that is not merely tidiness, it is a HALT. `reference` is a
            // pure function of the PARENT block's slot, so a discarded block leaves the parent — and
            // therefore the next block's reference — unchanged: the next slot recomputes the IDENTICAL
            // reference and fails identically, forever. There is no on-chain recovery, because a runtime
            // upgrade needs a block to land in. Any committee-governed upgrade that RAISES
            // `StabilitySlots` lowers every future reference at a stroke (the mainnet arm is 216x the
            // preprod one) and is exactly that trigger.
            //
            // Skipping is safe in both the honest and the malicious case: nothing is applied, so the
            // weight ledger simply holds at its last value, and `LastReference` is NOT moved backwards —
            // the anti-regression guarantee ("never apply older Cardano data") is preserved by declining
            // to apply, not by killing the block. Because the early return also skips the `LastAppliedAt`
            // stamp below, a persistent skip latches `Stalled` / `ObservationStalled` — the designed,
            // loud, on-chain signal for "the sole weight writer is not writing".
            //
            // `Error::ReferenceRegressed` / `ReferenceTooFresh` are retained as on-wire contract (SCALE
            // indexes by declaration order; a retired variant leaves a permanent gap) but are no longer
            // returned from this dispatch.
            if let Some(last) = LastReference::<T>::get() {
                if reference.slot < last.slot {
                    log::warn!(
                        target: LOG_TARGET,
                        "observation SKIPPED: reference slot {} is behind the chain's last applied {} \
                         (a raised StabilitySlots, a rewound db-sync, or a misbehaving author). Weight \
                         holds at its last value; ObservationStalled latches if this persists.",
                        reference.slot,
                        last.slot,
                    );
                    return Ok(());
                }
            }
            // Stability sanity bound: the reference must be at least StabilitySlots behind THIS block's
            // own consensus time. Not evaluated when the block time predates the Shelley anchor — the
            // node IDP already fails closed there, and a young/pre-Shelley chain has no valid bound.
            if let Some(max_ref) = Self::max_reference_for_now() {
                if reference.slot > max_ref {
                    log::warn!(
                        target: LOG_TARGET,
                        "observation SKIPPED: reference slot {} is fresher than the stability bound {} \
                         — inside the Cardano rollback window. Weight holds at its last value.",
                        reference.slot,
                        max_ref,
                    );
                    return Ok(());
                }
            }

            // Mode read ONCE (deterministic — every node reads the identical pre-state in execute_block).
            // Enforcing (`true`, the DEFAULT) ⇒ `WeightSink` touches `AllowedStake`/capacity; frozen
            // (`false`, the emergency revert) ⇒ the read is still verified but no weight is written — it
            // holds at its last value.
            //
            // Every sink write AND every basis write is gated under this one flag, together. That pairing
            // is what makes a freeze recoverable: the basis is what `create_inherent` diffs against, so
            // holding it means the very same change set is re-derived on every frozen block and lands
            // intact on the first enforcing one. Advancing the basis while freezing the writes would
            // record an unlock as applied without ever zeroing it, stranding weight that no locked ADA
            // backs.
            let enforce = EnforceWeight::<T>::get();
            let min_lock = T::MinLock::get();
            let max_weight = T::MaxStakeWeight::get();
            let mut credited: u32 = 0;
            let mut cleared: u32 = 0;
            let mut skipped: u32 = 0;

            for (beacon, observed) in changes.iter() {
                match observed {
                    // A new or moved weight.
                    Some(lovelace) => {
                        // beacon → account. `create_inherent` already dropped the unresolvable ones, so
                        // this is defence in depth for a payload that did not come from it; skip, never
                        // Err (this dispatch is Mandatory — see the note above).
                        let account = match T::BeaconResolver::resolve(beacon) {
                            Some(a) => a,
                            None => {
                                skipped = skipped.saturating_add(1);
                                continue;
                            }
                        };
                        // Re-apply the MIN_LOCK floor and the MaxStakeWeight bound. `create_inherent`
                        // diffs on the floored value, so this is idempotent on a well-formed payload —
                        // but it is enforced HERE because this dispatch is the layer that runs on every
                        // node, including the ones that skip `check_inherent` entirely.
                        let weight = if *lovelace >= min_lock {
                            *lovelace
                        } else {
                            0u128
                        };
                        if weight > max_weight {
                            log::warn!(
                                target: LOG_TARGET,
                                "observe: SKIP change weight={weight} > MaxStakeWeight={max_weight} (bad value not consensus-pinned, block not bricked)",
                            );
                            skipped = skipped.saturating_add(1);
                            continue;
                        }
                        if enforce {
                            T::WeightSink::set_weight(&account, weight);
                            LastObserved::<T>::insert(beacon, (account, weight));
                        }
                        credited = credited.saturating_add(1);
                    }
                    // The explicit unlock — this beacon is no longer locked.
                    None => {
                        // The account comes from the BASIS, never from a fresh resolve. A beacon whose
                        // identity has since been revoked or rebound no longer resolves to the account
                        // that holds the weight, and zeroing the wrong account (or nobody) would leave
                        // `AllowedStake` standing with no locked ADA behind it.
                        let Some((account, _)) = LastObserved::<T>::get(beacon) else {
                            // Nothing recorded — already cleared, or never applied. Not an error.
                            skipped = skipped.saturating_add(1);
                            continue;
                        };
                        if enforce {
                            T::WeightSink::set_weight(&account, 0);
                            LastObserved::<T>::remove(beacon);
                        }
                        cleared = cleared.saturating_add(1);
                    }
                }
            }

            // ── VOTING POWER (epoch_stake) — the same enforce/freeze discipline and the same explicit
            // `None` unlock as the vault axis above, on the SAME verified observation. No MIN_LOCK floor
            // (total stake counts at any size) and no largest-wins (the node supplies one total per
            // credential); just resolve → cap-skip → apply.
            let max_vp = T::MaxVotingPower::get();
            let mut vp_credited: u32 = 0;
            let mut vp_cleared: u32 = 0;
            let mut vp_skipped: u32 = 0;
            for (stake_cred, observed) in stake_changes.iter() {
                match observed {
                    Some(total) => {
                        let account = match T::StakeResolver::resolve(stake_cred) {
                            Some(a) => a,
                            None => {
                                vp_skipped = vp_skipped.saturating_add(1);
                                continue; // unbound stake credential — skipped, not an error
                            }
                        };
                        if *total > max_vp {
                            log::warn!(
                                target: LOG_TARGET,
                                "observe: SKIP voting power={total} > MaxVotingPower={max_vp} (bad value not consensus-pinned)",
                            );
                            vp_skipped = vp_skipped.saturating_add(1);
                            continue;
                        }
                        if enforce {
                            T::VotingPowerSink::set_voting_power(&account, *total);
                            LastObservedStake::<T>::insert(stake_cred, (account, *total));
                        }
                        vp_credited = vp_credited.saturating_add(1);
                    }
                    None => {
                        // Account from the basis, for the same reason as the vault unlock: an unbound
                        // credential no longer resolves, and the weight still has to be taken back.
                        let Some((account, _)) = LastObservedStake::<T>::get(stake_cred) else {
                            vp_skipped = vp_skipped.saturating_add(1);
                            continue;
                        };
                        if enforce {
                            T::VotingPowerSink::set_voting_power(&account, 0);
                            LastObservedStake::<T>::remove(stake_cred);
                        }
                        vp_cleared = vp_cleared.saturating_add(1);
                    }
                }
            }

            // ── ROLES (SPO / dRep / CC) — the same enforce/freeze discipline, but the change unit is a
            // whole ACCOUNT's set rather than one credential's. The aggregation that used to happen here
            // (resolve every entry, group per account, dedup by `(kind, id)`) now happens in
            // `create_inherent`, which can do it because it runs in-runtime with the same state; each
            // change arrives carrying the account's COMPLETE new set. See [`RoleChange`] for why splitting
            // an account across two blocks would silently drop badges.
            let mut role_credited: u32 = 0;
            let mut role_cleared: u32 = 0;
            for change in role_changes.iter() {
                match &change.roles {
                    // An empty set is a clear, not a write — `create_inherent` emits `None` for it, so
                    // this only catches a payload that did not come from there. Storing an empty row
                    // would make the next diff see a basis account with nothing in it and emit a clear
                    // for it every block, forever.
                    Some(roles) if !roles.is_empty() => {
                        if enforce {
                            T::RoleSink::set_roles(&change.who, roles.as_slice());
                            LastObservedRoles::<T>::insert(&change.who, roles);
                        }
                        role_credited = role_credited.saturating_add(1);
                    }
                    _ => {
                        if enforce {
                            T::RoleSink::set_roles(&change.who, &[]);
                            LastObservedRoles::<T>::remove(&change.who);
                        }
                        role_cleared = role_cleared.saturating_add(1);
                    }
                }
            }

            // ── The backlog. `pending` is how much of this reference's change set did not fit; it is
            // carried in the extrinsic rather than recomputed here, so `check_inherent` verifies it
            // cross-node along with everything else.
            PendingChanges::<T>::put(pending);

            // The frontier advances ONLY on a block that carried its whole change set. Holding it while a
            // backlog drains is what lets a reader treat `LastReference` as "Cardano observed AND APPLIED
            // through here" instead of "the newest reference some part of which was applied". Nothing is
            // lost by waiting: the un-applied tail is not tracked against this reference at all, it is
            // simply the difference between the next snapshot and the basis, which the next block
            // re-derives from scratch.
            if pending == 0 {
                LastReference::<T>::put(&reference);
            } else {
                log::info!(
                    target: LOG_TARGET,
                    "observation BACKLOGGED at reference slot {}: {pending} changes deferred to the following blocks; the frontier holds until they drain",
                    reference.slot,
                );
                Self::deposit_event(Event::ObservationBacklogged {
                    reference_slot: reference.slot,
                    pending,
                });
            }

            // The stall alarm's clock, stamped on every APPLIED observation — including a FROZEN one: the
            // read was still verified cross-node, and a freeze is a deliberate governance state, not a
            // stall. Clearing the latch reads `LastAppliedAt` before overwriting it, so the reported gap is
            // the real one.
            let now_block = frame_system::Pallet::<T>::block_number();
            if Stalled::<T>::get() {
                let blocks = now_block.saturating_sub(LastAppliedAt::<T>::get());
                Stalled::<T>::put(false);
                Self::deposit_event(Event::ObservationResumed { blocks });
            }
            LastAppliedAt::<T>::put(now_block);

            Self::deposit_event(Event::ObservationApplied {
                reference_slot: reference.slot,
                credited,
                cleared,
                skipped,
                enforced: enforce,
            });
            Self::deposit_event(Event::VotingPowerObserved {
                reference_slot: reference.slot,
                credited: vp_credited,
                cleared: vp_cleared,
                skipped: vp_skipped,
                enforced: enforce,
            });
            Self::deposit_event(Event::RolesObserved {
                reference_slot: reference.slot,
                credited: role_credited,
                cleared: role_cleared,
                enforced: enforce,
            });
            Ok(())
        }

        /// Flip the enforce flag ([`EnforceWeight`], **default `true`**). `enabled = true` ⇒ the verified
        /// inherent APPLIES weight to `AllowedStake`/capacity (the normal state); `false` ⇒ FREEZE weight
        /// (emergency revert — the read is still verified cross-node, but no weight is written, so a
        /// determinism bug can be halted before a bad observation corrupts weight; fix it via a
        /// committee-governed runtime upgrade, then re-enable). Gated by [`Config::EnforceOrigin`] (the
        /// 3-of-5 committee; sudo-free). NOT an inherent (`is_inherent` matches only `observe`), so this is a
        /// normal pool-admissible governance call — the per-call mutual-exclusion invariant is preserved.
        ///
        /// ⚠ On a single-operator stack the "every producer re-derives" property is D4-SHAPED, not D4-TRUST
        /// (no independent verifier) — trustlessness graduates as validators federate (≥3 producers).
        #[pallet::call_index(1)]
        #[pallet::weight(T::WeightInfo::set_enforcement())]
        pub fn set_enforcement(origin: OriginFor<T>, enabled: bool) -> DispatchResult {
            T::EnforceOrigin::ensure_origin(origin)?;
            EnforceWeight::<T>::put(enabled);
            Self::deposit_event(Event::EnforcementSet { enabled });
            Ok(())
        }
    }

    impl<T: Config> Pallet<T> {
        /// The consensus-pinned observation config for the node-side IDP (via [`CardanoObserverApi`]).
        /// Single source of truth — node + runtime cannot drift on the anchors / window / vault policy.
        pub fn observer_config() -> ObserverConfig {
            ObserverConfig {
                shelley_start_unix: T::ShelleyStartUnix::get(),
                shelley_start_slot: T::ShelleyStartSlot::get(),
                stability_slots: T::StabilitySlots::get(),
                vault_policy_id: T::VaultPolicyId::get().to_vec(),
                stake_epoch_lookback: T::StakeEpochLookback::get(),
                max_scanned: T::MaxScanned::get(),
            }
        }

        /// Fit one account's aggregated role set into [`Config::MaxRolesPerAccount`], RESERVING room for
        /// the non-SPO badges.
        ///
        /// Two passes, not a truncation, and the reason is a bug this repo has already shipped once. The
        /// canonical `role_entries` order sorts on `RoleSource`, whose discriminants run
        /// `SpoCalidus(0), SpoOwner(1), DRep(2), Committee(3)` — so EVERY SPO entry for an account precedes
        /// its dRep and CC ones. A first-N cut therefore keeps pools and throws away exactly the badges a
        /// user cannot get back, and it does so silently. Spec 211 fixed that in the runtime's `RoleApply`
        /// sink with a reserved non-SPO prefix; doing it naively HERE would put the same bug one layer
        /// upstream, where the sink's fix can never see the entries it was meant to protect.
        ///
        /// Sizing `MaxRolesPerAccount` above the sink's own bound makes this rare rather than impossible —
        /// which is not the same thing, so the shape is enforced rather than assumed. The non-SPO pass is
        /// itself capped at [`NON_SPO_RESERVE`], bounding the trade in both directions: badges can never be
        /// starved by pools, and pools can never be starved by badges.
        ///
        /// Deterministic in both passes (it walks a canonically-ordered slice), so every node builds the
        /// identical set — which `check_inherent` requires.
        fn bounded_roles(
            set: &[(u8, RoleCredential, u128)],
        ) -> BoundedVec<(u8, RoleCredential, u128), T::MaxRolesPerAccount> {
            let mut out: BoundedVec<(u8, RoleCredential, u128), T::MaxRolesPerAccount> =
                BoundedVec::new();
            if set.len() <= T::MaxRolesPerAccount::get() as usize {
                // The overwhelmingly common case: everything fits, so nothing has to be chosen between and
                // the canonical order is preserved exactly.
                return BoundedVec::truncate_from(set.to_vec());
            }
            for spo_pass in [false, true] {
                for role in set.iter() {
                    // `kind_index`: 0 = SPO, 1 = dRep, 2 = CC.
                    let is_spo = role.0 == 0;
                    if is_spo != spo_pass {
                        continue;
                    }
                    if !spo_pass && out.len() >= NON_SPO_RESERVE {
                        break; // the reserved prefix is full — leave the rest of the set for pools
                    }
                    if out.try_push(*role).is_err() {
                        return out; // full
                    }
                }
            }
            out
        }

        /// Derive the bounded DELTA call from the node's FULL snapshot, against the basis in the current
        /// (parent-block) state. THE load-bearing function: both sides of consensus call it — the author
        /// through [`ProvideInherent::create_inherent`], every importer through
        /// [`ProvideInherent::check_inherent`] — and both execute it in-runtime against the same parent
        /// state, so agreement is by construction rather than by convention.
        ///
        /// It resolves, floors and cap-checks in exactly the terms `observe` will apply, and emits a change
        /// only where the result DIFFERS from the basis. Two consequences worth stating:
        ///
        /// - An entry `observe` would skip (a beacon bound to no account, a weight over
        ///   [`Config::MaxStakeWeight`]) is never emitted at all. If it were, `observe` would skip it, the
        ///   basis would not record it, and the next block would emit it again — for ever, occupying a page
        ///   slot and starving real changes. Filtering here is what makes the page fair.
        /// - Absence from the snapshot becomes an explicit `(key, None)`. That is the whole of the old
        ///   unlock clamp; there is no second full-set pass anywhere any more.
        ///
        /// ⚠ COST. This walks the snapshot (a point read of the basis per entry) and then the basis (to
        /// find what dropped out), so deriving the delta is O(observed set) even when the delta is empty.
        /// That is deliberate and it is not the cost this change set out to remove: it is node-local work
        /// in the block-building and import paths, NOT consensus weight, and it is strictly smaller than
        /// the db-sync read and reduction the same node already performs over the same set to produce the
        /// snapshot in the first place. What the change removes is the O(participants) term from the
        /// WEIGHED dispatch and from the block payload, and the ceiling that came with it.
        ///
        /// Two of the three axes are not even unbounded here: the stake and role observations are scoped
        /// node-side to the credentials the runtime reports, and both of those scans are capped at
        /// [`Config::MaxScanned`] — so those bases cannot exceed it. Only the vault axis is unbounded, and
        /// each row there costs a real Cardano UTxO holding at least [`Config::MinLock`].
        fn derive_call(obs: &CardanoObservation) -> Call<T> {
            let limit = T::MaxChangesPerBlock::get() as usize;

            // ── VAULT. Desired state first, in the terms `observe` writes.
            let min_lock = T::MinLock::get();
            let max_weight = T::MaxStakeWeight::get();
            let mut desired: alloc::collections::BTreeMap<BeaconName, (T::AccountId, u128)> =
                alloc::collections::BTreeMap::new();
            for (beacon, lovelace) in obs.entries.iter() {
                let Some(account) = T::BeaconResolver::resolve(beacon) else {
                    continue; // unbound beacon — never enters the delta
                };
                let weight = if *lovelace >= min_lock {
                    *lovelace
                } else {
                    0u128
                };
                if weight > max_weight {
                    continue; // would be skipped on apply — never enters the delta
                }
                desired.insert(*beacon, (account, weight));
            }
            let mut vault: alloc::vec::Vec<VaultChange> = alloc::vec::Vec::new();
            for (beacon, (account, weight)) in desired.iter() {
                // The account is part of the comparison, not just the weight: a beacon rebound to a
                // different account has to be re-applied even at an unchanged lovelace, or the new owner
                // never gets the weight.
                match LastObserved::<T>::get(beacon) {
                    Some((prev_account, prev_weight))
                        if prev_account == *account && prev_weight == *weight => {}
                    _ => vault.push((*beacon, Some(*weight))),
                }
            }
            for (beacon, _) in LastObserved::<T>::iter() {
                if !desired.contains_key(&beacon) {
                    vault.push((beacon, None));
                }
            }

            // ── VOTING POWER. Same shape, no floor.
            let max_vp = T::MaxVotingPower::get();
            let mut vp_desired: alloc::collections::BTreeMap<
                StakeCredential,
                (T::AccountId, u128),
            > = alloc::collections::BTreeMap::new();
            for (cred, total) in obs.stake_entries.iter() {
                let Some(account) = T::StakeResolver::resolve(cred) else {
                    continue;
                };
                if *total > max_vp {
                    continue;
                }
                vp_desired.insert(*cred, (account, *total));
            }
            let mut stake: alloc::vec::Vec<StakeChange> = alloc::vec::Vec::new();
            for (cred, (account, total)) in vp_desired.iter() {
                match LastObservedStake::<T>::get(cred) {
                    Some((prev_account, prev_total))
                        if prev_account == *account && prev_total == *total => {}
                    _ => stake.push((*cred, Some(*total))),
                }
            }
            for (cred, _) in LastObservedStake::<T>::iter() {
                if !vp_desired.contains_key(&cred) {
                    stake.push((cred, None));
                }
            }

            // ── ROLES. Aggregate per resolved account FIRST — the sink overwrites an account's whole set,
            // so the account, not the credential, is the unit that can be safely written on its own. This
            // is the aggregation `observe` used to do inline, moved here so the diff compares whole sets.
            let mut role_desired: alloc::collections::BTreeMap<
                T::AccountId,
                alloc::vec::Vec<(u8, RoleCredential, u128)>,
            > = alloc::collections::BTreeMap::new();
            for entry in obs.role_entries.iter() {
                let Some(account) = T::RoleResolver::resolve(entry.source, &entry.credential)
                else {
                    continue; // unresolved credential — skipped, not an error
                };
                let kind = entry.source.kind_index();
                let set = role_desired.entry(account).or_default();
                // Dedup by the full (kind, id): both SPO sources key on the pool id, so an mSPO's several
                // pools each yield their own pool-named SPO badge, while the SAME pool reached via both
                // the owner and Calidus paths collapses to ONE entry (never double-counted). First-wins in
                // the deterministic `role_entries` order, so the set stays byte-stable across nodes. The
                // chamber `weight` rides with the (kind, id) — deterministic per id, so first-wins keeps
                // the canonical value.
                if set.iter().any(|(k, v, _w)| *k == kind && *v == entry.id) {
                    continue;
                }
                // Collected UNBOUNDED on purpose — the bound is applied below, reserve-aware. Truncating
                // here would truncate in `role_entries` order, and see `bounded_roles` for why that
                // silently throws away the wrong badges.
                set.push((kind, entry.id, entry.weight));
            }
            let mut roles: alloc::vec::Vec<RoleChange<T::AccountId, T::MaxRolesPerAccount>> =
                alloc::vec::Vec::new();
            for (account, set) in role_desired.iter() {
                let bounded = Self::bounded_roles(set);
                if LastObservedRoles::<T>::get(account).as_ref() == Some(&bounded) {
                    continue;
                }
                roles.push(RoleChange {
                    who: account.clone(),
                    roles: Some(bounded),
                });
            }
            for (account, _) in LastObservedRoles::<T>::iter() {
                if !role_desired.contains_key(&account) {
                    roles.push(RoleChange {
                        who: account,
                        roles: None,
                    });
                }
            }

            // ── Canonical order, then page. Sorting is what makes the truncation deterministic across
            // nodes: the forward pass is already key-sorted (a BTreeMap), but the drop-outs come from a
            // hash-ordered map iteration and have to be merged into place.
            vault.sort_unstable_by(|a, b| a.0.cmp(&b.0));
            stake.sort_unstable_by(|a, b| a.0.cmp(&b.0));
            roles.sort_unstable_by(|a, b| a.who.cmp(&b.who));

            let pending = vault
                .len()
                .saturating_sub(limit)
                .saturating_add(stake.len().saturating_sub(limit))
                .saturating_add(roles.len().saturating_sub(limit)) as u32;
            vault.truncate(limit);
            stake.truncate(limit);
            roles.truncate(limit);

            Call::observe {
                reference: obs.reference.clone(),
                inputs_commitment: obs.inputs_commitment,
                // Truncated to `limit` above, so `truncate_from` never actually truncates — it is the
                // infallible constructor, chosen over `try_from().expect()` because this runs inside a
                // Mandatory inherent where a panic discards the block.
                changes: BoundedVec::truncate_from(vault),
                stake_changes: BoundedVec::truncate_from(stake),
                role_changes: BoundedVec::truncate_from(roles),
                pending,
            }
        }

        /// The maximum legitimate reference slot for THIS block = `cardano_slot(now) − StabilitySlots`,
        /// or `None` when the block time predates the Shelley anchor (so the bound is skipped). All
        /// arithmetic is CHECKED (release WASM has overflow-checks off; a naive subtraction would WRAP,
        /// not fail). Mirrors `cardano_reference_slot` in the `cogno-dbsync` reduction.
        fn max_reference_for_now() -> Option<u64> {
            let now_s = T::UnixTime::now().as_secs();
            let t0 = T::ShelleyStartUnix::get();
            let s0 = T::ShelleyStartSlot::get();
            let window = T::StabilitySlots::get();
            let elapsed = now_s.checked_sub(t0)?; // pre-Shelley ⇒ None (skip the bound)
            let cardano_slot = s0.checked_add(elapsed)?;
            let max_ref = cardano_slot.checked_sub(window)?;
            if max_ref < s0 {
                return None;
            }
            Some(max_ref)
        }
    }

    #[pallet::inherent]
    impl<T: Config> ProvideInherent for Pallet<T> {
        type Call = Call<T>;
        type Error = InherentError;
        const INHERENT_IDENTIFIER: InherentIdentifier = INHERENT_IDENTIFIER;

        /// AUTHOR side: diff this node's snapshot against the on-chain basis and build the `observe` call
        /// from the difference. Absent data ⇒ no inherent this block (legal — `is_inherent_required` is the
        /// default `Ok(None)`), which is now the ONLY reason this returns `None`.
        ///
        /// It used to have a second: an observation over `MaxObserved` failed `BoundedVec::try_from` and
        /// abstained, dropping the whole inherent. Because this pallet is the sole weight writer and the
        /// reference is a pure function of the parent, that abstention repeated every slot and froze weight
        /// for EVERY account until somebody unlocked — a 1025th locker could brick the chain's weight
        /// writer for the other 1024. A surplus is now a page boundary: [`Self::derive_call`] fills one
        /// page, reports the rest as `pending`, and the basis it advances makes the next block's diff the
        /// remainder.
        fn create_inherent(data: &InherentData) -> Option<Self::Call> {
            let obs = data
                .get_data::<CardanoObservation>(&INHERENT_IDENTIFIER)
                .ok()
                .flatten()?;
            Some(Self::derive_call(&obs))
        }

        /// IMPORTER side: re-derive the delta from THIS node's own read, against the SAME parent state the
        /// author derived against, and compare. Own source behind/absent ⇒ `CannotVerify` (non-fatal:
        /// accept without verifying — never fork on lag).
        ///
        /// Comparing the DERIVED delta rather than the raw snapshot is what keeps this honest under a
        /// backlog. Both sides run the identical [`Self::derive_call`] over the identical basis, so both
        /// page at the identical boundary and both report the identical `pending` — a draining block is not
        /// a disagreement. Comparing raw snapshots instead would have said nothing about whether the
        /// author's page was the one the rules produce, which is precisely what has to be verified now that
        /// the block carries a difference rather than a statement of the whole truth.
        ///
        /// When the derived vault `changes` differ, the `inputs_commitment` splits the (fatal) failure: a
        /// differing commitment ⇒ `Mismatch` (saw different Cardano data); an identical commitment ⇒
        /// `ComputeDiverged` (same raw data, different derived output). `ComputeDiverged` now covers the
        /// diff as well as the reduction, which are both this codebase's own deterministic code — the
        /// diagnostic it carries ("not a data disagreement; a version skew or a determinism bug") is
        /// unchanged and if anything more likely to be the truth.
        fn check_inherent(call: &Self::Call, data: &InherentData) -> Result<(), Self::Error> {
            let Call::observe {
                reference,
                inputs_commitment,
                changes,
                stake_changes,
                role_changes,
                pending,
            } = call
            else {
                return Ok(());
            };
            let local = match data
                .get_data::<CardanoObservation>(&INHERENT_IDENTIFIER)
                .ok()
                .flatten()
            {
                Some(o) => o,
                None => return Err(InherentError::CannotVerify),
            };

            // ⚠ THE ONE BLOCK WHERE "the same parent state" IS FALSE — accept without verifying.
            //
            // Everywhere else, author and importer derive against identical state and agree by
            // construction. On the block that ENACTS a runtime upgrade they do not, and the asymmetry is
            // in the SDK rather than here: the author builds through `sc_block_builder::BlockBuilder`,
            // which calls `Core::initialize_block` and then runs `inherent_extrinsics` on that SAME api
            // instance — so `create_inherent` sees state AFTER `on_runtime_upgrade`. The importer arrives
            // through `check_inherents_with_data(client, parent_hash, ..)`, a bare runtime-API call whose
            // runtime impl is `data.check_extrinsics(&block)`; nothing calls `initialize_block`, so it
            // sees the raw parent state with no migration applied.
            //
            // That is invisible while `check_inherent` compares raw data, which is what it did before
            // spec 215. It bites the moment it re-derives from STORAGE — and it bites hardest on the very
            // upgrade this pallet ships: `migrations::v1` seeds the three bases `derive_call` diffs
            // against, so on that block the author diffs against seeded maps and every importer diffs
            // against empty ones. The deltas differ, and the difference reads as `ComputeDiverged`, which
            // is FATAL. Every importing node would reject the upgrade block and the chain would stop.
            //
            // The predicate is `Executive::runtime_upgraded()` verbatim — the same `LastRuntimeUpgrade`
            // read and the same `was_upgraded` comparison that DECIDES whether the migration runs at all.
            // Reimplementing it as a spec_version inequality would work today and silently drift the day
            // the two disagree (`was_upgraded` also fires on a `spec_name` change, and treats an absent
            // record as upgraded). Borrowing the exact test means this exemption covers precisely the
            // blocks that migrate, for ANY migration — including future ones touching the resolver maps
            // (`AccountOf`, `AccountOfStakeCred`, `RoleCredIndex`) that `derive_call` also reads and that
            // would fork the same way.
            //
            // At the parent state `LastRuntimeUpgrade` still holds the OUTGOING version, because
            // `initialize_block` is what updates it — which is the same reason the two sides disagree.
            //
            // Skipping the cross-node comparison for one block is safe, and narrower than it looks. It is
            // the same posture as `CannotVerify` (accept, do not verify), the block still has to be
            // AUTHORED by a producer whose own read succeeded, and `execute_block` then runs the migration
            // before applying `observe` — so the delta lands against the state it was derived from. The
            // Mandatory dispatchable's own enforcement (monotonicity, the stability bound, the skip
            // bounds, resolution, the basis bookkeeping) runs on every node regardless, and the block
            // after this one verifies normally again.
            let current_version = <T as frame_system::Config>::Version::get();
            let enacting_upgrade = frame_system::LastRuntimeUpgrade::<T>::get()
                .map(|last| last.was_upgraded(&current_version))
                .unwrap_or(true);
            if enacting_upgrade {
                log::info!(
                    target: LOG_TARGET,
                    "runtime-upgrade block: accepting the observation without cross-node verification (the author derived it after on_runtime_upgrade, this node would derive it before). Verification resumes next block.",
                );
                return Ok(());
            }

            let Call::observe {
                reference: exp_reference,
                changes: exp_changes,
                stake_changes: exp_stake,
                role_changes: exp_roles,
                pending: exp_pending,
                ..
            } = Self::derive_call(&local)
            else {
                return Err(InherentError::Mismatch);
            };
            // The reference is compared IN FULL (slot + the SEALED `block_hash` anchor). The anchor is the
            // latest stable Cardano block ≤ the reference (see [`CardanoRef`]) — re-validating it is what
            // makes the header-sealed `cobs` anchor importer-checked. It does NOT spuriously fork: a behind
            // importer abstains (→ CannotVerify above) before it can reach a FALSE mismatch, and two honest
            // caught-up nodes agree on the stable anchor by construction.
            //
            // ⚠ `inputs_commitment` is deliberately NOT part of this test. It commits to the PRE-reduction
            // vault candidate set, and two honest nodes routinely hold different candidate sets that reduce
            // to the same result — one may have seen a UTxO the other has not, which the time filter or the
            // largest-wins fold then drops. Rejecting on the commitment alone would fork the chain on a
            // difference that provably changed nothing. It is consulted ONLY below, to classify a failure
            // that has already been established on the outputs.
            if reference == &exp_reference
                && changes.as_slice() == exp_changes.as_slice()
                && stake_changes.as_slice() == exp_stake.as_slice()
                && role_changes.as_slice() == exp_roles.as_slice()
                && *pending == exp_pending
            {
                return Ok(());
            }
            // The reads disagree (fatal either way). `ComputeDiverged` is reserved for the case where the
            // raw vault inputs provably agree: same reference + same vault `inputs_commitment`, but a
            // different derived vault delta ⇒ the same raw data turned into a different output. Everything
            // else — a differing reference/anchor, a differing vault commitment, or a differing stake/role
            // delta (neither has a vault commitment to appeal to) — is a data `Mismatch`.
            if reference == &local.reference
                && *inputs_commitment == local.inputs_commitment
                && changes.as_slice() != exp_changes.as_slice()
            {
                Err(InherentError::ComputeDiverged)
            } else {
                Err(InherentError::Mismatch)
            }
        }

        fn is_inherent(call: &Self::Call) -> bool {
            matches!(call, Call::observe { .. })
        }
    }
}
