//! Weights for `pallet-cardano-roles`.
//!
//! These are CONSERVATIVE hand-set values, not FRAME-benchmarked ones (a testnet-first choice —
//! see the repo posture). Each function is priced as a COMPUTE floor plus an explicit
//! `RocksDbWeight` term for the storage ops its dispatch body actually performs (counted from
//! lib.rs) — the same `DbWeight` the runtime configures, so the declared weight can never
//! under-count the database no matter what the compute guess misses. A MAINNET PREREQUISITE is to
//! replace these with `frame-benchmarking` results (mirroring `pallet-cogno-gate`'s bench).

use frame_support::weights::{constants::RocksDbWeight, Weight};

/// Weight functions needed for `pallet-cardano-roles`.
pub trait WeightInfo {
    fn claim_role_signed() -> Weight;
    fn unclaim_role() -> Weight;
    fn revoke_role() -> Weight;
    fn revoke_role_many(n: u32) -> Weight;
}

/// The conservative default used by the runtime until benchmarks land, and by the test mock.
impl WeightInfo for () {
    fn claim_role_signed() -> Weight {
        // COMPUTE floor: the audited CIP-8 path (ed25519_verify + blake2b + COSE parse) — the same
        // class of work cogno-gate's MEASURED link_identity_signed prices at 67_850_000 ref_time
        // (pallets/cogno-gate/src/weights.rs), so 80M sits above the measured sibling.
        // DB: 6 reads (System::BlockHash(0), CognoGate::PkhOf via the IdentityGate,
        // TombstonedRoleCred, RoleClaimOf, RoleCredIndex, SpentRoleNonce) + 3 writes (SpentRoleNonce,
        // RoleClaimOf, RoleCredIndex). SpentRoleNonce is the single-use guard that stops a third party
        // replaying an accepted proof after the holder unclaims.
        Weight::from_parts(80_000_000, 8_000)
            .saturating_add(RocksDbWeight::get().reads(6))
            .saturating_add(RocksDbWeight::get().writes(3))
    }
    fn unclaim_role() -> Weight {
        // COMPUTE floor: ensure_signed + event. DB: 1 read + 2 writes (RoleClaimOf::take,
        // RoleCredIndex::remove).
        Weight::from_parts(20_000_000, 4_000)
            .saturating_add(RocksDbWeight::get().reads(1))
            .saturating_add(RocksDbWeight::get().writes(2))
    }
    fn revoke_role() -> Weight {
        // COMPUTE floor: origin check + event. DB: 1 read + 3 writes (RoleClaimOf::take,
        // RoleCredIndex::remove, TombstonedRoleCred::insert).
        Weight::from_parts(25_000_000, 4_000)
            .saturating_add(RocksDbWeight::get().reads(1))
            .saturating_add(RocksDbWeight::get().writes(3))
    }
    fn revoke_role_many(n: u32) -> Weight {
        // One origin check and one summary event, plus the FULL per-target cost of `revoke_role` for
        // each of `n` targets — the same 1 read + 3 writes and the same compute floor, since
        // `revoke_role_many` runs the identical `do_revoke_role` body per target and emits the same
        // per-target `RoleRevoked`. Pricing the batch at anything less than n × the single verb would
        // under-declare it by construction.
        //
        // `saturating_mul` on the u64 counts rather than on the `Weight`, so a nonsense `n` saturates
        // the multiplier instead of wrapping into a small weight.
        let n = n as u64;
        Weight::from_parts(10_000_000, 4_000)
            .saturating_add(Weight::from_parts(25_000_000u64.saturating_mul(n), 0))
            .saturating_add(RocksDbWeight::get().reads(n))
            .saturating_add(RocksDbWeight::get().writes(3u64.saturating_mul(n)))
    }
}
