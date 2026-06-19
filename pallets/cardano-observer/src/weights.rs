//! Weights for `pallet-cardano-observer`.
//!
//! Placeholder weights for now — the real FRAME benchmarks are a later step (the DR-05 discipline).
//! The `observe` call is `DispatchClass::Mandatory` (an inherent), so its weight does not gate the
//! block against the normal weight limit; a coarse per-entry estimate keeps the accounting honest.

use frame_support::weights::Weight;

pub trait WeightInfo {
	fn observe(n: u32) -> Weight;
}

/// Placeholder: a fixed base + a per-observed-entry increment, with a couple of storage reads/writes
/// (`LastReference`/`LastObserved`). Replace with a benchmarked `SubstrateWeight<T>` in a later step.
impl WeightInfo for () {
	fn observe(n: u32) -> Weight {
		Weight::from_parts(10_000_000, 0)
			.saturating_add(Weight::from_parts(2_000_000, 0).saturating_mul(n as u64))
			.saturating_add(Weight::from_parts(0, 0))
	}
}
