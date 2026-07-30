//! Benchmarking for `pallet-cardano-observer`.
//!
//! `observe` is the chain's SOLE weight writer and runs as a `DispatchClass::Mandatory` inherent in EVERY
//! block, so its weight function has to cover the whole worst case rather than the common one. Three
//! components, one per axis, ALL taken from the call:
//!
//! - `n` = `changes.len()` — the vault axis (resolve → settle → apply → basis write, per change).
//! - `m` = `stake_changes.len()` — the voting-power axis.
//! - `r` = `role_changes.len()` — the role axis, each carrying an account's full badge set.
//!
//! It used to need four, two of which came from STORAGE (`LastObserved` / `LastObservedStake` lengths),
//! because the body re-scanned the entire previously-observed set every block to find the identities that
//! had dropped out — so a block with an empty observation and a full previous set was the most expensive
//! one there was, and no argument said so. Spec 215 made an unlock an ordinary `(key, None)` change that
//! costs what any other change costs, so the arguments now describe the whole cost.
//!
//! Three things make the seeded state the real worst case and not the common one:
//!
//! 1. Every credited change carries a CHANGED weight, so the runtime's `WeightSink`/`VotingPowerSink` take
//!    the write branch (settle + apply + event) instead of the `previous == weight` no-op fast path.
//! 2. Every role change carries a FULL `MaxRolesPerAccount` set, the largest value the basis can store.
//! 3. `EnforceWeight` is `true`: frozen, the sinks and the basis writes are all skipped.
//!
//! The `Some(..)` (credit) and `None` (unlock) branches cost the same in storage — a credit does one
//! resolver read where an unlock does one basis read, and both then settle, write and touch the basis — so
//! the components are swept over credits, which additionally pay the floor and cap comparisons.
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

/// The upper bound of every `Linear` component on `observe`, and the SINGLE knob for it — the components
/// below are declared `Linear<0, MAX_CHANGES>`, not `Linear<0, 256>`, so there is no second literal to
/// forget. It MUST equal the runtime's (and the mock's) `MaxChangesPerBlock`; a `Linear` bound is a const
/// generic, so it can be a named const but NOT `T::MaxChangesPerBlock::get()`, which is why the coupling has
/// to be asserted at run time rather than checked by the compiler. `observe` asserts it.
///
/// A range short of the real bound would under-cover the per-block cost of the sole weight writer (the one
/// call in the chain that can never be skipped); a range past it makes the benchmark's seeding fail with a
/// `BoundedVec` overflow.
const MAX_CHANGES: u32 = 256;

/// The 32-byte beacon for index `i`, big-endian so the set is ASCENDING — the canonical order the real
/// `cogno-dbsync` reduction produces, and the order `derive_call` sorts a page into.
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

/// The 28-byte role display id for `(account index, slot)` — distinct per entry so a full per-account set
/// is `MaxRolesPerAccount` DIFFERENT badges rather than one deduped down to a single row.
fn role_id(i: u32, k: u32) -> RoleCredential {
    let mut c = [0u8; 28];
    c[..4].copy_from_slice(&i.to_be_bytes());
    c[4..8].copy_from_slice(&k.to_be_bytes());
    c
}

#[benchmarks]
mod benchmarks {
    use super::*;

