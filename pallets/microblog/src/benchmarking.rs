//! Benchmarking for `pallet-microblog` (DR-05).
//!
//! Generates real `WeightInfo` for the **load-bearing feeless post path** — capacity is the only
//! anti-spam, so these weights back the block-weight backstop (`posts_per_block_max`,
//! `L3-chain.md` §5.4). `post_message` is length-parameterized over `0..MaxLength` (the linear
//! `s` component) and benchmarked end-to-end through the **real** runtime identity gate via the
//! [`IsAllowed::benchmark_set_allowed`] setup hook (the `whitelisted_caller` is otherwise unbound
//! and would be rejected `NotAllowed`). Capacity is consumed in `CheckCapacity::post_dispatch`,
//! not the call body, so the body benchmark needs no charged battery; the gate's two reads
//! (`AllowedStake`, `Capacity`) are measured separately via `current_capacity`/`consume` cost.

use super::*;
#[allow(unused)]
use crate::Pallet as Microblog;
use frame_benchmarking::v2::*;
use frame_support::{
	traits::{EnsureOrigin, Get},
	BoundedVec,
};
use frame_system::RawOrigin;

#[benchmarks]
mod benchmarks {
	use super::*;

	/// `post_message` of `s` text bytes (`0..=MaxLength`), through the real identity gate.
	#[benchmark]
	fn post_message(s: Linear<0, { T::MaxLength::get() }>) -> Result<(), BenchmarkError> {
		let caller: T::AccountId = whitelisted_caller();
		// Admit the caller through the REAL gate (CognoGate in the runtime; no-op in the mock).
		T::IdentityGate::benchmark_set_allowed(&caller);
		let text = alloc::vec![0u8; s as usize];

		#[extrinsic_call]
		_(RawOrigin::Signed(caller.clone()), text, None);

		assert_eq!(NextPostId::<T>::get(), 1);
		assert!(Posts::<T>::contains_key(0u64));
		Ok(())
	}

	/// `delete_post` of a post the caller authored (seeded directly in storage).
	#[benchmark]
	fn delete_post() -> Result<(), BenchmarkError> {
		let caller: T::AccountId = whitelisted_caller();
		let text: BoundedVec<u8, T::MaxLength> =
			alloc::vec![0u8; 1].try_into().expect("1 < MaxLength; qed");
		let at = frame_system::Pallet::<T>::block_number();
		Posts::<T>::insert(0u64, Post::<T> { author: caller.clone(), text, parent: None, at });
		ByAuthor::<T>::try_mutate(&caller, |ids| ids.try_push(0u64))
			.expect("empty index has room; qed");
		NextPostId::<T>::put(1u64);

		#[extrinsic_call]
		_(RawOrigin::Signed(caller.clone()), 0u64);

		assert!(!Posts::<T>::contains_key(0u64));
		Ok(())
	}

	/// The `CheckCapacity` transaction-extension hot path (DR-05 / `L3-chain.md` §5.4): the reads
	/// `validate()` performs (`AllowedStake` + `Capacity`, via `current_capacity`) plus the
	/// `Capacity` write `consume()` performs in `post_dispatch`. Worst case: a bound, weighted,
	/// charged account (populated rows). This backs the extension's real `weight()`, so the
	/// feeless post path's FULL cost (call body + this gate) lands in the block-weight backstop.
	#[benchmark]
	fn check_capacity() {
		let who: T::AccountId = whitelisted_caller();
		pallet_talk_stake::AllowedStake::<T>::insert(&who, 1_000_000u128);
		let now = frame_system::Pallet::<T>::block_number();
		Capacity::<T>::insert(
			&who,
			CapacityState { cap_last: 1_000_000u128, last_block: now },
		);
		let cost = Microblog::<T>::post_cost(T::MaxLength::get());

		#[block]
		{
			// Exactly what validate() reads then what post_dispatch() consumes.
			let _ = Microblog::<T>::current_capacity(&who, now);
			Microblog::<T>::consume(&who, now, cost);
		}

		assert!(Capacity::<T>::get(&who).is_some());
	}

	/// `force_set_capacity` (gated by `ForceOrigin`); exercises `on_first_bind` + the row write.
	#[benchmark]
	fn force_set_capacity() -> Result<(), BenchmarkError> {
		let who: T::AccountId = whitelisted_caller();
		let origin =
			T::ForceOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;

		#[extrinsic_call]
		_(origin as T::RuntimeOrigin, who.clone(), 1_000_000u128);

		assert!(Capacity::<T>::contains_key(&who));
		Ok(())
	}

	impl_benchmark_test_suite!(Microblog, crate::mock::new_test_ext(), crate::mock::Test);
}
