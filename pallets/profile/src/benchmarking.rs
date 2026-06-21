//! Benchmarking for `pallet-profile`.
//!
//! `set_profile` is benchmarked at the worst case (name/bio/avatar filled to their max lengths) and
//! through the REAL identity gate via the [`pallet_microblog::IsAllowed::benchmark_set_allowed`]
//! setup hook (the `whitelisted_caller` is otherwise unbound and would be rejected `NotAllowed`).

use super::*;
use frame_benchmarking::v2::*;
use frame_support::{traits::Get, BoundedVec};
use frame_system::RawOrigin;
use pallet_microblog::IsAllowed;
// Alias the pallet as `ProfilePallet` (NOT `Profile` — that's the storage struct name; aliasing the
// pallet to `Profile` would shadow the struct used in the `clear_profile` setup below).
#[allow(unused)]
use crate::Pallet as ProfilePallet;

#[benchmarks]
mod benchmarks {
	use super::*;

	#[benchmark]
	fn set_profile() -> Result<(), BenchmarkError> {
		let caller: T::AccountId = whitelisted_caller();
		// Admit the caller through the REAL gate (CognoGate in the runtime; no-op in the mock).
		T::IdentityGate::benchmark_set_allowed(&caller);
		let name = alloc::vec![0u8; T::MaxName::get() as usize];
		let bio = alloc::vec![0u8; T::MaxBio::get() as usize];
		let avatar = alloc::vec![0u8; T::MaxAvatar::get() as usize];

		#[extrinsic_call]
		_(RawOrigin::Signed(caller.clone()), name, bio, avatar);

		assert!(Profiles::<T>::contains_key(&caller));
		Ok(())
	}

	#[benchmark]
	fn clear_profile() -> Result<(), BenchmarkError> {
		let caller: T::AccountId = whitelisted_caller();
		T::IdentityGate::benchmark_set_allowed(&caller);
		// Seed a profile to clear.
		let name: BoundedVec<u8, T::MaxName> =
			alloc::vec![0u8; 1].try_into().expect("1 < MaxName; qed");
		let bio: BoundedVec<u8, T::MaxBio> = Default::default();
		let avatar: BoundedVec<u8, T::MaxAvatar> = Default::default();
		Profiles::<T>::insert(&caller, Profile::<T> { display_name: name, bio, avatar });

		#[extrinsic_call]
		_(RawOrigin::Signed(caller.clone()));

		assert!(!Profiles::<T>::contains_key(&caller));
		Ok(())
	}

	#[benchmark]
	fn pin_post() -> Result<(), BenchmarkError> {
		let caller: T::AccountId = whitelisted_caller();
		T::IdentityGate::benchmark_set_allowed(&caller);

		#[extrinsic_call]
		_(RawOrigin::Signed(caller.clone()), 7u64);

		assert_eq!(PinnedPost::<T>::get(&caller), Some(7u64));
		Ok(())
	}

	#[benchmark]
	fn unpin_post() -> Result<(), BenchmarkError> {
		let caller: T::AccountId = whitelisted_caller();
		PinnedPost::<T>::insert(&caller, 7u64);

		#[extrinsic_call]
		_(RawOrigin::Signed(caller.clone()));

		assert!(!PinnedPost::<T>::contains_key(&caller));
		Ok(())
	}

	impl_benchmark_test_suite!(ProfilePallet, crate::mock::new_test_ext(), crate::mock::Test);
}
