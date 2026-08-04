//! Storage migration **v1 → v2** (spec 220): enrol every bound account in the observer's scan rotation.
//!
//! Spec 220 turns the observer's per-block credential scan from a hash-ordered PREFIX of the ledger
//! into a rotating WINDOW over it, so that per-block work stays bounded while coverage becomes complete
//! within a bounded number of blocks. The window reads a dense slot table — `ScanSlotCount`,
//! `AccountAtScanSlot`, `ScanSlotOf` — that is maintained from here on by `do_bind` / `do_revoke`.
//!
//! Every account bound BEFORE the upgrade has no slot, and there is no way to derive one lazily: an
//! account outside the table is in no window at all.
//!
//! ⚠ AND THAT IS A WIPE, NOT A FREEZE — the distinction is the whole reason this migration is not
//! optional, and getting it backwards is what would let a future reader tolerate a partial run. An
//! out-of-window basis row is HELD only while the account is still ENROLLED (`ScanCoverage::Deferred`).
//! An account with no slot at all reads `ScanCoverage::Absent`, and `derive_call` clears an `Absent`
//! row ON SIGHT — deliberately, because a row no future window can reach would otherwise be held for
//! ever. So an un-enrolled account does not keep its last voting power: it is ZEROED on the block
//! after the upgrade and loses every role badge with it. The whole live ledger is in exactly that
//! state at the moment of the upgrade.
//!
//! Since spec 221 that wipe is RECOVERABLE where it used to be permanent. An enrolment walk that
//! cannot finish inside this block hands its resume point to `crate::RotationBackfillCursor`, and
//! `Pallet::drain_rotation_backfill` finishes the job out of `on_idle` over the following blocks; a
//! re-enrolled account lands back in a window and the next observation's forward pass re-credits it
//! from db-sync, because its basis row is empty and its desired set is not. What is NOT recoverable is
//! anything a `close_poll` froze into a `PollResult` while the account was uncredited.
//!
//! Enrolment order is `PkhOf`'s hash order. That is arbitrary but deterministic — every node runs this
//! identical computation over identical state — and it does not need to be fair: the rotation covers
//! every slot each sweep, so a starting position is worth nothing. It is only NEW arrivals that must
//! not be able to pick their position, and those go to the tail by construction.

