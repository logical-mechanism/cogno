//! Storage migration **v1 → v2** (spec 220): enrol every bound account in the observer's scan rotation.
//!
//! Spec 220 turns the observer's per-block credential scan from a hash-ordered PREFIX of the ledger
//! into a rotating WINDOW over it, so that per-block work stays bounded while coverage becomes complete
//! within a bounded number of blocks. The window reads a dense slot table — `ScanSlotCount`,
//! `AccountAtScanSlot`, `ScanSlotOf` — that is maintained from here on by `do_bind` / `do_revoke`.
//!
//! Every account bound BEFORE the upgrade has no slot, and there is no way to derive one lazily: an
//! account outside the table is in no window ever again.
//!
//! ⚠ AND THAT IS A WIPE, NOT A FREEZE — the distinction is the whole reason this migration is not
//! optional, and getting it backwards is what would let a future reader tolerate a partial run. An
//! out-of-window basis row is HELD only while the account is still ENROLLED (`ScanCoverage::Deferred`).
//! An account with no slot at all reads `ScanCoverage::Absent`, and `derive_call` clears an `Absent`
//! row ON SIGHT — deliberately, because a row no future window can reach would otherwise be held for
//! ever. So an un-enrolled account does not keep its last voting power: it is ZEROED on the block
//! after the upgrade, loses every role badge with it, and can never be re-credited, because
//! `scan_window` cannot return it and `do_bind` will not re-enrol an account that is already bound.
//! The whole live ledger is in exactly that state at the moment of the upgrade.
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
/// ~8k writes at the limit — about 1.0 s of a 2 s block at `RocksDbWeight`, heavy but survivable in an
/// `on_runtime_upgrade` (whose weight goes through `register_extra_weight_unchecked` and cannot fail
/// the block). The live chain is three orders of magnitude below it; the bound exists so a
/// single-block migration cannot run a block past its budget, not because the count is expected to
/// approach it.
///
/// ⚠ OVERRUNNING IT IS SILENT IN PRODUCTION AND PERMANENT, and both halves of that are worth stating
/// plainly because neither is obvious from the code below. Silent: the only production signal is the
/// `log::error!`, since `post_upgrade`'s `ensure!` is `#[cfg(feature = "try-runtime")]` and is compiled
/// out of the runtime that actually enacts. Permanent: the tail is not merely un-enrolled, it is wiped
/// — see the module docs. `ScanSlotCount` and the storage version are committed either way, so a second
/// run cannot finish the job.
///
/// The pre-enactment `try-runtime` dry-run against LIVE state (docs/UPGRADES.md) is therefore the only
/// thing standing between a bind flood and a wiped ledger, and it has to be run against a FRESH
/// snapshot: `link_identity_signed` is feeless and bare-unsigned (~1 ms each, so a few thousand fit in
/// a handful of blocks), `apply_authorized_upgrade` is permissionless, and enrolment order is `PkhOf`'s
/// grindable `Blake2_128Concat` hash order — so who lands past the cap is chooseable by whoever floods.
/// Run the dry-run immediately before `apply`, not days ahead.
///
/// ⚠ RAISING THIS IS NOT THE FIX, and neither is panicking on the overrun: a panic in
/// `on_runtime_upgrade` makes the enacting block unproducible, which is unrecoverable on a chain whose
/// only upgrade path needs a block to land in. The fix is a RESUMABLE backfill (persist the last key,
/// keep enrolling a bounded batch per block until `ScanSlotCount` equals the `PkhOf` count). That is
/// deliberately not folded into the spec that introduces the rotation.
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
        for who in PkhOf::<T>::iter_keys() {
            walked = walked.saturating_add(1);
            if ScanSlotOf::<T>::contains_key(&who) {
                continue; // already enrolled — never a second slot
            }
            if enrolled >= MAX_ACCOUNTS {
                truncated = true;
                break;
            }
            AccountAtScanSlot::<T>::insert(slot, &who);
            ScanSlotOf::<T>::insert(&who, slot);
            slot = slot.saturating_add(1);
            enrolled = enrolled.saturating_add(1);
        }
        ScanSlotCount::<T>::put(slot);
        if truncated {
            log::error!(
                target: crate::LOG_TARGET,
                "migration v1->v2: more than {MAX_ACCOUNTS} bound accounts — {enrolled} enrolled in \
                 the scan rotation, the rest are NOT and never will be. Their voting power and role \
                 badges are ZEROED on the next block and cannot be re-credited. post_upgrade fails.",
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
