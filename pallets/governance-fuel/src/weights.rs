//! Weights for `pallet-governance-fuel`.
//!
//! Hand-estimated (DB-weight-based) placeholders — the real FRAME benchmark is a DEPLOY step (run
//! `benchmark pallet --pallet pallet_governance_fuel` on representative hardware and swap the runtime's
//! `WeightInfo` from `()` to a generated `SubstrateWeight<Runtime>`), exactly like
//! `pallet-governed-upgrade`'s placeholder. The estimates below are deliberately CONSERVATIVE so the
//! `on_initialize` regeneration hook never under-charges the block:
//!   - `set_allowance`: read+write `Allowances`, read balance, `mint_into` (1 read + 1 write), write
//!     `TotalMinted`.
//!   - `revoke`: read+write `Allowances`, read balance, `burn_from` (1 read + 1 write), write `TotalRevoked`.
//!   - `regenerate(n)`: read `Allowances` once, then per funded account read the balance + `mint_into`
//!     (1 read + 1 write), plus one `TotalMinted` write. Linear in `n` (`n <= MaxFundedAccounts`).

use frame_support::weights::{constants::RocksDbWeight, Weight};

/// Weight functions needed for `pallet-governance-fuel`.
pub trait WeightInfo {
    fn set_allowance() -> Weight;
    fn revoke() -> Weight;
    fn regenerate(n: u32) -> Weight;
}

/// Conservative placeholder estimates (used by the runtime until real benchmarks are generated, and by
/// the mock). Replace with a benchmarked `SubstrateWeight<T>` at deploy time.
impl WeightInfo for () {
    fn set_allowance() -> Weight {
        Weight::from_parts(20_000_000, 0)
            .saturating_add(RocksDbWeight::get().reads(2_u64))
            .saturating_add(RocksDbWeight::get().writes(3_u64))
    }

    fn revoke() -> Weight {
        Weight::from_parts(20_000_000, 0)
            .saturating_add(RocksDbWeight::get().reads(2_u64))
            .saturating_add(RocksDbWeight::get().writes(3_u64))
    }

    fn regenerate(n: u32) -> Weight {
        // Base: read `Allowances` (+ a possible `TotalMinted` write on a non-empty tick).
        let base = Weight::from_parts(5_000_000, 0)
            .saturating_add(RocksDbWeight::get().reads(1_u64))
            .saturating_add(RocksDbWeight::get().writes(1_u64));
        // Per funded account: read the balance + `mint_into` (1 read + 1 write).
        let per = Weight::from_parts(4_000_000, 0)
            .saturating_add(RocksDbWeight::get().reads(1_u64))
            .saturating_add(RocksDbWeight::get().writes(1_u64));
        base.saturating_add(per.saturating_mul(n as u64))
    }
}
