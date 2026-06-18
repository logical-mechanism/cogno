//! # Validator Set pallet (cogno-chain, M6)
//!
//! **The MUTABLE Aura + GRANDPA validator set** — the block-producing authorities are no longer
//! frozen at genesis (`L3-chain.md` §8.2). This pallet is vendor-forked from
//! `gautamdhameja/substrate-validator-set` (a reference pattern, tracked ~`polkadot-v1.13.0`) and
//! ported to this SDK: `#[frame_support::pallet]` on frame v46 and the newer `pallet-session`
//! (`Currency` / `KeyDeposit` / `HoldReason` / `DisablingStrategy`).
//!
//! ## How it drives consensus (the throw-nothing-away wiring, `L3-chain.md` §8.2)
//! - It is the [`pallet_session::SessionManager`]: each session rotation, `new_session` returns the
//!   current [`Validators`] set, and `pallet-session` feeds that set to `pallet-aura` and
//!   `pallet-grandpa` via their `OneSessionHandler` impls. **Aura and GRANDPA therefore derive their
//!   authorities from the session, not from static genesis** (the two are mutually exclusive — the
//!   runtime seats authorities through `SessionConfig`, leaving the aura/grandpa genesis empty).
//! - `add_validator` / `remove_validator` are gated by [`Config::AddRemoveOrigin`] (the M5 3-of-5
//!   `FollowerCommittee`, with the `EnsureRoot`/sudo dev fallback). A change mutates [`Validators`]
//!   immediately but is only **applied at a session boundary** — `pallet-session` queues the new set
//!   one session, then enacts it the next (~2 sessions). It is never applied mid-session.
//! - [`Config::MinAuthorities`] is the floor: `remove_validator` refuses to drop the active set below
//!   it, so the operator cannot accidentally strand the chain with zero authorities. (On a 1–3
//!   authority chain GRANDPA finality can still stall with one offline authority — `L3-chain.md`
//!   §8.1; the floor only prevents *zero*.)
//!
//! ## The dormant im-online plumbing (NOT wired in v1)
//! [`OfflineValidators`], `mark_for_removal`, `remove_offline_validators`, and the [`ReportOffence`]
//! impl are ported from the fork so that wiring `pallet-im-online` later (auto-removing a provably
//! offline authority before it crosses the 1/3 GRANDPA-stall line, `L3-chain.md` §8.2) is a
//! runtime-only change. In v1 nothing reports offences, so this plumbing is inert.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;
use alloc::vec::Vec;

use frame_support::{
	pallet_prelude::*,
	traits::{EstimateNextSessionRotation, Get, ValidatorSet, ValidatorSetWithIdentification},
	weights::Weight,
	DefaultNoBound,
};
use frame_system::pallet_prelude::*;
pub use pallet::*;
use sp_runtime::traits::{Convert, Zero};
use sp_staking::offence::{Offence, OffenceError, ReportOffence};
pub use weights::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

pub mod weights;

pub const LOG_TARGET: &str = "runtime::validator-set";

#[frame_support::pallet]
pub mod pallet {
	use super::*;

	#[pallet::config]
	pub trait Config: frame_system::Config + pallet_session::Config {
		/// The overarching runtime event type.
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>>
			+ IsType<<Self as frame_system::Config>::RuntimeEvent>;

		/// Origin allowed to add or remove a validator. In cogno-chain this is the shared
		/// `AuthorityOrigin` (M5, DR-07): `EnsureRoot`/sudo OR a 3-of-5 `FollowerCommittee`
		/// supermajority. It stays an `EnsureOrigin` so the graduation to an Ariadne/SPO
		/// selection pallet (`L3-chain.md` §8.3) is a signature-free swap.
		type AddRemoveOrigin: EnsureOrigin<Self::RuntimeOrigin>;

		/// Minimum number of validators the active set may never drop below on removal. The hard
		/// floor that stops the operator stranding the chain at zero authorities (it does NOT make
		/// finality safe at low counts — see the module docs / `L3-chain.md` §8.1).
		#[pallet::constant]
		type MinAuthorities: Get<u32>;

		/// The maximum size of the validator set (`validators-3`). MUST be `<=` the runtime's
		/// aura/grandpa `MaxAuthorities`, or a rotation would hand `> MaxAuthorities` authorities to
		/// the consensus pallets and they would SILENTLY truncate the set (storage here disagreeing
		/// with the live authority set). `add_validator` rejects growth beyond it with
		/// `TooManyValidators` instead, and `Validators` is a `BoundedVec` of this size.
		#[pallet::constant]
		type MaxValidators: Get<u32>;

