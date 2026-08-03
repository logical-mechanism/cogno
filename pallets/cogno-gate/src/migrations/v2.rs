//! Storage migration **v1 → v2** (spec 220): enrol every bound account in the observer's scan rotation.
//!
//! Spec 220 turns the observer's per-block credential scan from a hash-ordered PREFIX of the ledger
//! into a rotating WINDOW over it, so that per-block work stays bounded while coverage becomes complete
//! within a bounded number of blocks. The window reads a dense slot table — `ScanSlotCount`,
//! `AccountAtScanSlot`, `ScanSlotOf` — that is maintained from here on by `do_bind` / `do_revoke`.
//!
//! Every account bound BEFORE the upgrade has no slot, and there is no way to derive one lazily: an
//! account outside the table is in no window, and since spec 220 an out-of-window basis row is HELD
//! rather than cleared, so an un-enrolled account would keep whatever voting power it last had for ever
//! and could never gain any it earned later. The whole live ledger is in exactly that state at the
//! moment of the upgrade, which is why this migration is not optional.
//!
//! Enrolment order is `PkhOf`'s hash order. That is arbitrary but deterministic — every node runs this
//! identical computation over identical state — and it does not need to be fair: the rotation covers
//! every slot each sweep, so a starting position is worth nothing. It is only NEW arrivals that must
//! not be able to pick their position, and those go to the tail by construction.

use crate::{AccountAtScanSlot, Config, Pallet, PkhOf, ScanSlotCount, ScanSlotOf};
#[cfg(feature = "try-runtime")]
use alloc::vec::Vec;
#[cfg(feature = "try-runtime")]
use codec::{Decode, Encode};
use frame_support::{
    migrations::VersionedMigration,
    traits::{Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
};

#[cfg(feature = "try-runtime")]
use frame_support::ensure;

/// Ceiling on accounts enrolled in the one block this migration runs in. Two writes each, so this is
/// ~8k writes at the limit — heavy but survivable in a Mandatory `on_runtime_upgrade`. The live chain
/// is three orders of magnitude below it; the bound exists so a single-block migration cannot run a
/// block past its budget, not because the count is expected to approach it.
///
/// Overrunning it is NOT silently tolerable, unlike a cleanup sweep's leftovers: an un-enrolled account
/// is invisible to every scan window for ever. `post_upgrade` fails on it, which is what the mandatory
/// `try-runtime` dry-run against live state is for.
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
        for who in PkhOf::<T>::iter_keys() {
            walked = walked.saturating_add(1);
            if ScanSlotOf::<T>::contains_key(&who) {
                continue; // already enrolled — never a second slot
            }
            if enrolled >= MAX_ACCOUNTS {
                break;
            }
            AccountAtScanSlot::<T>::insert(slot, &who);
            ScanSlotOf::<T>::insert(&who, slot);
            slot = slot.saturating_add(1);
            enrolled = enrolled.saturating_add(1);
        }
        ScanSlotCount::<T>::put(slot);
        if enrolled >= MAX_ACCOUNTS {
            log::error!(
                target: crate::LOG_TARGET,
                "migration v1->v2: more than {MAX_ACCOUNTS} bound accounts — {enrolled} enrolled in \
                 the scan rotation, the rest are NOT and will never be observed. post_upgrade fails.",
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
