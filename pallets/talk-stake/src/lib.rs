//! # Talk-stake pallet (cogno-chain)
//!
//! **The weight source for the regenerating talk-capacity meter.** Stores one
//! `StakeWeight` per account — the summed buried lovelace backing that identity's posting
//! allowance (`ECONOMICS.md` §6.1, `L3-chain.md` §4.2). It is written **only** by the
//! `SetStakeOrigin` (the trusted follower in the full system; **`EnsureRoot`/sudo in the
//! M2c dev showcase**, the DR-07 escape hatch — Cardano-sourced weight is M2d).
//!
//! ## Invariants that live here (do not break them)
//! - `set_stake` writes **only** `AllowedStake`, **never** the `Capacity` row (which lives
//!   in `pallet-microblog`). That separation *is* the going-forward-only rule: raising
//!   weight lifts the future `cap`/`rate` immediately, but the bigger bucket still fills
//!   over the window — it never retroactively credits banked capacity (`ECONOMICS.md`
//!   §6.1 part 1).
//! - On **full** unlock the follower writes `weight = 0`; weight is read live, so
//!   `cap = rate = 0` and the next capacity read collapses to `min(0, …) = 0`. The
//!   `Capacity` row is **never deleted** (that lives in microblog), so a relock cannot
//!   re-mint a fresh bucket (`ECONOMICS.md` §6.1 part 2).
//! - `AllowedStake` is `ValueQuery` → an unbound/unlocked account reads `0` for free.

#![cfg_attr(not(feature = "std"), no_std)]

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

pub mod weights;
pub use weights::*;

/// Log target for this pallet's operational diagnostics (off-chain node logs only — the
/// on-chain audit trail is the `StakeSet` event; these logs add operator-visible context on
/// the edge/rejection paths the event stream cannot show, e.g. the *requested* weight that
/// was refused).
pub const LOG_TARGET: &str = "runtime::talk-stake";

/// Summed buried lovelace (curve output) backing one identity's talk capacity.
/// `u128` (lovelace scale; `ECONOMICS.md` §6.1).
pub type StakeWeight = u128;

#[frame_support::pallet]
pub mod pallet {
	use super::*;
	use frame_support::pallet_prelude::*;
	use frame_system::pallet_prelude::*;

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		/// The overarching runtime event type.
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>>
			+ IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// The authority allowed to set stake weight — the follower in the full system, a
		/// single key (+ `EnsureRoot` sudo escape hatch) in v1 dev (DR-07). Same shape as
		/// the future `cogno-gate` `FollowerOrigin`, so the widen to k-of-t is signature-free.
		type SetStakeOrigin: EnsureOrigin<Self::RuntimeOrigin>;
		/// Hard ceiling on a single account's stake weight (`stake-1`). `set_stake` rejects anything
		/// above it with `WeightTooHigh`. Defence-in-depth: the capacity meter already uses saturating
		/// math, but a follower/committee bug must never be able to write an absurd weight (e.g.
		/// `u128::MAX`). Set to the maximum lockable lovelace (no account can back more than the total
		/// ADA supply).
		#[pallet::constant]
		type MaxStakeWeight: Get<StakeWeight>;
		/// Weight information for this pallet's dispatchables.
		type WeightInfo: WeightInfo;
	}

	/// Per-account stake weight. `ValueQuery` → unbound/unlocked reads `0` (so `cap` and
	/// `rate` fall out to zero with no special-casing).
	#[pallet::storage]
	pub type AllowedStake<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, StakeWeight, ValueQuery>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// An account's stake weight was set (idempotent overwrite; reorg-safe re-derive).
		StakeSet { who: T::AccountId, weight: StakeWeight },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// The requested stake weight exceeds [`Config::MaxStakeWeight`] (`stake-1`).
		WeightTooHigh,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Set (overwrite) the stake weight for `who`. Gated by `SetStakeOrigin`.
		///
		/// ⚑ Writes **only** `AllowedStake` — never the `Capacity` row in `pallet-microblog`.
		/// That separation is the going-forward-only rule (`ECONOMICS.md` §6.1): a raise lifts
		/// future `cap`/`rate` but credits no banked capacity; `weight = 0` on unlock clamps
		/// current capacity to zero on the next read without deleting the (relock-safe) row.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::set_stake())]
		pub fn set_stake(
			origin: OriginFor<T>,
			who: T::AccountId,
			weight: StakeWeight,
		) -> DispatchResult {
			// Origin gate: reject anything that is not the SetStakeOrigin. Log the refusal —
			// the framework returns a bare `BadOrigin` with no pallet context, so without this
			// an operator cannot see that an unauthorised key tried to write stake weight.
			if let Err(e) = T::SetStakeOrigin::ensure_origin(origin) {
				log::warn!(
					target: LOG_TARGET,
					"set_stake REJECTED (bad origin): unauthorised caller tried to set who={who:?} weight={weight}",
				);
				return Err(e.into());
			}
			// stake-1: reject an absurd weight up front (defence-in-depth over the saturating meter).
			// `ensure!` would discard the requested value; log it (with the cap) so the off-chain
			// follower/committee debugging a refusal sees *what* it asked for, not just the error code.
			let max = T::MaxStakeWeight::get();
			if weight > max {
				log::warn!(
					target: LOG_TARGET,
					"set_stake REJECTED (WeightTooHigh): who={who:?} requested_weight={weight} > max_allowed={max}",
				);
				return Err(Error::<T>::WeightTooHigh.into());
			}
			let previous = AllowedStake::<T>::get(&who);
			AllowedStake::<T>::insert(&who, weight);
			if weight == 0 {
				// Full unlock: the row stays (relock-safe), capacity clamps to zero on the next read.
				log::debug!(target: LOG_TARGET, "set_stake: who={who:?} UNLOCKED (weight 0); previous={previous}");
			} else if weight == previous {
				// Idempotent re-derive (e.g. a reorg-safe re-observation of the same vault).
				log::debug!(target: LOG_TARGET, "set_stake: who={who:?} weight={weight} unchanged (idempotent re-derive)");
			} else {
				log::debug!(target: LOG_TARGET, "set_stake: who={who:?} weight {previous} -> {weight}");
			}
			Self::deposit_event(Event::StakeSet { who, weight });
			Ok(())
		}
	}
}