		/// Weight information for this pallet's dispatchables.
		type WeightInfo: WeightInfo;
	}

	#[pallet::pallet]
	#[pallet::without_storage_info]
	pub struct Pallet<T>(_);

	/// The current validator set — the to-be-applied set the [`pallet_session::SessionManager`]
	/// hands to `pallet-session` each rotation. (The *active* set is `pallet_session::Validators`;
	/// this one leads it by up to ~2 sessions, the queue/apply latency.)
	#[pallet::storage]
	#[pallet::getter(fn validators)]
	pub type Validators<T: Config> =
		StorageValue<_, BoundedVec<T::ValidatorId, T::MaxValidators>, ValueQuery>;

	/// Validators marked for auto-removal by a future `pallet-im-online` offence report. Inert in
	/// v1 (nothing reports offences); drained in `new_session` when `pallet-im-online` is wired.
	#[pallet::storage]
	#[pallet::getter(fn offline_validators)]
	pub type OfflineValidators<T: Config> =
		StorageValue<_, BoundedVec<T::ValidatorId, T::MaxValidators>, ValueQuery>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// New validator addition initiated. Effective at the next-but-one session boundary
		/// (~2 sessions: queued, then applied). The per-action audit trail.
		ValidatorAdditionInitiated(T::ValidatorId),

		/// Validator removal initiated. Effective at the next-but-one session boundary.
		ValidatorRemovalInitiated(T::ValidatorId),
	}

	#[pallet::error]
	pub enum Error<T> {
		/// The target (post-removal) validator count is below [`Config::MinAuthorities`].
		TooLowValidatorCount,
		/// The validator is already in the validator set.
		Duplicate,
		/// Adding the validator would push the set above [`Config::MaxValidators`] (the consensus
		/// `MaxAuthorities` bound), which would silently truncate the authority set (`validators-3`).
		TooManyValidators,
	}

	#[pallet::genesis_config]
	#[derive(DefaultNoBound)]
	pub struct GenesisConfig<T: Config> {
		/// The initial validator set. Must match the `pallet-session` genesis `keys` (every
		/// initial validator needs registered session keys, or it produces no authority).
		pub initial_validators: Vec<T::ValidatorId>,
	}

	#[pallet::genesis_build]
	impl<T: Config> BuildGenesisConfig for GenesisConfig<T> {
		fn build(&self) {
			Pallet::<T>::initialize_validators(&self.initial_validators);
		}
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Add a validator to the set. Gated by [`Config::AddRemoveOrigin`]. The change is applied
		/// at the next-but-one session boundary, never mid-session.
		#[pallet::call_index(0)]
		#[pallet::weight(<T as Config>::WeightInfo::add_validator())]
		pub fn add_validator(
			origin: OriginFor<T>,
			validator_id: T::ValidatorId,
		) -> DispatchResult {
			T::AddRemoveOrigin::ensure_origin(origin)?;
			Self::do_add_validator(validator_id)?;
			Ok(())
		}

		/// Remove a validator from the set. Gated by [`Config::AddRemoveOrigin`]. Refused if it
		/// would drop the set below [`Config::MinAuthorities`]. Applied at a session boundary.
		#[pallet::call_index(1)]
		#[pallet::weight(<T as Config>::WeightInfo::remove_validator())]
		pub fn remove_validator(
			origin: OriginFor<T>,
			validator_id: T::ValidatorId,
		) -> DispatchResult {
			T::AddRemoveOrigin::ensure_origin(origin)?;
			Self::do_remove_validator(validator_id)?;
			Ok(())
		}
	}
}

impl<T: Config> Pallet<T> {
	/// Seat the genesis validator set (idempotent guard: must not already be initialized).
	fn initialize_validators(validators: &[T::ValidatorId]) {
		if !validators.is_empty() {
			if !Validators::<T>::get().is_empty() {
				// Double-initialization (genesis build run twice / a misconfigured chain spec). The
				// assert below aborts the build; log the cause first so the panic is not opaque.
				log::error!(
					target: LOG_TARGET,
					"initialize_validators: refusing to re-seat — the set already holds {} validator(s)",
					Validators::<T>::get().len(),
				);
			}
			assert!(Validators::<T>::get().is_empty(), "Validators are already initialized!");
			let bounded = BoundedVec::<_, T::MaxValidators>::try_from(validators.to_vec())
				.expect("genesis initial_validators exceeds MaxValidators");
			Validators::<T>::put(bounded);
		}
	}

