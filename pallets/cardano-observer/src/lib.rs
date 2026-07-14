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
//! talk-stake + microblog adapter), and the unlock clamp.
//!
//! ## The two enforcement layers
//! - [`ProvideInherent::check_inherent`] does the CROSS-NODE read match only: the importer compares the
//!   author's observation against its OWN node's read at the same reference. When the reduced `entries`
//!   differ, the carried `inputs_commitment` (a `blake2_256` of the pre-reduction candidate set — the
//!   partner-chains `selection_inputs_hash` analog) splits the failure: differing commitments ⇒
//!   [`InherentError::Mismatch`] ("saw different Cardano data"); identical commitments ⇒
//!   [`InherentError::ComputeDiverged`] ("same data, different reduction" — a determinism bug). BOTH are
//!   **fatal** → block rejected; the split is diagnostic. The importer's own source being behind is
//!   [`InherentError::CannotVerify`] (**non-fatal** → accept without verifying — never fork on a slow
//!   node). `check_inherent` is NOT run by every node (warp/state sync skip it; it is not re-run in
//!   `execute_block`), so anything that must hold for EVERY node is enforced in the Mandatory
//!   dispatchable below, which DOES run in `execute_block`.
//! - The `observe` dispatchable is `DispatchClass::Mandatory` and `is_inherent`-only (pool-inadmissible,
//!   the mutual-exclusion invariant). It enforces, on every node: reference monotonicity, the
//!   stability sanity bound, the `MaxStakeWeight` skip-not-reject, account resolution, weight + capacity
//!   application, and the unlock clamp.
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
#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub mod weights;
pub use weights::*;

use codec::{Decode, DecodeWithMemTracking, Encode, MaxEncodedLen};
use scale_info::TypeInfo;
use sp_inherents::{InherentIdentifier, IsFatalError};
use sp_runtime::traits::{Saturating, Zero};

/// Off-chain node logs only (the on-chain audit trail is the `ObservationApplied` event).
pub const LOG_TARGET: &str = "runtime::cardano-observer";

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

/// The observation supplied as inherent DATA by the node (transport form: an unbounded `Vec`; the
/// runtime `Call` bounds it to [`Config::MaxObserved`]). Entries are canonical-sorted ascending by the
/// 32 beacon bytes — the SAME canonical order the `cogno-dbsync` reduction produces.
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
}

/// The inherent error. The node-side `try_handle_error` branches on this: `Mismatch` and
/// `ComputeDiverged` are propagated (`Some(Err(_))` → block rejected); `CannotVerify` is swallowed
/// (`Some(Ok(()))` → accept without verifying). A blanket-swallow would defeat the entire
/// fork-protection.
#[derive(Encode, Decode, Debug)]
pub enum InherentError {
    /// The author's observation reflects DIFFERENT Cardano data than the importer's own read at the same
    /// reference (the reduced `entries` differ AND the input commitments differ). FATAL.
    Mismatch,
    /// The importer's own Cardano data source is behind the reference / unavailable. NON-FATAL.
    CannotVerify,
    /// The author and importer agree on the raw Cardano inputs (identical `inputs_commitment`) but the
    /// author's REDUCED `entries` differ from the importer's — i.e. the same data reduced to a different
    /// observed set. This is a determinism divergence in the shared reduction (a bug / a version skew
    /// between binaries), not a data disagreement. FATAL (a divergent reduction must not be consensus-
    /// pinned), but reported distinctly so operators can tell it apart from a genuine data fork.
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
    /// The [`Config::MaxObserved`] ceiling, surfaced to the node so it can ALARM before the observation
    /// overruns it. An observation whose vault OR stake set exceeds this abstains in `create_inherent`
    /// (the whole inherent drops to `None`), silently FREEZING the sole weight writer — so the node logs
    /// a WARN as it approaches this and an ERROR at/over it. Single source of truth (node + runtime read
    /// the same ceiling), so a monitoring rule can key off it without a hard-coded duplicate.
    pub max_observed: u32,
}

