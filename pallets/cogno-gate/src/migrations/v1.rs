//! Storage migration **v0 → v1** (spec 212): remove the retired `ThreadOf` rows.
//!
//! `ThreadOf` (account → the optional cogno_v3 thread pointer) was dropped in spec 211 along with
//! `link_identity_signed`'s `thread_pointer` argument: the pointer was never committed by the CIP-8
//! signed payload, so any submitter of a valid proof could attach an arbitrary one — an authorization
//! break on the crown-jewel path. Deleting the declaration stops anything WRITING it, but it does not
//! touch what is already there: every account that bound with a pointer still has a row, under a
//! prefix nothing declares any more. Those rows would sit in state — and in every state root — for the
//! life of the chain, invisible to `try_state` and to `post_upgrade`, with "do not re-declare the
//! prefix" as their only guard. This deletes them.
//!
//! The prefix is spelled out against the pallet's OWN name (`PalletInfoAccess`), never a literal:
//! `clear_storage_prefix` takes `(pallet, item)` as raw bytes, so a hand-typed `b"CognoGate"` would
//! silently clear nothing if the runtime ever renamed the pallet, and report success while doing it —
//! the same class of self-consistent-against-the-wrong-prefix failure that
//! `pallet_microblog::migrations::v10` was built to avoid.
//!
//! Bounded: one pass, at most [`MAX_ROWS`] removals. `ThreadOf` had at most one row per bound account,
//! so on preprod that is a handful and on a fresh mainnet genesis none at all — but a single-block
//! migration must not be able to run a block past its budget, so the limit is explicit and a leftover
//! cursor is logged as an error and asserted against by `post_upgrade`.

use crate::{Config, Pallet};
// Only the try-runtime hooks and the raw prefix walk build a `Vec`.
#[cfg(any(feature = "try-runtime", test))]
use alloc::vec::Vec;
use frame_support::{
    migrations::VersionedMigration,
    storage::migration::clear_storage_prefix,
    traits::{Get, PalletInfoAccess, UncheckedOnRuntimeUpgrade},
    weights::Weight,
};

#[cfg(feature = "try-runtime")]
use frame_support::ensure;

/// The retired storage item's name, exactly as it was declared.
const THREAD_OF: &[u8] = b"ThreadOf";

/// Ceiling on rows removed in the one block this migration runs in. `ThreadOf` held at most one row
/// per identity-bound account, so the live chain is orders of magnitude below this; the bound exists
/// so the migration can never blow the block weight limit, not because the count is expected to
/// approach it.
const MAX_ROWS: u32 = 1_024;

/// The unchecked inner migration wrapped by [`MigrateV0ToV1`]. Register `MigrateV0ToV1` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV0ToV1<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV0ToV1<T> {
    fn on_runtime_upgrade() -> Weight {
        let pallet = <Pallet<T> as PalletInfoAccess>::name();
        let result = clear_storage_prefix(pallet.as_bytes(), THREAD_OF, b"", Some(MAX_ROWS), None);
        if result.maybe_cursor.is_some() {
            // Above the per-block bound. Not reachable on any real state (see MAX_ROWS), but say so
            // loudly rather than reporting a clean sweep: the storage version moves to 1 regardless,
            // so the remainder would otherwise be orphaned silently. `post_upgrade` fails on this.
            log::error!(
                target: crate::LOG_TARGET,
                "migration v0->v1: more than {MAX_ROWS} retired {}::ThreadOf rows — {} removed, the rest remain",
                pallet, result.unique,
            );
        } else {
            log::info!(
                target: crate::LOG_TARGET,
                "migration v0->v1: removed {} retired {}::ThreadOf row(s)",
                result.unique, pallet,
            );
        }
        // One read + one write per row visited (`backend` counts every key the sweep touched).
        let visited = u64::from(result.backend);
        T::DbWeight::get().reads_writes(visited, visited)
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        let rows = remaining_thread_of_rows::<T>();
        log::info!(
            target: crate::LOG_TARGET,
            "migration v0->v1 pre: {rows} retired ThreadOf row(s) to remove",
        );
        Ok(Vec::new())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(_state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        ensure!(
            remaining_thread_of_rows::<T>() == 0,
            "cogno-gate v1: retired ThreadOf rows remain after the sweep"
        );
        Ok(())
    }
}

/// `twox128(pallet) ++ twox128("ThreadOf")` — the retired item's storage prefix, taken from the
/// pallet's own runtime name so it cannot drift from what the sweep clears.
#[cfg(any(feature = "try-runtime", test))]
fn thread_of_prefix<T: Config>() -> Vec<u8> {
    let mut prefix =
        sp_io::hashing::twox_128(<Pallet<T> as PalletInfoAccess>::name().as_bytes()).to_vec();
    prefix.extend_from_slice(&sp_io::hashing::twox_128(THREAD_OF));
    prefix
}

