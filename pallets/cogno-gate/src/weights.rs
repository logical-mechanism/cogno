//! Weights for `pallet-cogno-gate`.
//!
//! ⚑ Hand-set dev-grade weights, NOT benchmarked (real `WeightInfo` is DR-05, a later
//! milestone). `link_identity` is a handful of map writes + the microblog `on_first_bind`
//! hook (capacity row + provider ref) behind a gated origin; `revoke` is a few map removes.

#![cfg_attr(rustfmt, rustfmt_skip)]
#![allow(unused_parens)]
#![allow(unused_imports)]

use frame_support::{traits::Get, weights::{Weight, constants::RocksDbWeight}};
use core::marker::PhantomData;

/// Weight functions needed for `pallet_cogno_gate`.
pub trait WeightInfo {
	fn link_identity() -> Weight;
	fn revoke() -> Weight;
}

/// Weights using the runtime's configured `DbWeight`.
pub struct SubstrateWeight<T>(PhantomData<T>);
impl<T: frame_system::Config> WeightInfo for SubstrateWeight<T> {
	fn link_identity() -> Weight {
		// PkhOf + AccountOf (+ optional ThreadOf) inserts + the microblog row/provider writes.
		Weight::from_parts(20_000_000, 0)
			.saturating_add(T::DbWeight::get().reads_writes(2_u64, 4_u64))
	}
	fn revoke() -> Weight {
		Weight::from_parts(15_000_000, 0)
			.saturating_add(T::DbWeight::get().reads_writes(1_u64, 3_u64))
	}
}

// For tests / mock.
impl WeightInfo for () {
	fn link_identity() -> Weight {
		Weight::from_parts(20_000_000, 0)
			.saturating_add(RocksDbWeight::get().reads_writes(2_u64, 4_u64))
	}
	fn revoke() -> Weight {
		Weight::from_parts(15_000_000, 0)
			.saturating_add(RocksDbWeight::get().reads_writes(1_u64, 3_u64))
	}
}
