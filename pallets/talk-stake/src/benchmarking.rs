//! Benchmarking for `pallet-talk-stake` (DR-05).
//!
//! `set_stake` is a single `AllowedStake` map write behind the gated `SetStakeOrigin`. The
//! origin is obtained via `try_successful_origin` so the benchmark is correct whether the
//! runtime wires `EnsureRoot` (v1 dev) or the `EitherOfDiverse<EnsureRoot, k-of-t>` of DR-07.

use super::*;
#[allow(unused)]
use crate::Pallet as TalkStake;
use frame_benchmarking::v2::*;
use frame_support::traits::EnsureOrigin;

#[benchmarks]
mod benchmarks {
	use super::*;

	#[benchmark]
	fn set_stake() -> Result<(), BenchmarkError> {
		let who: T::AccountId = whitelisted_caller();
		let origin =
			T::SetStakeOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;
		let weight: StakeWeight = 100_000_000;

		#[extrinsic_call]
		_(origin as T::RuntimeOrigin, who.clone(), weight);

		assert_eq!(AllowedStake::<T>::get(&who), weight);
		Ok(())
	}

	impl_benchmark_test_suite!(TalkStake, crate::mock::new_test_ext(), crate::mock::Test);
}