    /// The three components are bounded by [`MAX_CHANGES`], which MUST equal the runtime
    /// `MaxChangesPerBlock` (and the mock sets the same bound). A `Linear` bound is a const generic: a named
    /// const is fine, but `T::MaxChangesPerBlock::get()` is not — so the compiler cannot check the coupling
    /// and the body asserts it.
    #[benchmark]
    fn observe(
        n: Linear<0, MAX_CHANGES>,
        m: Linear<0, MAX_CHANGES>,
        r: Linear<0, MAX_CHANGES>,
    ) -> Result<(), BenchmarkError> {
        // [`MAX_CHANGES`] is the sole knob for the component bounds above, but nothing makes the RUNTIME
        // agree with it — so assert it. A `MaxChangesPerBlock` bump that forgets this const would fit the
        // sole Mandatory call's weight over a range shorter than reality, silently under-weighting the one
        // call in the chain that can never be skipped. This runs in the real `benchmark pallet` run (against
        // the runtime's value) AND under `impl_benchmark_test_suite!` (against the mock's), so either one
        // drifting from the const is a loud failure rather than a quiet mis-fit.
        assert_eq!(
            T::MaxChangesPerBlock::get(),
            MAX_CHANGES,
            "MaxChangesPerBlock changed: move benchmarking::MAX_CHANGES (which bounds observe's components) with it",
        );

        let min_lock = T::MinLock::get();
        // Every observed value differs from the weight `BenchmarkSetup` seeds (`min_lock`), so no change can
        // take the sink's no-op branch; and all of them sit far below `MaxStakeWeight`/`MaxVotingPower`, so
        // none is SKIPPED by the cap guard (a skip is a `continue` — the cheap path).
        let observed = |i: u32| min_lock.saturating_add(1u128.saturating_add(i as u128));

        // `n` vault credits against bound identities, each with a changed weight.
        let mut changes: BoundedVec<VaultChange, T::MaxChangesPerBlock> = BoundedVec::new();
        for i in 0..n {
            let b = beacon(i);
            T::BenchmarkSetup::bench_bind_beacon(&b, i);
            changes
                .try_push((b, Some(observed(i))))
                .map_err(|_| BenchmarkError::Stop("n exceeds MaxChangesPerBlock"))?;
        }

        // `m` voting-power credits against bound credentials, each with a changed total.
        let mut stake_changes: BoundedVec<StakeChange, T::MaxChangesPerBlock> = BoundedVec::new();
        for i in 0..m {
            let c = stake_cred(i);
            T::BenchmarkSetup::bench_bind_stake_cred(&c, i);
            stake_changes
                .try_push((c, Some(observed(i))))
                .map_err(|_| BenchmarkError::Stop("m exceeds MaxChangesPerBlock"))?;
        }

        // `r` role writes, each carrying a FULL per-account set — the largest value the basis row can hold,
        // so the sink write and the basis write are both at their maximum size. The account comes straight
        // out of the change (the resolve + aggregate happen in `create_inherent`, not here), so no role
        // binding needs seeding.
        let per_account = T::MaxRolesPerAccount::get();
        let mut role_changes: BoundedVec<
            RoleChange<T::AccountId, T::MaxRolesPerAccount>,
            T::MaxChangesPerBlock,
        > = BoundedVec::new();
        for i in 0..r {
            let mut set: BoundedVec<(u8, RoleCredential, u128), T::MaxRolesPerAccount> =
                BoundedVec::new();
            for k in 0..per_account {
                set.try_push((0u8, role_id(i, k), observed(k)))
                    .map_err(|_| BenchmarkError::Stop("role set exceeds MaxRolesPerAccount"))?;
            }
            role_changes
                .try_push(RoleChange {
                    who: T::BenchmarkSetup::bench_account(i),
                    roles: Some(set),
                })
                .map_err(|_| BenchmarkError::Stop("r exceeds MaxChangesPerBlock"))?;
        }

        // Enforcing is the default AND the expensive mode; frozen, every sink and basis write is skipped.
        EnforceWeight::<T>::put(true);
        // A prior reference, so the anti-regression read is a HIT as it is in production.
        LastReference::<T>::put(CardanoRef {
            slot: 1,
            block_hash: [1u8; 32],
        });
        // `BenchmarkSetup` stamps each capacity row at the current block, and the microblog sink only
        // settles a bucket whose `last_block != now`. Without advancing, every settle would take the
        // early-return branch and the credit writes would be under-counted.
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
            changes,
            stake_changes,
            role_changes,
            // Drained: `pending = 0` is the path that also advances `LastReference`, so it costs one more
            // write than a backlogged block. Benchmarking the cheaper branch would under-count.
            0u32,
        );

        // Every change landed in its basis — the proof that the body took the write branch throughout
        // rather than skipping on an unresolvable key or a no-op weight.
        assert_eq!(LastObserved::<T>::iter().count(), n as usize);
        assert_eq!(LastObservedStake::<T>::iter().count(), m as usize);
        assert_eq!(LastObservedRoles::<T>::iter().count(), r as usize);
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
