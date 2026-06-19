//! # Cardano-observer pallet (cogno-chain) — in-protocol deterministic observation (D4 weight rung)
//!
//! **Sets `talk-stake` weight from a consensus-verified Substrate INHERENT** carrying the
//! deterministically-observed Cardano `talk_vault` state, replacing the trusted off-chain
//! `talk_stake.set_stake` write. Every importing validator independently re-derives the same Cardano
//! read and rejects the block on mismatch, so the locked-ADA weight becomes a consensus-verified
//! OUTPUT rather than a trusted oracle injection. Aura+GRANDPA are unchanged. Full design +
//! determinism contract: `docs/IN-PROTOCOL-OBSERVATION.md`.
//!
//! ## What is inherent data vs on-chain logic (§4.1)
//! The ONLY thing carried as inherent data is the raw observed `(beacon, lovelace)` set as-of a stable
//! reference slot (the node-side `InherentDataProvider` does that IO, byte-identically across nodes
//! via the shared logic mirrored from `services/_shared/observation.mjs`). Everything else is
//! deterministic on-chain logic that lives here: the `beacon → account` lookup
//! ([`Config::BeaconResolver`] = cogno-gate `AccountOf` in the runtime), the MIN_LOCK floor, the
//! `MaxStakeWeight` bound, weight application + capacity priming ([`Config::WeightSink`] = a
//! talk-stake + microblog adapter), and the unlock clamp.
//!
//! ## The two enforcement layers (§6)
//! - [`ProvideInherent::check_inherent`] does the CROSS-NODE read match only: the importer compares the
//!   author's observation against its OWN node's read at the same reference. A difference is
//!   [`InherentError::Mismatch`] (**fatal** → block rejected); the importer's source being behind is
//!   [`InherentError::CannotVerify`] (**non-fatal** → accept without verifying — never fork on a slow
//!   node). `check_inherent` is NOT run by every node (warp/state sync skip it; it is not re-run in
//!   `execute_block`), so anything that must hold for EVERY node is enforced in the Mandatory
//!   dispatchable below, which DOES run in `execute_block`.
//! - The `observe` dispatchable is `DispatchClass::Mandatory` and `is_inherent`-only (pool-inadmissible,
//!   the §5.2 mutual-exclusion invariant). It enforces, on every node: reference monotonicity, the
//!   stability sanity bound, the `MaxStakeWeight` skip-not-reject, account resolution, weight + capacity
//!   application, and the unlock clamp.
//!
//! ## Honest posture (§2/§11)
//! `check_inherent`'s "every producer re-derives" is load-bearing only with MULTIPLE independent block
//! producers — on a single-operator stack this is **D4-SHAPED, not D4-TRUST** (it buys consensus-pinned
//! auditability, not trust). Cutting `set_stake` over to inherent-only is co-sequenced with ≥3
//! independent producers; until then this pallet runs in shadow (see the runtime wiring, a later step).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub mod weights;
pub use weights::*;

use codec::{Decode, DecodeWithMemTracking, Encode, MaxEncodedLen};
use scale_info::TypeInfo;
use sp_inherents::{InherentIdentifier, IsFatalError};

/// Off-chain node logs only (the on-chain audit trail is the `ObservationApplied` event).
pub const LOG_TARGET: &str = "runtime::cardano-observer";

/// The 8-byte inherent identifier under which the node-side `InherentDataProvider` supplies the
/// observed Cardano vault state.
pub const INHERENT_IDENTIFIER: InherentIdentifier = *b"cgnoobsv";

/// A 32-byte beacon name == the L1 beacon `token_name` == the cogno-gate `AccountOf` key
/// (= `blake2b_256(plutus_data_cbor(owner Address))`; derived off-chain at bind, never re-derived here).
pub type BeaconName = [u8; 32];

/// The stable Cardano reference the observation was taken as-of (carried in the inherent). The `slot`
/// is a deterministic function of the PARENT block (so author + importer agree; §5.1); `block_hash` is
/// for the node-side point-existence check (not consensus-load-bearing inside the runtime).
#[derive(
	Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen, Default,
)]
pub struct CardanoRef {
	pub slot: u64,
	pub block_hash: [u8; 32],
}

