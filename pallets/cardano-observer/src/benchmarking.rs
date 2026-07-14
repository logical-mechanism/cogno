//! Benchmarking for `pallet-cardano-observer`.
//!
//! `observe` is the chain's SOLE weight writer and runs as a `DispatchClass::Mandatory` inherent in EVERY
//! block, so its weight function has to cover the whole worst case rather than the common one. Four
//! components, two from the call and two from storage:
//!
//! - `n` = `entries.len()` — the vault credit loop (resolve → settle → apply → event, per entry).
//! - `m` = `stake_entries.len()` — the voting-power credit loop.
//! - `p` = `LastObserved` length — the vault unlock-clamp basis (decode, index, clear-write per entry).
//! - `q` = `LastObservedStake` length — the voting-power unlock-clamp basis.
//!
//! `p`/`q` are not derivable from the arguments: a mass unlock is precisely the case where the current
//! observation is small (or empty) and the previous set is full.
//!
//! Three things make the seeded state the real worst case and not the common one:
//!
//! 1. Every credited entry carries a CHANGED weight, so the runtime's `WeightSink`/`VotingPowerSink` take
//!    the write branch (settle + apply + event) instead of the `previous == weight` no-op fast path.
//! 2. The clamp bases are DISJOINT from the current set, so all `p` + `q` of them are cleared — each a
//!    full settle + zero-write, not a skip.
//! 3. `EnforceWeight` is `true`: frozen, the sinks write nothing at all.
//!
//! The pallet reaches cogno-gate / talk-stake / microblog only through trait seams (no Cargo cycle), so it
//! cannot bind a beacon itself; [`crate::BenchmarkSetup`] is the runtime-side hook that seeds those rows.

use super::*;
#[allow(unused)]
use crate::Pallet as CardanoObserver;
use frame_benchmarking::v2::*;
use frame_support::{
    traits::{EnsureOrigin, Get},
    BoundedVec,
};
use frame_system::RawOrigin;

/// Index offset for the unlock-clamp identities. Their beacons, credentials and accounts all derive from
/// the index, so a disjoint range is what makes them disjoint from the current observation — and therefore
/// what makes every one of them fall out of the current set and get cleared.
const CLAMP_BASE: u32 = 1_000_000;

/// The 32-byte beacon for index `i`, big-endian so the set is ASCENDING — the canonical order the real
/// `cogno-dbsync` reduction produces, and the order the clamp's `BTreeSet` build actually sees.
fn beacon(i: u32) -> BeaconName {
    let mut b = [0u8; 32];
    b[..4].copy_from_slice(&i.to_be_bytes());
    b
}

/// The 28-byte stake credential for index `i` (ascending, as above).
fn stake_cred(i: u32) -> StakeCredential {
    let mut c = [0u8; 28];
    c[..4].copy_from_slice(&i.to_be_bytes());
    c
}

#[benchmarks]
mod benchmarks {
    use super::*;

