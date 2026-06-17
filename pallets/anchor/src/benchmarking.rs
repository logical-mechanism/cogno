//! Benchmarking for `pallet-anchor` (DR-05).
//!
//! `anchor_ack` is gated by `AnchorOrigin` and is idempotent/monotonic. We benchmark the
//! **advance** path (writes `LastCheckpoint` + emits `AnchorAcked`) — strictly heavier than the
//! `AckIgnored` no-op, so it is the worst case. The origin is taken via `try_successful_origin`
//! so the bench is correct under both `EnsureRoot` (v1 dev) and the DR-07 k-of-t widen.

use super::*;
#[allow(unused)]
use crate::Pallet as Anchor;
use frame_benchmarking::v2::*;
use frame_support::traits::EnsureOrigin;
use frame_system::pallet_prelude::BlockNumberFor;

#[benchmarks]
mod benchmarks {
	use super::*;

	#[benchmark]
	fn anchor_ack() -> Result<(), BenchmarkError> {
		let origin =
			T::AnchorOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;
		let block_number: BlockNumberFor<T> = 1u32.into();

		#[extrinsic_call]
		_(origin as T::RuntimeOrigin, block_number, [3u8; 32], [4u8; 32], 7u64, 1_234u64);

		assert!(LastCheckpoint::<T>::get().is_some());
		Ok(())
	}

	impl_benchmark_test_suite!(Anchor, crate::mock::new_test_ext(), crate::mock::Test);
}
