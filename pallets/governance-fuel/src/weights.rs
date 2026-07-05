//! Weights for `pallet-governance-fuel`.
//!
//! Hand-estimated (DB-weight-based) placeholders — the real FRAME benchmark is a DEPLOY step (run
//! `benchmark pallet --pallet pallet_governance_fuel` on representative hardware and swap the runtime's
//! `WeightInfo` from `()` to a generated `SubstrateWeight<Runtime>`), exactly like
//! `pallet-governed-upgrade`'s placeholder. The estimates below are deliberately CONSERVATIVE so the
//! Mandatory `on_initialize` regeneration hook never under-charges the block. CRUCIALLY, each
//! `fungible::Mutate::mint_into` / `burn_from` writes BOTH the account AND `TotalIssuance` (2 writes),
//! so per-account costs count 2 writes, not 1:
//!   - `set_allowance`: read+write `Allowances`, read balance, `mint_into` (1 read + 2 writes), write
//!     `TotalMinted`.
//!   - `revoke`: read+write `Allowances`, read balance, `burn_from` (1 read + 2 writes), write `TotalRevoked`.
//!   - `regenerate(n)`: read `Allowances` once + one `TotalMinted` write, then per funded account read the
//!     balance + `mint_into` (1 read + 2 writes). Linear in `n` (`n <= MaxFundedAccounts`).

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
        // Allowances r+w, balance r, mint_into (account + TotalIssuance) w×2, TotalMinted w.
        Weight::from_parts(20_000_000, 0)
            .saturating_add(RocksDbWeight::get().reads(2_u64))
            .saturating_add(RocksDbWeight::get().writes(4_u64))
    }

    fn revoke() -> Weight {
        // Allowances r+w, balance r, burn_from (account + TotalIssuance) w×2, TotalRevoked w.
        Weight::from_parts(20_000_000, 0)
            .saturating_add(RocksDbWeight::get().reads(2_u64))
            .saturating_add(RocksDbWeight::get().writes(4_u64))
    }

    fn regenerate(n: u32) -> Weight {
        // Base: read `Allowances` + one `TotalMinted` write on a non-empty tick.
        let base = Weight::from_parts(5_000_000, 0)
            .saturating_add(RocksDbWeight::get().reads(1_u64))
            .saturating_add(RocksDbWeight::get().writes(1_u64));
        // Per funded account: read the balance + `mint_into` (account + TotalIssuance = 2 writes).
        let per = Weight::from_parts(4_000_000, 0)
            .saturating_add(RocksDbWeight::get().reads(1_u64))
            .saturating_add(RocksDbWeight::get().writes(2_u64));
        base.saturating_add(per.saturating_mul(n as u64))
    }
}