    /// ⚠ The `Linear` upper bounds MUST equal the runtime `MaxObserved` (and the mock sets the same bound):
    /// a `Linear` needs a literal, so it cannot read `T::MaxObserved::get()`. If `MaxObserved` moves, move
    /// these with it — a range short of the bound would under-cover the real per-block cost of the sole
    /// weight writer, and a range past it makes the seeding fail (`BoundedVec` overflow).
    #[benchmark]
    fn observe(
        n: Linear<0, 1024>,
        m: Linear<0, 1024>,
        p: Linear<0, 1024>,
        q: Linear<0, 1024>,
    ) -> Result<(), BenchmarkError> {
        let min_lock = T::MinLock::get();
        // Every observed value differs from the weight `BenchmarkSetup` seeds (`min_lock`), so no entry can
        // take the sink's no-op branch; and all of them sit far below `MaxStakeWeight`/`MaxVotingPower`, so
        // none is SKIPPED by the cap guard (a skip is a `continue` — the cheap path).
        let observed = |i: u32| min_lock.saturating_add(1u128.saturating_add(i as u128));

        // The current vault set: `n` bound identities, all with a changed weight.
        let mut entries: BoundedVec<(BeaconName, u128), T::MaxObserved> = BoundedVec::new();
        for i in 0..n {
            let b = beacon(i);
            T::BenchmarkSetup::bench_bind_beacon(&b, i);
            entries
                .try_push((b, observed(i)))
                .map_err(|_| BenchmarkError::Stop("n exceeds MaxObserved"))?;
        }

        // The current stake set: `m` bound credentials, all with a changed voting power.
        let mut stake_entries: BoundedVec<(StakeCredential, u128), T::MaxObserved> =
            BoundedVec::new();
        for i in 0..m {
            let c = stake_cred(i);
            T::BenchmarkSetup::bench_bind_stake_cred(&c, i);
            stake_entries
                .try_push((c, observed(i)))
                .map_err(|_| BenchmarkError::Stop("m exceeds MaxObserved"))?;
        }

        // The unlock-clamp bases: `p`/`q` previously-credited identities, disjoint from the current set and
        // each holding a nonzero weight — so every one of them is settled and zeroed. The clamp reads its
        // account straight out of the basis (no resolver lookup), so what has to be seeded here is the
        // weight state the zero-write overwrites.
        let mut prev: BoundedVec<(BeaconName, T::AccountId), T::MaxObserved> = BoundedVec::new();
        for i in CLAMP_BASE..CLAMP_BASE.saturating_add(p) {
            T::BenchmarkSetup::bench_bind_beacon(&beacon(i), i);
            prev.try_push((beacon(i), T::BenchmarkSetup::bench_account(i)))
                .map_err(|_| BenchmarkError::Stop("p exceeds MaxObserved"))?;
        }
        LastObserved::<T>::put(prev);

        let mut vp_prev: BoundedVec<(StakeCredential, T::AccountId), T::MaxObserved> =
            BoundedVec::new();
        for i in CLAMP_BASE..CLAMP_BASE.saturating_add(q) {
            T::BenchmarkSetup::bench_bind_stake_cred(&stake_cred(i), i);
            vp_prev
                .try_push((stake_cred(i), T::BenchmarkSetup::bench_account(i)))
                .map_err(|_| BenchmarkError::Stop("q exceeds MaxObserved"))?;
        }
        LastObservedStake::<T>::put(vp_prev);

        // Enforcing is the default AND the expensive mode; frozen, both sinks are skipped entirely.
        EnforceWeight::<T>::put(true);
        // A prior reference, so the anti-regression read is a HIT as it is in production.
        LastReference::<T>::put(CardanoRef {
            slot: 1,
            block_hash: [1u8; 32],
        });
        // `BenchmarkSetup` stamps each capacity row at the current block, and the microblog sink only
        // settles a bucket whose `last_block != now`. Without advancing, every settle would take the
        // early-return branch and the credit/clamp writes would be under-counted.
        let start = frame_system::Pallet::<T>::block_number();
        frame_system::Pallet::<T>::set_block_number(start + 1u32.into());

        #[extrinsic_call]
        _(
            RawOrigin::None,
            CardanoRef {
                slot: 2,
                block_hash: [2u8; 32],
            },
            [0u8; 32],
            entries,
            stake_entries,
        );

        // The clamp basis is now the current set: every one of the `p`/`q` seeded identities was cleared.
        assert_eq!(LastObserved::<T>::decode_len().unwrap_or(0), n as usize);
        assert_eq!(
            LastObservedStake::<T>::decode_len().unwrap_or(0),
            m as usize
        );
        Ok(())
    }

    /// The emergency weight-freeze flip: one storage write + one event, behind the gated `EnforceOrigin`
    /// (obtained via `try_successful_origin`, so this is correct whether the runtime wires the 3-of-5
    /// committee or the mock wires `EnsureRoot`).
    #[benchmark]
    fn set_enforcement() -> Result<(), BenchmarkError> {
        let origin =
            T::EnforceOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;

        #[extrinsic_call]
        _(origin as T::RuntimeOrigin, false);

        assert!(!EnforceWeight::<T>::get());
        Ok(())
    }

    impl_benchmark_test_suite!(
        CardanoObserver,
        crate::mock::new_test_ext(),
        crate::mock::Test
    );
}