	fn do_add_validator(validator_id: T::ValidatorId) -> DispatchResult {
		let mut validators = Validators::<T>::get();
		if validators.contains(&validator_id) {
			// Idempotent rejection: the caller asked to add an already-seated validator. Visible
			// on-chain only as a DispatchError, so surface the reason in node logs too.
			log::debug!(
				target: LOG_TARGET,
				"add_validator rejected: {:?} already in the set (len={})",
				validator_id,
				validators.len(),
			);
			return Err(Error::<T>::Duplicate.into());
		}
		// BoundedVec `try_push` rejects growth past MaxValidators (validators-3) — the consensus
		// pallets would otherwise silently truncate a set larger than their MaxAuthorities.
		validators.try_push(validator_id.clone()).map_err(|_| {
			// At the consensus MaxAuthorities cap: refusing growth here prevents a silent
			// truncation at the next rotation — an operator should notice they are wedged.
			log::warn!(
				target: LOG_TARGET,
				"add_validator rejected: set at MaxValidators={}, cannot add {:?}",
				T::MaxValidators::get(),
				validator_id,
			);
			Error::<T>::TooManyValidators
		})?;
		Validators::<T>::put(validators);
		log::debug!(target: LOG_TARGET, "add_validator: queued {:?} for the next session boundary", validator_id);
		Self::deposit_event(Event::ValidatorAdditionInitiated(validator_id));
		Ok(())
	}

	fn do_remove_validator(validator_id: T::ValidatorId) -> DispatchResult {
		let mut validators = Validators::<T>::get();
		// Never let the *target* count fall below the floor (saturating: removing from an
		// already-at-floor set is rejected, and the subtraction can't underflow).
		if (validators.len().saturating_sub(1) as u32) < T::MinAuthorities::get() {
			// Floor guard: refusing this removal is what stops an operator stranding the chain
			// at < MinAuthorities — worth a warn so a stuck shrink is visible.
			log::warn!(
				target: LOG_TARGET,
				"remove_validator rejected: removing {:?} would drop the set to {} < MinAuthorities={}",
				validator_id,
				validators.len().saturating_sub(1),
				T::MinAuthorities::get(),
			);
			return Err(Error::<T>::TooLowValidatorCount.into());
		}
		let before = validators.len();
		validators.retain(|v| *v != validator_id);
		if validators.len() == before {
			// `retain` silently succeeds even if the target was never in the set: the removal is a
			// no-op but the call still returns Ok and emits the event. Make the no-op observable so
			// a misconfigured caller (e.g. a SessionManager removing a stale id) is not invisible.
			log::warn!(
				target: LOG_TARGET,
				"remove_validator: {:?} was not in the set; removal is a no-op (len unchanged at {})",
				validator_id,
				before,
			);
		} else {
			log::debug!(
				target: LOG_TARGET,
				"remove_validator: queued {:?} for removal at the next session boundary (len {}->{})",
				validator_id,
				before,
				validators.len(),
			);
		}
		Validators::<T>::put(validators);
		Self::deposit_event(Event::ValidatorRemovalInitiated(validator_id));
		Ok(())
	}

	/// Mark a validator for auto-removal at the next session (im-online path; inert in v1).
	fn mark_for_removal(validator_id: T::ValidatorId) {
		// Best-effort: the offline set is a subset of the validator set so it cannot legitimately
		// overflow MaxValidators; the `try_push` Result is intentionally ignored (inert in v1).
		OfflineValidators::<T>::mutate(|v| match v.try_push(validator_id.clone()) {
			Ok(()) => log::debug!(
				target: LOG_TARGET,
				"mark_for_removal: queued offline validator {:?} (offline queue len now {})",
				validator_id,
				v.len(),
			),
			// The offline queue is bounded by MaxValidators; an overflow means the queue is already
			// full of distinct ids, which should not happen if it is a subset of the live set. Drop
			// the mark but make the lost report visible to an operator.
			Err(_) => log::warn!(
				target: LOG_TARGET,
				"mark_for_removal: offline queue full (MaxValidators={}); dropped {:?}",
				T::MaxValidators::get(),
				validator_id,
			),
		});
	}