/// The observation supplied as inherent DATA by the node (transport form: an unbounded `Vec`; the
/// runtime `Call` bounds it to [`Config::MaxObserved`]). Entries are canonical-sorted ascending by the
/// 32 beacon bytes — the SAME canonical order `services/_shared/observation.mjs` produces.
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct CardanoObservation {
	pub reference: CardanoRef,
	pub entries: alloc::vec::Vec<(BeaconName, u128)>,
}

/// The inherent error. The node-side `try_handle_error` (a later step) branches on this: `Mismatch`
/// is propagated (`Some(Err(_))` → block rejected); `CannotVerify` is swallowed (`Some(Ok(()))` →
/// accept without verifying). A blanket-swallow would defeat the entire fork-protection (§6).
#[derive(Encode, Decode, Debug)]
pub enum InherentError {
	/// The author's observation does not match the importer's own read at the same reference. FATAL.
	Mismatch,
	/// The importer's own Cardano data source is behind the reference / unavailable. NON-FATAL.
	CannotVerify,
}

impl IsFatalError for InherentError {
	fn is_fatal_error(&self) -> bool {
		match self {
			InherentError::Mismatch => true,
			InherentError::CannotVerify => false,
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
/// never-delete-the-row invariants, `ECONOMICS.md` §6.1). `weight == 0` is the unlock clamp. Implemented
/// by a talk-stake + microblog adapter in the runtime; a recorder in tests.
pub trait WeightSink<AccountId> {
	fn set_weight(who: &AccountId, weight: u128);
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
		type RuntimeEvent: From<Event<Self>>
			+ IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// Max identities observed in one block (bounds the inherent + `LastObserved`).
		#[pallet::constant]
		type MaxObserved: Get<u32>;
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
		/// Beacon → bound account (cogno-gate `AccountOf` in the runtime).
		type BeaconResolver: BeaconResolver<Self::AccountId>;
		/// Apply weight + capacity (talk-stake + microblog adapter in the runtime).
		type WeightSink: WeightSink<Self::AccountId>;
		/// The block's consensus time (`pallet_timestamp` implements `UnixTime`).
		type UnixTime: UnixTime;
		/// Dispatch weights.
		type WeightInfo: WeightInfo;
	}

	/// The last accepted Cardano reference — the monotonicity anchor (§5.6). `None` before the first
	/// observation.
	#[pallet::storage]
	pub type LastReference<T: Config> = StorageValue<_, CardanoRef, OptionQuery>;

	/// The previously-credited `(beacon, account)` set — required to compute the unlock-clamp set
	/// (`LastObserved \ current`); a bare digest could not yield "which identities dropped out" (§4.2).
	#[pallet::storage]
	pub type LastObserved<T: Config> =
		StorageValue<_, BoundedVec<(BeaconName, T::AccountId), T::MaxObserved>, ValueQuery>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A verified observation was applied: `credited` identities had weight set, `cleared` had
		/// weight zeroed (unlock clamp), as-of `reference_slot`.
		ObservationApplied { reference_slot: u64, credited: u32, cleared: u32 },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// The proposed reference is older than the last accepted one (anti-regression, §5.6). A
		/// malicious author cannot rewind observed Cardano state.
		ReferenceRegressed,
		/// The proposed reference is fresher than the stability window allows (closer to the block's own
		/// time than `StabilitySlots`) — i.e. it reads history that could still roll back.
		ReferenceTooFresh,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Apply a verified Cardano observation. INHERENT-ONLY (`is_inherent` → true ⇒ pool-inadmissible)
		/// and `Mandatory`. Runs in `execute_block` on every node; its enforcement (monotonicity,
		/// stability bound, `MaxStakeWeight` skip, account resolution, weight/capacity application, unlock
		/// clamp) is what holds even on nodes that skip `check_inherent` (§6).
		#[pallet::call_index(0)]
		#[pallet::weight((T::WeightInfo::observe(entries.len() as u32), DispatchClass::Mandatory))]
		pub fn observe(
			origin: OriginFor<T>,
			reference: CardanoRef,
			entries: BoundedVec<(BeaconName, u128), T::MaxObserved>,
		) -> DispatchResult {
			ensure_none(origin)?; // inherents dispatch with the None origin

			// Anti-regression (§5.6): never accept an older reference than the chain already holds.
			if let Some(last) = LastReference::<T>::get() {
				ensure!(reference.slot >= last.slot, Error::<T>::ReferenceRegressed);
			}
			// Stability sanity bound: the reference must be at least StabilitySlots behind THIS block's
			// own consensus time. Skipped (not failed) when the block time predates the Shelley anchor —
			// the node IDP already fails closed there, and a young/pre-Shelley chain has no valid bound.
			if let Some(max_ref) = Self::max_reference_for_now() {
				ensure!(reference.slot <= max_ref, Error::<T>::ReferenceTooFresh);
			}

			let min_lock = T::MinLock::get();
			let max_weight = T::MaxStakeWeight::get();
			let mut credited_set: BoundedVec<(BeaconName, T::AccountId), T::MaxObserved> =
				BoundedVec::new();
			let mut credited: u32 = 0;

			for (beacon, lovelace) in entries.iter() {
				// beacon → account (bind precedes weight; an unbound beacon is skipped, not an error).
				let account = match T::BeaconResolver::resolve(beacon) {
					Some(a) => a,
					None => continue,
				};
				// MIN_LOCK floor, then the MaxStakeWeight bound as SKIP-not-reject (§7 step 3).
				let weight = if *lovelace >= min_lock { *lovelace } else { 0u128 };
				if weight > max_weight {
					log::warn!(
						target: LOG_TARGET,
						"observe: SKIP entry weight={weight} > MaxStakeWeight={max_weight} (bad value not consensus-pinned, block not bricked)",
					);
					continue;
				}
				T::WeightSink::set_weight(&account, weight);
				// credited_set is bounded by MaxObserved, same as `entries`, so try_push cannot overflow
				// for a well-formed inherent; on the (impossible) overflow we simply don't record it for
				// the clamp diff rather than failing the Mandatory block.
				let _ = credited_set.try_push((*beacon, account));
				credited = credited.saturating_add(1);
			}

			// Unlock clamp (§7 step 6): a previously-credited account absent from the current set → 0.
			let prev = LastObserved::<T>::get();
			let mut cleared: u32 = 0;
			for (beacon, account) in prev.iter() {
				if !credited_set.iter().any(|(b, _)| b == beacon) {
					T::WeightSink::set_weight(account, 0);
					cleared = cleared.saturating_add(1);
				}
			}

			LastObserved::<T>::put(credited_set);
			LastReference::<T>::put(&reference);
			Self::deposit_event(Event::ObservationApplied {
				reference_slot: reference.slot,
				credited,
				cleared,
			});
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		/// The maximum legitimate reference slot for THIS block = `cardano_slot(now) − StabilitySlots`,
		/// or `None` when the block time predates the Shelley anchor (so the bound is skipped). All
		/// arithmetic is CHECKED (release WASM has overflow-checks off; a naive subtraction would WRAP,
		/// not fail — §5.2). Mirrors `cardanoReferenceSlot` in `services/_shared/observation.mjs`.
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
			Some(Call::observe { reference: obs.reference, entries })
		}

		/// IMPORTER side: compare the author's observation against THIS node's own read at the same
		/// reference. Exact match ⇒ Ok. Difference ⇒ `Mismatch` (fatal). Own source behind/absent ⇒
		/// `CannotVerify` (non-fatal: accept without verifying — never fork because YOUR follower lags).
		fn check_inherent(call: &Self::Call, data: &InherentData) -> Result<(), Self::Error> {
			let (reference, entries) = match call {
				Call::observe { reference, entries } => (reference, entries),
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
			if *reference == local.reference && entries.as_slice() == local.entries.as_slice() {
				Ok(())
			} else {
				Err(InherentError::Mismatch)
			}
		}

		fn is_inherent(call: &Self::Call) -> bool {
			matches!(call, Call::observe { .. })
		}
	}
}
