//! Weights for `pallet-cardano-roles`.
//!
//! These are CONSERVATIVE hand-set placeholders, not FRAME-benchmarked values (a testnet-first
//! choice — see the repo posture). `claim_role_signed` dominates: it runs the audited CIP-8
//! `ed25519_verify` + `blake2b` (the same cost as the cogno-gate binds) plus a handful of storage
//! reads/writes; `unclaim_role` / `revoke_role` are a few reads/writes each. A MAINNET PREREQUISITE
//! is to replace these with `frame-benchmarking` results (mirroring `pallet-cogno-gate`'s bench).

use frame_support::weights::Weight;

/// Weight functions needed for `pallet-cardano-roles`.
pub trait WeightInfo {
    fn claim_role_signed() -> Weight;
    fn unclaim_role() -> Weight;
    fn revoke_role() -> Weight;
}

/// The conservative default used by the runtime until benchmarks land, and by the test mock.
impl WeightInfo for () {
    fn claim_role_signed() -> Weight {
        // ed25519_verify (~50M ref_time) + COSE parse + ~3 reads + 2 writes; generous proof_size.
        Weight::from_parts(80_000_000, 8_000)
    }
    fn unclaim_role() -> Weight {
        // ensure_signed + 1 read + 2 removes.
        Weight::from_parts(20_000_000, 4_000)
    }
    fn revoke_role() -> Weight {
        // origin check + 1 read + 2 removes + 1 tombstone write.
        Weight::from_parts(25_000_000, 4_000)
    }
}
