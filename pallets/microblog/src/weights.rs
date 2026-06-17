//! Weights for `pallet-microblog`.
//!
//! ⚑ M0 placeholder weights — hand-set, NOT benchmarked. Real `WeightInfo` from FRAME
//! benchmarking is DR-05 (a later milestone); these dev-grade constants are fine for
//! `--dev` and the fee-bearing M0 posting path. `post_message` is length-parameterized so
//! the signature already matches the future benchmarked one (no call-site change later).

#![cfg_attr(rustfmt, rustfmt_skip)]
#![allow(unused_parens)]
#![allow(unused_imports)]

use frame_support::{traits::Get, weights::{Weight, constants::RocksDbWeight}};
use core::marker::PhantomData;

/// Weight functions needed for `pallet_microblog`.
pub trait WeightInfo {
	fn post_message(s: u32) -> Weight;
	fn delete_post() -> Weight;
	fn force_set_capacity() -> Weight;
}

/// Weights using the runtime's configured `DbWeight`.
///
/// `post_message`: reads `NextPostId` + `ByAuthor` (+ the 2 `CheckCapacity` reads at validate);
/// writes `Posts` + `ByAuthor` + `NextPostId` (+ the `Capacity` write at post-dispatch).
/// `delete_post`: reads `Posts`; writes `Posts` + `ByAuthor`.
/// `force_set_capacity`: reads `Capacity`; writes `Capacity` (+ provider ref on first touch).
pub struct SubstrateWeight<T>(PhantomData<T>);
impl<T: frame_system::Config> WeightInfo for SubstrateWeight<T> {
	fn post_message(s: u32) -> Weight {
		Weight::from_parts(20_000_000, 0)
			.saturating_add(Weight::from_parts(2_000, 0).saturating_mul(s as u64))
			.saturating_add(T::DbWeight::get().reads(4_u64))
			.saturating_add(T::DbWeight::get().writes(4_u64))
	}
	fn delete_post() -> Weight {
		Weight::from_parts(15_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(1_u64))
			.saturating_add(T::DbWeight::get().writes(2_u64))
	}
	fn force_set_capacity() -> Weight {
		Weight::from_parts(12_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(1_u64))
			.saturating_add(T::DbWeight::get().writes(2_u64))
	}
}

// For tests / mock (uses RocksDb weights directly).
impl WeightInfo for () {
	fn post_message(s: u32) -> Weight {
		Weight::from_parts(20_000_000, 0)
			.saturating_add(Weight::from_parts(2_000, 0).saturating_mul(s as u64))
			.saturating_add(RocksDbWeight::get().reads(4_u64))
			.saturating_add(RocksDbWeight::get().writes(4_u64))
	}
	fn delete_post() -> Weight {
		Weight::from_parts(15_000_000, 0)
			.saturating_add(RocksDbWeight::get().reads(1_u64))
			.saturating_add(RocksDbWeight::get().writes(2_u64))
	}
	fn force_set_capacity() -> Weight {
		Weight::from_parts(12_000_000, 0)
			.saturating_add(RocksDbWeight::get().reads(1_u64))
			.saturating_add(RocksDbWeight::get().writes(2_u64))
	}
}