/// Count what is still under the retired prefix, by walking RAW keys. Deliberately decodes nothing:
/// the pallet no longer declares the item, so there is no typed accessor, and a typed iterator would
/// silently SKIP any row whose value did not decode into the type it was handed — reporting a clean
/// sweep over rows it simply could not read.
#[cfg(any(feature = "try-runtime", test))]
fn remaining_thread_of_rows<T: Config>() -> usize {
    let prefix = thread_of_prefix::<T>();
    let mut cursor = prefix.clone();
    let mut rows = 0usize;
    while let Some(next) = sp_io::storage::next_key(&cursor) {
        if !next.starts_with(&prefix) {
            break;
        }
        rows = rows.saturating_add(1);
        cursor = next;
    }
    rows
}

/// The public migration: gates [`InnerMigrateV0ToV1`] on `Pallet`'s storage version moving 0 → 1.
/// Idempotent — the sweep runs only when the on-chain version is exactly 0 (which is where every
/// chain that predates this pallet declaring a version sits), then writes 1. A fresh genesis writes
/// the declared version directly, so this self-skips there.
pub type MigrateV0ToV1<T> = VersionedMigration<
    0,
    1,
    InnerMigrateV0ToV1<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::{new_test_ext, Test};
    use frame_support::{
        traits::{GetStorageVersion, OnRuntimeUpgrade, StorageVersion},
        Blake2_128Concat, StorageHasher,
    };

    /// Write a row under the RETIRED prefix, the way a spec-210 `link_identity_signed` did: the
    /// pallet no longer declares the item, so this addresses it the same raw way the sweep does.
    fn insert_legacy_thread_of(who: u64, value: &[u8]) {
        let mut key = thread_of_prefix::<Test>();
        key.extend_from_slice(&Blake2_128Concat::hash(&codec::Encode::encode(&who)));
        frame_support::storage::unhashed::put_raw(&key, value);
    }

    #[test]
    fn v0_to_v1_removes_every_retired_row_and_is_idempotent() {
        new_test_ext().execute_with(|| {
            StorageVersion::new(0).put::<Pallet<Test>>();
            for who in 1u64..=5 {
                insert_legacy_thread_of(who, &[0xAB; 8]);
            }
            assert_eq!(remaining_thread_of_rows::<Test>(), 5);

            let _ = MigrateV0ToV1::<Test>::on_runtime_upgrade();
            assert_eq!(
                remaining_thread_of_rows::<Test>(),
                0,
                "every retired row is gone"
            );
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(1)
            );

            // A second run is a no-op: the version guard skips the sweep entirely.
            let _ = MigrateV0ToV1::<Test>::on_runtime_upgrade();
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(1)
            );
        });
    }

    /// The prefix the sweep clears is the one a live row actually sits under. Anchored against the
    /// pallet's OWN live item (`PkhOf`), not against a second copy of the same literal — the sweep and
    /// this test must not be able to agree with each other on a prefix no chain has ever written.
    #[test]
    fn the_sweep_addresses_the_pallets_real_prefix() {
        new_test_ext().execute_with(|| {
            let live = crate::PkhOf::<Test>::hashed_key_for(1u64);
            let retired = thread_of_prefix::<Test>();
            // First 16 bytes: twox128(pallet). Same pallet, different item — so the pallet half must
            // match and the item half must not.
            assert_eq!(live[..16], retired[..16]);
            assert_ne!(live[16..32], retired[16..32]);

            // And a row written under the retired prefix does NOT survive the sweep, while an
            // unrelated live row does.
            crate::PkhOf::<Test>::insert(1u64, [7u8; 32]);
            insert_legacy_thread_of(1, &[1, 2, 3]);
            StorageVersion::new(0).put::<Pallet<Test>>();
            let _ = MigrateV0ToV1::<Test>::on_runtime_upgrade();
            assert_eq!(remaining_thread_of_rows::<Test>(), 0);
            assert_eq!(
                crate::PkhOf::<Test>::get(1u64),
                Some([7u8; 32]),
                "the sweep must not touch a live item"
            );
        });
    }

    #[test]
    fn v0_to_v1_on_empty_state_is_safe() {
        // The fresh-genesis case: nothing was ever written under the retired prefix.
        new_test_ext().execute_with(|| {
            StorageVersion::new(0).put::<Pallet<Test>>();
            let _ = MigrateV0ToV1::<Test>::on_runtime_upgrade();
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(1)
            );
        });
    }
}