use crate::{
    AccountAtScanSlot, Config, Pallet, PkhOf, RotationBackfillCursor, ScanSlotCount, ScanSlotOf,
};
#[cfg(feature = "try-runtime")]
use alloc::vec::Vec;
#[cfg(feature = "try-runtime")]
use codec::{Decode, Encode};
use frame_support::{
    migrations::VersionedMigration,
    traits::{ConstU32, Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
    BoundedVec,
};

#[cfg(feature = "try-runtime")]
use frame_support::ensure;

/// Ceiling on accounts enrolled in the one block this migration runs in. Two writes each, so this is
/// ~8k writes at the limit — about 1.0 s of a 2 s block at `RocksDbWeight`, heavy but survivable in an
/// `on_runtime_upgrade` (whose weight goes through `register_extra_weight_unchecked` and cannot fail
/// the block). The live chain is three orders of magnitude below it; the bound exists so a
/// single-block migration cannot run a block past its budget, not because the count is expected to
/// approach it.
///
/// ⚠ OVERRUNNING IT USED TO BE SILENT IN PRODUCTION AND PERMANENT. Silent: the only production signal
/// is the `log::error!`, since `post_upgrade`'s `ensure!` is `#[cfg(feature = "try-runtime")]` and is
/// compiled out of the runtime that actually enacts. Permanent: the tail was not merely un-enrolled, it
/// was wiped — see the module docs — and `ScanSlotCount` and the storage version commit either way, so
/// a second run could not finish the job.
///
/// Spec 221 fixed the permanent half. An overrun now writes
/// [`crate::RotationBackfillCursor`] and `Pallet::drain_rotation_backfill` enrols the rest out of
/// `on_idle`, a bounded batch a block, until the walk is exhausted. The tail is still cleared on the
/// block after the upgrade — `ScanCoverage::Absent` means clear-on-sight and teaching it otherwise
/// would make a committee ban hold weight for the whole backfill — but the clear is now TRANSIENT: the
/// account is re-enrolled within `ceil(stranded / BACKFILL_BATCH)` blocks and the next observation's
/// forward pass re-credits it from db-sync.
///
/// Still run the pre-enactment `try-runtime` dry-run against LIVE state (docs/UPGRADES.md), and against
/// a FRESH snapshot: `link_identity_signed` is feeless and bare-unsigned (~1 ms each, so a few thousand
/// fit in a handful of blocks), `apply_authorized_upgrade` is permissionless, and enrolment order is
/// `PkhOf`'s grindable `Blake2_128Concat` hash order — so who lands past the cap, and therefore who
/// spends a few minutes uncredited, is chooseable by whoever floods.
///
/// ⚠ RAISING THIS IS NOT THE FIX, and neither is panicking on the overrun: a panic in
/// `on_runtime_upgrade` makes the enacting block unproducible, which is unrecoverable on a chain whose
/// only upgrade path needs a block to land in.
const MAX_ACCOUNTS: u64 = 4_096;

/// The unchecked inner migration wrapped by [`MigrateV1ToV2`]. Register `MigrateV1ToV2` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV1ToV2<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV1ToV2<T> {
    fn on_runtime_upgrade() -> Weight {
        // Start from whatever the table already holds rather than from zero. It is empty on every real
        // chain reaching this migration, but appending is the only form that cannot corrupt a
        // partially-populated table into two accounts sharing a slot.
        let mut slot = ScanSlotCount::<T>::get();
        let mut walked = 0u64;
        let mut enrolled = 0u64;
        // Whether the walk STOPPED at the cap, as distinct from finishing with `enrolled` happening to
        // equal it. Testing `enrolled >= MAX_ACCOUNTS` after the loop cannot tell those apart, and on a
        // chain with exactly `MAX_ACCOUNTS` bound accounts — a complete, correct run — it would log the
        // chain-is-wiped error. The one number an operator reads has to be right about that.
        let mut truncated = false;
        // The resume point handed to the `on_idle` drain if the walk stops early: the raw `PkhOf` key
        // of the last account this pass REACHED. Recorded on every step rather than only on enrolment,
        // because an already-enrolled account still has to be walked past.
        let mut last_key: Option<BoundedVec<u8, ConstU32<128>>> = None;
        for who in PkhOf::<T>::iter_keys() {
            if enrolled >= MAX_ACCOUNTS {
                truncated = true;
                break;
            }
            walked = walked.saturating_add(1);
            last_key = BoundedVec::try_from(PkhOf::<T>::hashed_key_for(&who)).ok();
            if ScanSlotOf::<T>::contains_key(&who) {
                continue; // already enrolled — never a second slot
            }
            AccountAtScanSlot::<T>::insert(slot, &who);
            ScanSlotOf::<T>::insert(&who, slot);
            slot = slot.saturating_add(1);
            enrolled = enrolled.saturating_add(1);
        }
        ScanSlotCount::<T>::put(slot);
        if truncated {
            // Hand the rest to `Pallet::drain_rotation_backfill`. `None` here would be a walk that
            // truncated without reaching a single account, which cannot happen (`enrolled` only reaches
            // the cap by walking), but if it somehow did then leaving the cursor unset is the wrong
            // failure — so fall back to restarting the walk from the beginning, which is correct and
            // merely re-walks the accounts that already hold a slot.
            RotationBackfillCursor::<T>::put(last_key.unwrap_or_default());
            log::error!(
                target: crate::LOG_TARGET,
                "migration v1->v2: more than {MAX_ACCOUNTS} bound accounts — {enrolled} enrolled in \
                 the scan rotation now, the rest are queued for the on_idle backfill drain and will \
                 be enrolled over the next few blocks. Their voting power and role badges are ZEROED \
                 until then. post_upgrade fails: verify the drain completes before trusting the ledger.",
            );
        } else {
            log::info!(
                target: crate::LOG_TARGET,
                "migration v1->v2: enrolled {enrolled} account(s) in the scan rotation \
                 ({walked} walked)",
            );
        }
        // Per account walked: one `PkhOf` key read plus one `ScanSlotOf` probe; per account enrolled,
        // two writes. Plus the single `ScanSlotCount` read/write.
        T::DbWeight::get().reads_writes(
            walked.saturating_mul(2).saturating_add(1),
            enrolled.saturating_mul(2).saturating_add(1),
        )
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        let bound = PkhOf::<T>::iter_keys().count() as u64;
        log::info!(
            target: crate::LOG_TARGET,
            "migration v1->v2 pre: {bound} bound account(s) to enrol; the table holds {} slot(s)",
            ScanSlotCount::<T>::get(),
        );
        Ok(bound.encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let bound = u64::decode(&mut &state[..]).map_err(|_| {
            sp_runtime::TryRuntimeError::Other("cogno-gate v2: bad pre_upgrade state")
        })?;
        let count = ScanSlotCount::<T>::get();
        // The count is what `scan_window` wraps on, so it is the number that has to be right. Checking
        // it against the PRE-upgrade bound count also catches the overrun above, which is the one
        // failure here that would otherwise be silent and permanent.
        ensure!(
            count == bound,
            "cogno-gate v2: the scan rotation does not hold every bound account"
        );
        for slot in 0..count {
            let who = AccountAtScanSlot::<T>::get(slot)
                .ok_or("cogno-gate v2: the scan rotation has a hole below its count")?;
            ensure!(
                ScanSlotOf::<T>::get(&who) == Some(slot),
                "cogno-gate v2: the scan rotation's two maps are not each other's inverse"
            );
        }
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV1ToV2`] on `Pallet`'s storage version moving 1 → 2.
/// Idempotent — it runs only when the on-chain version is exactly 1, then writes 2. A fresh genesis
/// writes the declared version directly, so this self-skips there.
pub type MigrateV1ToV2<T> = VersionedMigration<
    1,
    2,
    InnerMigrateV1ToV2<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::{new_test_ext, Test};
    use alloc::collections::BTreeSet;
    use frame_support::traits::{GetStorageVersion, OnRuntimeUpgrade, StorageVersion};

    fn account(i: u64) -> <Test as frame_system::Config>::AccountId {
        i
    }

    #[test]
    fn v1_to_v2_enrols_every_bound_account_exactly_once_and_is_idempotent() {
        new_test_ext().execute_with(|| {
            StorageVersion::new(1).put::<Pallet<Test>>();
            for i in 1u64..=7 {
                PkhOf::<Test>::insert(account(i), [i as u8; 32]);
            }

            let _ = MigrateV1ToV2::<Test>::on_runtime_upgrade();

            assert_eq!(ScanSlotCount::<Test>::get(), 7);
            // Dense over [0, 7), and a bijection — the two properties `scan_window` relies on.
            let mut seen = BTreeSet::new();
            for slot in 0..7u64 {
                let who = AccountAtScanSlot::<Test>::get(slot).expect("no hole below the count");
                assert_eq!(ScanSlotOf::<Test>::get(who), Some(slot));
                assert!(seen.insert(who), "an account holds two slots");
            }
            assert_eq!(seen.len(), 7);
            assert_eq!(Pallet::<Test>::on_chain_storage_version(), 2);

            // Re-running is a no-op: the version guard skips it, and even unguarded the
            // already-enrolled check would.
            let _ = MigrateV1ToV2::<Test>::on_runtime_upgrade();
            assert_eq!(ScanSlotCount::<Test>::get(), 7);
        });
    }

    /// A complete run owes the drain nothing — the steady state on every real chain.
    #[test]
    fn a_complete_run_leaves_no_backfill_cursor() {
        new_test_ext().execute_with(|| {
            StorageVersion::new(1).put::<Pallet<Test>>();
            for i in 1u64..=7 {
                PkhOf::<Test>::insert(account(i), [i as u8; 32]);
            }
            let _ = MigrateV1ToV2::<Test>::on_runtime_upgrade();
            assert!(crate::RotationBackfillCursor::<Test>::get().is_none());
        });
    }

    /// The overrun, end to end. `MAX_ACCOUNTS` is 4_096 and a test that bound that many would be
    /// unbearable, so this drives the resumable machinery directly: enrol a prefix by hand, leave a
    /// cursor as a truncated migration would, and assert the drain finishes the job across blocks and
    /// lands on the exact invariants `scan_window` depends on.
    #[test]
    fn an_overrun_backfill_is_finished_by_the_idle_drain() {
        new_test_ext().execute_with(|| {
            StorageVersion::new(2).put::<Pallet<Test>>();
            const N: u64 = 200;
            for i in 1..=N {
                PkhOf::<Test>::insert(account(i), [i as u8; 32]);
            }
            // Stand in for a migration that enrolled the first account and stopped.
            let first = PkhOf::<Test>::iter_keys().next().expect("a bound account");
            AccountAtScanSlot::<Test>::insert(0u64, first);
            ScanSlotOf::<Test>::insert(first, 0u64);
            ScanSlotCount::<Test>::put(1u64);
            crate::RotationBackfillCursor::<Test>::put(
                frame_support::BoundedVec::try_from(PkhOf::<Test>::hashed_key_for(first))
                    .expect("a PkhOf key fits 128 bytes"),
            );

            // Drain with a generous idle budget: bounded by BACKFILL_BATCH, never by the weight.
            let mut blocks = 0u32;
            while crate::RotationBackfillCursor::<Test>::get().is_some() {
                let _ = Pallet::<Test>::drain_rotation_backfill(Weight::from_parts(
                    u64::MAX / 2,
                    u64::MAX / 2,
                ));
                blocks += 1;
                assert!(blocks < 100, "the drain is not converging");
            }
            // Enough blocks to have actually paged, not one big bite.
            assert!(blocks >= (N - 1).div_ceil(crate::BACKFILL_BATCH as u64) as u32);

            assert_eq!(ScanSlotCount::<Test>::get(), N);
            let mut seen = BTreeSet::new();
            for slot in 0..N {
                let who = AccountAtScanSlot::<Test>::get(slot).expect("no hole below the count");
                assert_eq!(ScanSlotOf::<Test>::get(who), Some(slot));
                assert!(seen.insert(who), "an account holds two slots");
            }
            assert_eq!(seen.len(), N as usize, "every bound account is enrolled");
        });
    }

    /// The steady state has to be nearly free: the drain runs in `on_idle` on EVERY block of the
    /// chain's life, and only the handful after an overrun have anything to do.
    #[test]
    fn the_drain_is_one_read_when_nothing_is_owed() {
        new_test_ext().execute_with(|| {
            for i in 1u64..=5 {
                PkhOf::<Test>::insert(account(i), [i as u8; 32]);
            }
            let spent = Pallet::<Test>::drain_rotation_backfill(Weight::from_parts(
                u64::MAX / 2,
                u64::MAX / 2,
            ));
            let db: frame_support::weights::RuntimeDbWeight =
                <Test as frame_system::Config>::DbWeight::get();
            assert_eq!(spent, db.reads(1));
            assert_eq!(ScanSlotCount::<Test>::get(), 0, "nothing was enrolled");
        });
    }

    /// `on_idle` hands out whatever the block did not spend, which on a busy block is nothing. The
    /// drain must yield rather than overspend — it is the lowest-priority work on the chain.
    #[test]
    fn the_drain_yields_when_there_is_no_idle_weight() {
        new_test_ext().execute_with(|| {
            PkhOf::<Test>::insert(account(1), [1u8; 32]);
            crate::RotationBackfillCursor::<Test>::put(frame_support::BoundedVec::<
                u8,
                frame_support::traits::ConstU32<128>,
            >::default());

            let spent = Pallet::<Test>::drain_rotation_backfill(Weight::zero());

            let db: frame_support::weights::RuntimeDbWeight =
                <Test as frame_system::Config>::DbWeight::get();
            assert_eq!(spent, db.reads(1));
            assert_eq!(ScanSlotCount::<Test>::get(), 0, "nothing was enrolled");
            assert!(
                crate::RotationBackfillCursor::<Test>::get().is_some(),
                "the work is still owed — a starved block must not look like a finished backfill",
            );
        });
    }

    /// The upgrade boundary the whole migration exists for: an account bound before spec 220 must end
    /// up inside a scan window, because since spec 220 being outside every window means holding stale
    /// weight for ever rather than being re-derived next block.
    #[test]
    fn an_account_bound_before_the_upgrade_lands_in_a_scan_window() {
        new_test_ext().execute_with(|| {
            StorageVersion::new(1).put::<Pallet<Test>>();
            for i in 1u64..=3 {
                PkhOf::<Test>::insert(account(i), [i as u8; 32]);
            }
            assert!(Pallet::<Test>::scan_window(0, 64).is_empty());

            let _ = MigrateV1ToV2::<Test>::on_runtime_upgrade();

            let window: BTreeSet<_> = Pallet::<Test>::scan_window(0, 64).into_iter().collect();
            assert_eq!(window, (1u64..=3).collect::<BTreeSet<_>>());
        });
    }
}
