//! Storage migration **v0 → v1** (spec 215): repage the three observation bases.
//!
//! `LastObserved`, `LastObservedStake` and `LastObservedRoles` were `StorageValue<BoundedVec<_,
//! MaxObserved>>` blobs — one whole-set read and one whole-set re-encode per block, and a hard ceiling on
//! how many identities could hold weight at all. All three become StorageMaps, which is what removes the
//! ceiling. The pallet declared no `#[pallet::storage_version]` before this, so the on-chain version reads
//! 0 and this runs exactly once.
//!
//! ## The values are seeded EMPTY, on purpose
//!
//! The old bases recorded only WHICH identities were credited, never the value credited to them — absence
//! from the next full snapshot was the whole unlock signal, so the applied weight never had to be
//! remembered. The new bases record `(account, weight)` because the delta compares against it. There is no
//! way to recover the old weights from this pallet: they live in `talk-stake`, which it deliberately
//! cannot name (the resolver/sink traits exist to keep that Cargo edge absent).
//!
//! So each row migrates with a weight of `0` and each role account with an empty set, and the FIRST
//! observation after the upgrade re-derives the truth. That is correct rather than merely tolerable, and
//! it is worth being precise about why:
//!
//! - Every row here was written by the last full-snapshot `observe`, which applied the true value. So the
//!   chain's `AllowedStake` / `VotingPower` / `ObservedRoles` already hold the truth at the moment of the
//!   upgrade — only this pallet's private record of it is being rebuilt.
//! - Seeding `0` makes the first delta re-emit every row whose true value is non-zero, which re-applies a
//!   value the sink already holds. A redundant write, not a wrong one.
//! - A row whose true value IS zero (a sub-`MinLock` lock) produces no change, and the sink already holds
//!   zero for it. Also correct.
//! - A row that has since dropped out is absent from the new snapshot and gets its explicit `None`, so it
//!   is cleared exactly as it would have been.
//!
//! The re-emission is the same bootstrap the design gives a fresh chain: if it exceeds
//! `MaxChangesPerBlock` it pages and drains over the following blocks. On the live chain the vault basis
//! is 7 rows and the stake basis 2, so it drains in the first block.
//!
//! Wired into the runtime's `SingleBlockMigrations` behind [`VersionedMigration`], so it runs exactly once
//! (on-chain version 0 → 1) and self-skips on re-run.