sp_api::decl_runtime_apis! {
    /// Exposes the consensus-pinned [`ObserverConfig`] to the node-side observation InherentDataProvider.
    pub trait CardanoObserverApi {
        /// The current observation config (anchors, stability window, vault policy id, stake epoch lookback).
        fn observer_config() -> ObserverConfig;
        /// The set of currently-bound stake credentials (cogno-gate `AccountOfStakeCred` keys) — the
        /// credentials the node must read `epoch_stake` for, evaluated at the parent block's state.
        fn bound_stake_credentials() -> alloc::vec::Vec<StakeCredential>;
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

    #[pallet::pallet]
    pub struct Pallet<T>(_);

    #[pallet::config]
    pub trait Config: frame_system::Config {
        /// The overarching runtime event type.
        #[allow(deprecated)]
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
        /// Max identities observed in one block (bounds the inherent + `LastObserved`).
        ///
        /// A HARD CEILING on concurrent participants, not a batch size: the observation is a FULL-SET
        /// snapshot re-derived every block, so per-block cost is O(total participants), not O(changes).
        /// An observation over this bound makes `create_inherent` abstain — the whole inherent drops and
        /// the sole weight writer FREEZES. [`Stalled`] is what makes that freeze visible on-chain.
        #[pallet::constant]
        type MaxObserved: Get<u32>;
        /// Blocks without an APPLIED observation before the on-chain stall alarm latches ([`Stalled`]).
        /// The node authors the inherent every block, so a gap this long means the sole weight writer has
        /// stopped: db-sync is down or behind, or the observation overran [`Config::MaxObserved`] and
        /// `create_inherent` abstained.
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

    /// The last accepted Cardano reference — the monotonicity anchor. `None` before the first
    /// observation.
    #[pallet::storage]
    pub type LastReference<T: Config> = StorageValue<_, CardanoRef, OptionQuery>;

    /// The previously-credited `(beacon, account)` set — required to compute the unlock-clamp set
    /// (`LastObserved \ current`); a bare digest could not yield "which identities dropped out".
    #[pallet::storage]
    pub type LastObserved<T: Config> =
        StorageValue<_, BoundedVec<(BeaconName, T::AccountId), T::MaxObserved>, ValueQuery>;

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

    /// The previously-credited `(stake_credential, account)` set — the voting-power unlock-clamp basis
    /// (`LastObservedStake \ current` → 0), mirroring [`LastObserved`] for the vault weight.
    #[pallet::storage]
    pub type LastObservedStake<T: Config> =
        StorageValue<_, BoundedVec<(StakeCredential, T::AccountId), T::MaxObserved>, ValueQuery>;

    /// The block in which the last observation was APPLIED — the stall alarm's clock. `0` means "none
    /// yet": block 0 is genesis and carries no extrinsics, so a real observation can never stamp it. The
    /// `on_initialize` hook re-anchors a zero clock to the CURRENT block rather than measuring from block
    /// 0, so a chain upgraded into this alarm does not read its whole history as one long stall.
    #[pallet::storage]
    pub type LastAppliedAt<T: Config> = StorageValue<_, BlockNumberFor<T>, ValueQuery>;

    /// The latched stall alarm: `true` once the observer has gone [`Config::StallAfter`] blocks without
    /// applying an observation; cleared by the next accepted `observe`. LATCHED, not recomputed, so
    /// [`Event::ObservationStalled`] fires exactly ONCE per episode rather than every block.
    ///
    /// This is the ONLY on-chain signal that the sole weight writer has stopped. `create_inherent` drops
    /// the ENTIRE inherent when an observation exceeds [`Config::MaxObserved`] (the `BoundedVec::try_from`
    /// fails ⇒ `None`) — no delta, no partial apply — which silently freezes weight chain-wide. Before this
    /// flag the only evidence was a node-side `log::error!` and a Prometheus counter, i.e. OFF-CHAIN only:
    /// an operator watching the chain saw nothing at all.
    #[pallet::storage]
    pub type Stalled<T: Config> = StorageValue<_, bool, ValueQuery>;

    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    // Variant indices are ON-WIRE (every client that decodes an event keys off them). SCALE derives them
    // from declaration order, so they are pinned explicitly here: the two variants appended below cannot
    // shift 0/1/2, and a future reorder is a compile-visible decision rather than a silent break.
    pub enum Event<T: Config> {
        /// A verified observation was processed as-of `reference_slot`: `credited` identities had weight
        /// applied, `cleared` had it zeroed (unlock clamp), `skipped` were observed but dropped for
        /// exceeding `MaxStakeWeight` (step 3). `enforced` is the mode: `true` (the default) means weight
        /// was APPLIED to `AllowedStake`/capacity; `false` means frozen (emergency revert: verified but not
        /// applied), so `credited`/`cleared` count what WOULD have been applied.
        #[codec(index = 0)]
        ObservationApplied {
            reference_slot: u64,
            credited: u32,
            cleared: u32,
            skipped: u32,
            enforced: bool,
        },
        /// The VOTING-POWER half of the same verified observation: `credited` bound stake credentials had
        /// voting power applied, `cleared` were zeroed (unlock clamp), `skipped` exceeded `MaxVotingPower`.
        /// `enforced` mirrors `ObservationApplied`: `true` means applied to talk-stake `VotingPower`;
        /// `false` means frozen (not applied).
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
        /// writer has stopped. Either the node's Cardano read is unavailable, or the observation overran
        /// [`Config::MaxObserved`] and `create_inherent` abstained (dropping the whole inherent). Latched
        /// via [`Stalled`], so it fires ONCE per episode. `last_applied` is the block the last observation
        /// landed in; `blocks` is how long the gap had run when the alarm latched.
        #[codec(index = 3)]
        ObservationStalled {
            last_applied: BlockNumberFor<T>,
            blocks: BlockNumberFor<T>,
        },
        /// An observation was applied again after a latched stall, clearing [`Stalled`]. `blocks` is the
        /// total length of the gap.
        #[codec(index = 4)]
        ObservationResumed { blocks: BlockNumberFor<T> },
    }

    #[pallet::error]
    pub enum Error<T> {
        /// The proposed reference is older than the last accepted one (anti-regression). A
        /// malicious author cannot rewind observed Cardano state.
        ReferenceRegressed,
        /// The proposed reference is fresher than the stability window allows (closer to the block's own
        /// time than `StabilitySlots`) — i.e. it reads history that could still roll back.
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
        /// The weight is stated directly rather than benchmarked: the hook is one comparison plus, at
        /// worst, two reads / one write / one event, and `DbWeight` prices exactly that. The common path
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
            Stalled::<T>::put(true);
            log::error!(
                target: LOG_TARGET,
                "OBSERVATION STALLED: no observation applied for {blocks:?} blocks (last at {last:?}) — the SOLE weight writer has stopped (Cardano read unavailable, or the observation exceeded MaxObserved and the inherent was dropped)",
            );
            Self::deposit_event(Event::ObservationStalled {
                last_applied: last,
                blocks,
            });
            T::DbWeight::get().reads_writes(2, 2)
        }

        /// Both unlock-clamp bases are `BoundedVec<_, MaxObserved>`. LOWERING `MaxObserved` under live state
        /// therefore has teeth: a stored vec longer than the new bound fails to decode, and `ValueQuery`
        /// answers a decode failure with the DEFAULT — an EMPTY basis — so every account that has since
        /// unlocked keeps its weight forever, silently. `get()` cannot see that (it IS the thing that
        /// swallows it); `decode_len` reads the raw length prefix and is bound-independent, so it can.
        ///
        /// This runs under `try-runtime` against a snapshot of REAL state (docs/UPGRADES.md's pre-enactment
        /// dry-run), which is the only place a bound drop can be caught BEFORE it is on-chain.
        #[cfg(feature = "try-runtime")]
        fn try_state(_: BlockNumberFor<T>) -> Result<(), sp_runtime::TryRuntimeError> {
            let bound = T::MaxObserved::get() as usize;
            ensure!(
                LastObserved::<T>::decode_len().unwrap_or(0) <= bound,
                "LastObserved is longer than MaxObserved — the vault clamp basis will not decode"
            );
            ensure!(
                LastObservedStake::<T>::decode_len().unwrap_or(0) <= bound,
                "LastObservedStake is longer than MaxObserved — the stake clamp basis will not decode"
            );
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
        /// The weight is the benchmarked cost of the WHOLE call over four components, because the
        /// mass-unlock worst case is not expressible from the arguments alone:
        ///
        /// - `n` = `entries.len()` and `m` = `stake_entries.len()` — the two credit loops.
        /// - `p` = `LastObserved` len and `q` = `LastObservedStake` len — the two unlock-clamp bases. A
        ///   block whose observation is EMPTY but whose previous set was full is the most expensive one
        ///   there is (every prior identity is settled and zeroed), and `n`/`m` say nothing about it.
        ///
        /// `p`/`q` therefore come from storage. `decode_len` reads only the length prefix, of the two keys
        /// the body reads in full anyway.
        ///
        /// This replaces a hand-estimate that took `entries.len()` alone and under-counted the true cost by
        /// ~100x — on the one call in the chain that cannot be skipped. It also priced every term at
        /// `proof_size = 0`: inert here (a solochain's `max_block` sets proof_size to `u64::MAX`), but the
        /// entire PoV dimension of the sole per-block weight writer would read as free on a parachain.
        #[pallet::call_index(0)]
        #[pallet::weight((
            T::WeightInfo::observe(
                entries.len() as u32,
                stake_entries.len() as u32,
                LastObserved::<T>::decode_len().unwrap_or(0) as u32,
                LastObservedStake::<T>::decode_len().unwrap_or(0) as u32,
            ),
            DispatchClass::Mandatory,
        ))]
        pub fn observe(
            origin: OriginFor<T>,
            reference: CardanoRef,
            inputs_commitment: [u8; 32],
            entries: BoundedVec<(BeaconName, u128), T::MaxObserved>,
            stake_entries: BoundedVec<(StakeCredential, u128), T::MaxObserved>,
        ) -> DispatchResult {
            ensure_none(origin)?; // inherents dispatch with the None origin

            // `inputs_commitment` (the blake2_256 of the author's pre-reduction candidate set) is verified
            // CROSS-NODE in `check_inherent` (it splits a `Mismatch` from a `ComputeDiverged` when reads
            // disagree). The Mandatory dispatchable does NOT re-derive or apply it: there is no db-sync
            // in-runtime, and the consensus-pinned auditable artifact is the commitment carried in THIS
            // extrinsic — recomputable by anyone against an archived db-sync at `reference.slot`.
            let _ = inputs_commitment;

            // Anti-regression: never accept an older reference than the chain already holds.
            if let Some(last) = LastReference::<T>::get() {
                ensure!(reference.slot >= last.slot, Error::<T>::ReferenceRegressed);
            }
            // Stability sanity bound: the reference must be at least StabilitySlots behind THIS block's
            // own consensus time. Skipped (not failed) when the block time predates the Shelley anchor —
            // the node IDP already fails closed there, and a young/pre-Shelley chain has no valid bound.
            if let Some(max_ref) = Self::max_reference_for_now() {
                ensure!(reference.slot <= max_ref, Error::<T>::ReferenceTooFresh);
            }

            // Mode read ONCE (deterministic — every node reads the identical pre-state in execute_block).
            // Enforcing (`true`, the DEFAULT) ⇒ `WeightSink` touches `AllowedStake`/capacity; frozen
            // (`false`, the emergency revert) ⇒ the read is still verified but no weight is written — it
            // holds at its last value. Both `set_weight` call-sites (credit + clamp) AND the `LastObserved`/
            // `LastObservedStake` clamp-basis writes are gated under this one flag — advancing the basis while
            // freezing the writes would evict a mid-freeze unlock before it was zeroed (a stale-positive leak).
            let enforce = EnforceWeight::<T>::get();
            let min_lock = T::MinLock::get();
            let max_weight = T::MaxStakeWeight::get();
            let mut credited_set: BoundedVec<(BeaconName, T::AccountId), T::MaxObserved> =
                BoundedVec::new();
            let mut credited: u32 = 0;
            let mut skipped: u32 = 0;

            for (beacon, lovelace) in entries.iter() {
                // beacon → account (bind precedes weight; an unbound beacon is skipped, not an error).
                let account = match T::BeaconResolver::resolve(beacon) {
                    Some(a) => a,
                    None => continue,
                };
                // MIN_LOCK floor, then the MaxStakeWeight bound as SKIP-not-reject. A skipped
                // over-cap entry is counted (surfaced in the `ObservationApplied` event) so it is not
                // silently mis-read as agreement.
                let weight = if *lovelace >= min_lock {
                    *lovelace
                } else {
                    0u128
                };
                if weight > max_weight {
                    log::warn!(
                        target: LOG_TARGET,
                        "observe: SKIP entry weight={weight} > MaxStakeWeight={max_weight} (bad value not consensus-pinned, block not bricked)",
                    );
                    skipped = skipped.saturating_add(1);
                    continue;
                }
                // Apply to weight when enforcing (the default). When frozen (`set_enforcement(false)`), the
                // read is still verified but no `AllowedStake` write happens — weight holds at its last value.
                if enforce {
                    T::WeightSink::set_weight(&account, weight);
                }
                // credited_set is bounded by MaxObserved, same as `entries`, so try_push cannot overflow
                // for a well-formed inherent; on the (impossible) overflow we simply don't record it for
                // the clamp diff rather than failing the Mandatory block.
                let _ = credited_set.try_push((*beacon, account));
                credited = credited.saturating_add(1);
            }

            // Unlock clamp: a previously-credited account absent from the current set → 0.
            // FROZEN (`set_enforcement(false)`): the weight write is skipped, and — critically — the
            // `LastObserved` basis is HELD (advanced only when enforcing, below), so an account that unlocks
            // DURING a freeze stays in the basis and is clamped to 0 on the first enforcing block after
            // re-enable. Advancing the basis while frozen would evict such an account before it was ever
            // zeroed, stranding a stale-positive `AllowedStake` forever (voice not backed by locked ADA).
            // O(N) clamp: index the current beacons in a BTreeSet so the "absent from the current set" test
            // is a log-N lookup, not a nested linear scan. The old `credited_set.iter().any(..)` made this
            // loop O(N^2) — the binding per-block cost that capped how far `MaxObserved` could be raised.
            let current_beacons: alloc::collections::BTreeSet<BeaconName> =
                credited_set.iter().map(|(b, _)| *b).collect();
            let prev = LastObserved::<T>::get();
            let mut cleared: u32 = 0;
            for (beacon, account) in prev.iter() {
                if !current_beacons.contains(beacon) {
                    if enforce {
                        T::WeightSink::set_weight(account, 0);
                    }
                    cleared = cleared.saturating_add(1);
                }
            }

            // Advance the clamp basis ONLY when enforcing. Frozen, it must hold at its pre-freeze value so
            // re-enable clamps the accounts that dropped out during the freeze (counted in `cleared` but not
            // yet zeroed) — gating the write but not the basis would leak stale-positive weight.
            if enforce {
                LastObserved::<T>::put(credited_set);
            }

            // ── VOTING POWER (epoch_stake) — the same enforce/freeze discipline as the vault
            // weight above, on the SAME verified observation. No MIN_LOCK floor (total stake counts at any
            // size) and no largest-wins (the node supplies one total per credential); just resolve →
            // cap-skip → project/apply → unlock-clamp.
            let max_vp = T::MaxVotingPower::get();
            let mut vp_credited_set: BoundedVec<(StakeCredential, T::AccountId), T::MaxObserved> =
                BoundedVec::new();
            let mut vp_credited: u32 = 0;
            let mut vp_skipped: u32 = 0;
            for (stake_cred, total) in stake_entries.iter() {
                let account = match T::StakeResolver::resolve(stake_cred) {
                    Some(a) => a,
                    None => continue, // unbound stake credential — skipped, not an error
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
                }
                let _ = vp_credited_set.try_push((*stake_cred, account));
                vp_credited = vp_credited.saturating_add(1);
            }
            // Unlock clamp: a previously-credited stake credential absent from the current set → 0. Same
            // freeze discipline as the vault path: hold the `LastObservedStake` basis while frozen (advance
            // only when enforcing, below) so a credential that unbinds/unstakes DURING a freeze is clamped
            // on re-enable rather than evicted-unzeroed into a stale-positive `VotingPower`.
            // O(N) clamp (as the vault path above): BTreeSet lookup, not a nested linear scan.
            let current_creds: alloc::collections::BTreeSet<StakeCredential> =
                vp_credited_set.iter().map(|(c, _)| *c).collect();
            let vp_prev = LastObservedStake::<T>::get();
            let mut vp_cleared: u32 = 0;
            for (stake_cred, account) in vp_prev.iter() {
                if !current_creds.contains(stake_cred) {
                    if enforce {
                        T::VotingPowerSink::set_voting_power(account, 0);
                    }
                    vp_cleared = vp_cleared.saturating_add(1);
                }
            }
            if enforce {
                LastObservedStake::<T>::put(vp_credited_set);
            }

            LastReference::<T>::put(&reference);

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
                max_observed: T::MaxObserved::get(),
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

        /// AUTHOR side: build the `observe` call from this node's observation. Absent data ⇒ no inherent
        /// this block (legal — `is_inherent_required` is the default `Ok(None)`). An observation larger
        /// than `MaxObserved` ⇒ abstain (never author a malformed/truncated inherent).
        fn create_inherent(data: &InherentData) -> Option<Self::Call> {
            let obs = data
                .get_data::<CardanoObservation>(&INHERENT_IDENTIFIER)
                .ok()
                .flatten()?;
            let entries = BoundedVec::try_from(obs.entries).ok()?;
            let stake_entries = BoundedVec::try_from(obs.stake_entries).ok()?;
            Some(Call::observe {
                reference: obs.reference,
                inputs_commitment: obs.inputs_commitment,
                entries,
                stake_entries,
            })
        }

        /// IMPORTER side: compare the author's observation against THIS node's own read at the same
        /// reference. Identical reference (slot + sealed `block_hash` anchor) + reduced entries ⇒ Ok. Own
        /// source behind/absent ⇒ `CannotVerify` (non-fatal: accept without verifying — never fork on lag).
        /// When the reduced entries DIFFER, the `inputs_commitment` splits the (fatal) failure: a differing
        /// commitment ⇒ `Mismatch` (saw different Cardano data); an identical commitment ⇒ `ComputeDiverged`
        /// (same data, different reduction — a determinism bug / version skew).
        fn check_inherent(call: &Self::Call, data: &InherentData) -> Result<(), Self::Error> {
            let (reference, inputs_commitment, entries, stake_entries) = match call {
                Call::observe {
                    reference,
                    inputs_commitment,
                    entries,
                    stake_entries,
                } => (reference, inputs_commitment, entries, stake_entries),
                _ => return Ok(()),
            };
            let local = match data
                .get_data::<CardanoObservation>(&INHERENT_IDENTIFIER)
                .ok()
                .flatten()
            {
                Some(o) => o,
                None => return Err(InherentError::CannotVerify),
            };
            // Compare the FULL reference (slot + the SEALED `block_hash` anchor) + the canonical entries. The
            // anchor is the latest stable Cardano block ≤ the reference (see [`CardanoRef`]) — re-validating
            // it is what makes the header-sealed `cobs` anchor importer-checked. It does
            // NOT spuriously fork: a behind importer abstains (→ CannotVerify above) before it can reach a
            // FALSE mismatch, and two honest caught-up nodes agree on the stable anchor by construction.
            if reference == &local.reference
                && entries.as_slice() == local.entries.as_slice()
                && stake_entries.as_slice() == local.stake_entries.as_slice()
            {
                // Outputs agree (vault entries AND voting-power stake entries) ⇒ accept, REGARDLESS of the
                // input commitment: two honest nodes whose raw candidate sets differ only in UTxOs the
                // reduction drops (too-fresh / spent) still reduce to the same entries.
                return Ok(());
            }
            // The reads disagree (fatal either way). `ComputeDiverged` is reserved for the VAULT reduction:
            // same reference + same vault `inputs_commitment` but different vault `entries` ⇒ same raw vault
            // data reduced differently (a determinism bug). Everything else — a differing reference/anchor, a
            // differing vault commitment, or a differing `stake_entries` (a DIRECT `epoch_stake` read, no
            // reduction to diverge) — is a data `Mismatch`.
            if reference == &local.reference
                && *inputs_commitment == local.inputs_commitment
                && entries.as_slice() != local.entries.as_slice()
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
