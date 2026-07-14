//! Weights for `pallet-cardano-observer`.
//!
//! ⚠ These are hand-estimated PLACEHOLDERS, not FRAME benchmarks, and they under-count the real cost
//! of `observe` by a wide margin. It gets away with it because `observe` is `DispatchClass::Mandatory`
//! (an inherent): its weight is accounted but does not gate the block against the normal limit. Anyone
//! sizing block capacity from these numbers will be wrong. Benchmarking the sole weight writer is the
//! obvious next step here.

use frame_support::weights::Weight;

pub trait WeightInfo {
    fn observe(n: u32) -> Weight;
    fn set_enforcement() -> Weight;
}

/// A fixed base + a per-observed-entry increment. Replace with a benchmarked `SubstrateWeight<T>`.
impl WeightInfo for () {
    fn observe(n: u32) -> Weight {
        Weight::from_parts(10_000_000, 0)
            .saturating_add(Weight::from_parts(2_000_000, 0).saturating_mul(n as u64))
            .saturating_add(Weight::from_parts(0, 0))
    }
    /// A single storage write (`EnforceWeight`) + one event — a cheap, constant governance flip.
    fn set_enforcement() -> Weight {
        Weight::from_parts(10_000_000, 0)
    }
}