use crate::migrations::legacy::blob::{
    LastObserved as LastObservedV0, LastObservedRoles as LastObservedRolesV0,
    LastObservedStake as LastObservedStakeV0,
};
#[cfg(feature = "try-runtime")]
use crate::LastObservedRoles;
use crate::{Config, LastObserved, LastObservedStake, Pallet, PendingChanges};
use frame_support::{
    migrations::VersionedMigration,
    traits::{Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
};

// `Encode`/`Decode` (for the pre/post-upgrade state blob) and `ensure!` are only used by the try-runtime
// hooks below.
#[cfg(feature = "try-runtime")]
use alloc::vec::Vec;
#[cfg(feature = "try-runtime")]
use frame_support::{ensure, pallet_prelude::*};

/// The unchecked inner migration wrapped by [`MigrateV0ToV1`]. Register `MigrateV0ToV1` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV0ToV1<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV0ToV1<T> {
    fn on_runtime_upgrade() -> Weight {
        // Rows read from the old blobs and written as new map rows, across all three axes. The three
        // `kill`s are counted separately.
        let mut rows: u64 = 0;

        // ── Vault ────────────────────────────────────────────────────────────────────────────────
        // Take-then-kill: `take()` reads and removes in one step, and the old and new items do NOT share
        // a prefix here (a StorageValue lives at `twox128(pallet) ++ twox128(item)` with nothing after it,
        // while every map row has a hashed key appended), so unlike microblog's v10 the ordering is not
        // load-bearing. It is still written this way so a re-read of the retired shape is impossible.
        let old_vault = LastObservedV0::<T>::take();
        rows = rows.saturating_add(old_vault.len() as u64);
        for (beacon, account) in old_vault {
            // Weight 0: see the module docs. The first observation re-derives the real value.
            LastObserved::<T>::insert(beacon, (account, 0u128));
        }

        // ── Voting power ─────────────────────────────────────────────────────────────────────────
        let old_stake = LastObservedStakeV0::<T>::take();
        rows = rows.saturating_add(old_stake.len() as u64);
        for (cred, account) in old_stake {
            LastObservedStake::<T>::insert(cred, (account, 0u128));
        }

        // ── Roles ────────────────────────────────────────────────────────────────────────────────
        // The old shape held accounts with no sets. An EMPTY set would be an invalid new row (the pallet's
        // `try_state` rejects one, because an empty row makes the diff emit a redundant clear every block
        // forever), so these accounts are NOT carried across as rows at all. Dropping them is safe in both
        // directions: an account that still holds roles is absent from the basis, so the first delta emits
        // its full set and re-applies it; an account that has since lost them is absent from BOTH the basis
        // and the snapshot, so no change is emitted — and its badges were already cleared by the last
        // full-snapshot observation before the upgrade.
        let old_roles = LastObservedRolesV0::<T>::take();
        let role_accounts = old_roles.len() as u64;

        // The backlog counter starts at zero: nothing is deferred until an observation says so.
        PendingChanges::<T>::put(0u32);

        log::info!(
            target: crate::LOG_TARGET,
            "cardano-observer v0 -> v1: repaged {rows} basis rows into StorageMaps and dropped {role_accounts} setless role accounts; the next observation re-derives every value",
        );

        // Reads/writes: one read + one kill per old blob (3 each), one write per new row, and one write for
        // `PendingChanges`.
        T::DbWeight::get().reads_writes(3, rows.saturating_add(4))
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        // Carry the three old lengths forward so `post_upgrade` can assert the row counts landed, rather
        // than merely that the new items decode.
        let vault = LastObservedV0::<T>::get().len() as u32;
        let stake = LastObservedStakeV0::<T>::get().len() as u32;
        let roles = LastObservedRolesV0::<T>::get().len() as u32;
        log::info!(
            target: crate::LOG_TARGET,
            "cardano-observer v0 -> v1 pre_upgrade: vault={vault} stake={stake} roles={roles}",
        );
        Ok((vault, stake, roles).encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let (vault, stake, roles): (u32, u32, u32) =
            Decode::decode(&mut &state[..]).map_err(|_| "v1 post_upgrade: undecodable state")?;

        // Every old row became a map row.
        ensure!(
            LastObserved::<T>::iter().count() as u32 == vault,
            "v1: the vault basis lost or gained rows"
        );
        ensure!(
            LastObservedStake::<T>::iter().count() as u32 == stake,
            "v1: the stake basis lost or gained rows"
        );
        // The role accounts are deliberately NOT carried across (see `on_runtime_upgrade`), so the new map
        // is empty however many there were.
        ensure!(
            LastObservedRoles::<T>::iter().next().is_none(),
            "v1: the role basis should be empty after the migration"
        );
        let _ = roles;

        // The retired blobs are gone. This probes the RAW key rather than reading through the old alias:
        // a `Vec` alias answers a missing value with `ValueQuery`'s empty default, so `get().is_empty()`
        // would be true whether the blob was removed or merely emptied, and it would agree with itself
        // either way. The key comes FROM the alias (`hashed_key()`), so it is provably the same prefix the
        // migration wrote through.
        for key in [
            LastObservedV0::<T>::hashed_key(),
            LastObservedStakeV0::<T>::hashed_key(),
            LastObservedRolesV0::<T>::hashed_key(),
        ] {
            ensure!(
                !frame_support::storage::unhashed::exists(&key),
                "v1: a retired StorageValue blob is still present at its bare prefix"
            );
        }

        ensure!(
            PendingChanges::<T>::get() == 0,
            "v1: the backlog counter should start at zero"
        );
        Ok(())
    }
}

/// The registered migration: version-guarded, so it runs exactly once and self-skips afterwards.
pub type MigrateV0ToV1<T> = VersionedMigration<
    0,
    1,
    InnerMigrateV0ToV1<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
