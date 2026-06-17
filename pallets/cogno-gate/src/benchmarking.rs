//! Benchmarking for `pallet-cogno-gate` (DR-05).
//!
//! `link_identity` and `revoke` are both `FollowerOrigin`-gated. We benchmark the **worst case**
//! of each: `link_identity` with a thread pointer present (so it also writes `ThreadOf` and runs
//! the `OnBind` → `on_first_bind` provider/capacity priming), and `revoke` after a prior bind (so
//! it actually removes the maps). The origin is taken via `try_successful_origin`, correct under
//! both `EnsureRoot` (v1 dev) and the DR-07 `EitherOfDiverse<EnsureRoot, k-of-t>` widen.

use super::*;
use crate::Pallet as CognoGate;
use frame_benchmarking::v2::*;
use frame_support::traits::EnsureOrigin;

#[benchmarks]
mod benchmarks {
	use super::*;

	#[benchmark]
	fn link_identity() -> Result<(), BenchmarkError> {
		let account: T::AccountId = whitelisted_caller();
		let identity: IdentityHash = [1u8; 32];
		let thread = alloc::vec![0u8; 10]; // worst case: also writes ThreadOf
		let origin =
			T::FollowerOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;

		#[extrinsic_call]
		_(origin as T::RuntimeOrigin, identity, account.clone(), Some(thread));

		assert!(PkhOf::<T>::contains_key(&account));
		Ok(())
	}

	#[benchmark]
	fn revoke() -> Result<(), BenchmarkError> {
		let account: T::AccountId = whitelisted_caller();
		let identity: IdentityHash = [2u8; 32];
		// Seed a binding (with a thread pointer) to revoke.
		let setup =
			T::FollowerOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;
		CognoGate::<T>::link_identity(setup, identity, account.clone(), Some(alloc::vec![0u8; 10]))
			.map_err(|_| BenchmarkError::Stop("link_identity setup failed"))?;
		let origin =
			T::FollowerOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;

		#[extrinsic_call]
		_(origin as T::RuntimeOrigin, account.clone());

		assert!(!PkhOf::<T>::contains_key(&account));
		Ok(())
	}

	impl_benchmark_test_suite!(CognoGate, crate::mock::new_test_ext(), crate::mock::Test);
}
