//! Weights for `pallet-talk-stake`.
//!
//! ⚑ Hand-set dev-grade weights, NOT benchmarked (real `WeightInfo` is DR-05, a later
//! milestone). `set_stake` is a single map write behind a gated origin.

#![cfg_attr(rustfmt, rustfmt_skip)]
#![allow(unused_parens)]
#![allow(unused_imports)]

use frame_support::{traits::Get, weights::{Weight, constants::RocksDbWeight}};
use core::marker::PhantomData;

/// Weight functions needed for `pallet_talk_stake`.
pub trait WeightInfo {
	fn set_stake() -> Weight;
}

/// Weights using the runtime's configured `DbWeight`.
pub struct SubstrateWeight<T>(PhantomData<T>);
impl<T: frame_system::Config> WeightInfo for SubstrateWeight<T> {
	fn set_stake() -> Weight {
		Weight::from_parts(10_000_000, 0)
			.saturating_add(T::DbWeight::get().writes(1_u64))
	}
}

// For tests / mock.
impl WeightInfo for () {
	fn set_stake() -> Weight {
		Weight::from_parts(10_000_000, 0)
			.saturating_add(RocksDbWeight::get().writes(1_u64))
	}
}