	/// Drain the offline queue into a removal at the next session boundary (im-online path).
	/// A no-op in v1 (the queue is always empty), so `new_session` does not churn storage.
	fn remove_offline_validators() {
		let validators_to_remove = OfflineValidators::<T>::get();
		if validators_to_remove.is_empty() {
			return;
		}
		log::debug!(
			target: LOG_TARGET,
			"remove_offline_validators: draining {} offline validator(s) {:?} from the set",
			validators_to_remove.len(),
			validators_to_remove.to_vec(),
		);
		Validators::<T>::mutate(|vs| vs.retain(|v| !validators_to_remove.contains(v)));
		OfflineValidators::<T>::kill();
	}
}

/// Hand the current validator set to `pallet-session` each rotation. `pallet-session` queues it for
/// one session, then enacts it (feeding `pallet-aura`/`pallet-grandpa` via their session handlers).
impl<T: Config> pallet_session::SessionManager<T::ValidatorId> for Pallet<T> {
	fn new_session(new_index: u32) -> Option<Vec<T::ValidatorId>> {
		// Drain any im-online-flagged offline validators (inert in v1) before publishing the set.
		Self::remove_offline_validators();
		let published = Self::validators().into_inner();
		log::debug!(
			target: LOG_TARGET,
			"new_session(index={}): publishing {} validator(s) {:?}",
			new_index,
			published.len(),
			published,
		);
		Some(published)
	}

	fn end_session(_end_index: u32) {}

	fn start_session(_start_index: u32) {}
}

impl<T: Config> EstimateNextSessionRotation<BlockNumberFor<T>> for Pallet<T> {
	fn average_session_length() -> BlockNumberFor<T> {
		Zero::zero()
	}

	fn estimate_current_session_progress(
		_now: BlockNumberFor<T>,
	) -> (Option<sp_runtime::Permill>, Weight) {
		(None, Weight::zero())
	}

	fn estimate_next_session_rotation(
		_now: BlockNumberFor<T>,
	) -> (Option<BlockNumberFor<T>>, Weight) {
		(None, Weight::zero())
	}
}

/// Identity conversion `ValidatorId -> Option<ValidatorId>`. Used as `pallet-session`'s
/// `ValidatorIdOf` in the runtime (where `ValidatorId == AccountId`), so any account is its own
/// validator id (eligibility is gated by `add_validator`, not by this conversion).
pub struct ValidatorOf<T>(core::marker::PhantomData<T>);

impl<T: Config> Convert<T::ValidatorId, Option<T::ValidatorId>> for ValidatorOf<T> {
	fn convert(account: T::ValidatorId) -> Option<T::ValidatorId> {
		Some(account)
	}
}

impl<T: Config> ValidatorSet<T::ValidatorId> for Pallet<T> {
	type ValidatorId = T::ValidatorId;
	type ValidatorIdOf = ValidatorOf<T>;

	fn session_index() -> sp_staking::SessionIndex {
		pallet_session::Pallet::<T>::current_index()
	}

	fn validators() -> Vec<T::ValidatorId> {
		// The *active* set (what `pallet-session` currently enacts), not this pallet's pending set.
		pallet_session::Pallet::<T>::validators()
	}
}

impl<T: Config> ValidatorSetWithIdentification<T::ValidatorId> for Pallet<T> {
	type Identification = T::ValidatorId;
	type IdentificationOf = ValidatorOf<T>;
}

/// The im-online offence sink (dormant in v1): a reported offender is queued for auto-removal at the
/// next session. Wired only when `pallet-im-online` is added (`L3-chain.md` §8.2).
impl<T: Config, O: Offence<(T::ValidatorId, T::ValidatorId)>>
	ReportOffence<T::AccountId, (T::ValidatorId, T::ValidatorId), O> for Pallet<T>
{
	fn report_offence(_reporters: Vec<T::AccountId>, offence: O) -> Result<(), OffenceError> {
		let offenders = offence.offenders();
		for (v, _) in offenders.into_iter() {
			Self::mark_for_removal(v);
		}
		Ok(())
	}

	fn is_known_offence(
		_offenders: &[(T::ValidatorId, T::ValidatorId)],
		_time_slot: &O::TimeSlot,
	) -> bool {
		false
	}
}
