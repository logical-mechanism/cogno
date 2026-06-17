//! Weights for `pallet-anchor`.
//!
//! ⚑ Hand-set dev-grade weights, NOT benchmarked (real `WeightInfo` is DR-05, a later milestone).
//! `anchor_ack` is one storage read (`LastCheckpoint`) + at most one write behind a gated origin.

#![cfg_attr(rustfmt, rustfmt_skip)]
#![allow(unused_parens)]
#![allow(unused_imports)]

use frame_support::{traits::Get, weights::{Weight, constants::RocksDbWeight}};
use core::marker::PhantomData;

/// Weight functions needed for `pallet_anchor`.
pub trait WeightInfo {
	fn anchor_ack() -> Weight;
}

/// Weights using the runtime's configured `DbWeight`.
pub struct SubstrateWeight<T>(PhantomData<T>);
impl<T: frame_system::Config> WeightInfo for SubstrateWeight<T> {
	fn anchor_ack() -> Weight {
		// 1 read (LastCheckpoint, for the monotonicity check) + 1 write (the new checkpoint).
		Weight::from_parts(15_000_000, 0)
			.saturating_add(T::DbWeight::get().reads_writes(1_u64, 1_u64))
	}
}

// For tests / mock.
impl WeightInfo for () {
	fn anchor_ack() -> Weight {
		Weight::from_parts(15_000_000, 0)
			.saturating_add(RocksDbWeight::get().reads_writes(1_u64, 1_u64))
	}
}
