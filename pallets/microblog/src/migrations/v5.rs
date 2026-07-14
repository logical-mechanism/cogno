//! Storage migration **v4 → v5** (spec 204): retire the repost storage and settle every capacity
//! bucket onto the settle-at-the-old-weight invariant. One migration, two jobs — both are one-shot
//! consequences of the same runtime upgrade, and neither is worth a block of its own.
//!
//! **(a) Drop the retired repost storage.** `repost` (`call_index 6`), `Reposts` and `RepostCount` were
//! removed from the pallet, so their rows are now orphaned under an undeclared prefix — invisible to the
//! runtime, still paying for themselves in the trie. This DELETES DATA: the live chain carries repost
//! rows, so `pre_upgrade` counts them rather than asserting the maps are empty. They are re-declared
//! below via [`storage_alias`] purely so the migration can reach them; nothing else may re-declare them.
//!
//! **(b) Settle every capacity bucket.** `Capacity[who].last_block` is only restamped by `consume` /
//! `on_revoke` / `force_set_capacity` — never by a weight write. Rows that predate this upgrade therefore
//! carry a `last_block` that spans a window the account spent at a DIFFERENT weight. The fix (the sink's
//! `settle_capacity_at`) closes that window at every future weight change, but the stale rows already on
//! chain would still have their pre-upgrade window priced at whatever weight came next. Settling every row
//! here — at the account's CURRENT weight, which is exactly the weight `current_capacity` already prices
//! that window at — leaves the readable capacity BIT-IDENTICAL while retiring the last stale `last_block`.
//!
//! That neutrality is the whole safety argument for (b), so `post_upgrade` proves it: it snapshots every
//! account's readable capacity BEFORE and requires the identical value after. The migration MATERIALIZES
//! what the read already returns; it does not hand anyone capacity, and it does not take any away.
//!
//! Wired into the runtime's `SingleBlockMigrations` and guarded by [`VersionedMigration`], so it runs
//! exactly once (when the on-chain storage version is 4) and self-skips on any re-run.

use crate::{Capacity, Config, Pallet};
use alloc::vec::Vec;
use frame_support::{
    migrations::VersionedMigration,
    pallet_prelude::*,
    storage_alias,
    traits::{Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
    Blake2_128Concat,
};

// `ensure!` is only used by the try-runtime hooks below.
#[cfg(feature = "try-runtime")]
use frame_support::ensure;

/// The retired repost storage, re-declared ONLY so this migration can drain it (and so its test can
/// seed the rows the live chain holds). `#[storage_alias]` resolves the same prefix the deleted
/// `#[pallet::storage]` items used (pallet name + item name), so these reach the exact rows on chain.
/// Do not copy these declarations anywhere else — a re-declared prefix resurrects deleted state.
pub(crate) mod retired {
    use super::*;

    /// Was: per-(post, account) repost edge.
    #[storage_alias]
    pub type Reposts<T: Config> = StorageDoubleMap<
        Pallet<T>,
        Blake2_128Concat,
        u64,
        Blake2_128Concat,
        <T as frame_system::Config>::AccountId,
        (),
        OptionQuery,
    >;

    /// Was: per-post repost count.
    #[storage_alias]
    pub type RepostCount<T: Config> = StorageMap<Pallet<T>, Blake2_128Concat, u64, u32, ValueQuery>;
}

/// The unchecked inner migration wrapped by [`MigrateV4ToV5`]. Register `MigrateV4ToV5` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV4ToV5<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV4ToV5<T> {
    fn on_runtime_upgrade() -> Weight {
        let mut reads: u64 = 0;
        let mut writes: u64 = 0;

        // (a) Drain the retired repost maps. `u32::MAX` in one pass: the live row count is single digits
        // (reposting was never surfaced in the UI), so this cannot run long. A removal costs a seek + a
        // write, so charge both.
        let reposts = retired::Reposts::<T>::clear(u32::MAX, None);
        let repost_count = retired::RepostCount::<T>::clear(u32::MAX, None);
        let removed = (reposts.backend as u64).saturating_add(repost_count.backend as u64);
        reads = reads.saturating_add(removed);
        writes = writes.saturating_add(removed);
        // A `clear` that stops early hands back a cursor and leaves rows behind — orphaned under a prefix
        // no pallet declares any more, and unreachable by any future migration that (correctly) assumes
        // this one finished. Never panic here (a panic in `on_runtime_upgrade` bricks the upgrade); this
        // must be LOUD instead. `post_upgrade` turns the same condition into a hard failure under the
        // try-runtime dry-run, which is where it should be caught.
        if reposts.maybe_cursor.is_some() || repost_count.maybe_cursor.is_some() {
            log::error!(
                target: crate::LOG_TARGET,
                "migration v4->v5: the retired repost maps did NOT fully drain in one pass — rows remain orphaned under an undeclared prefix",
            );
        }

        // (b) Settle every capacity bucket at the weight it is CURRENTLY priced at, which materializes
        // exactly the value `current_capacity` already returns (see the module docs). Collect the keys
        // first — the map must not be mutated while its iterator is live.
        let holders: Vec<T::AccountId> = Capacity::<T>::iter_keys().collect();
        reads = reads.saturating_add(holders.len() as u64);
        for who in &holders {
            // The SAME helper the observer sink calls, so the migration and the runtime cannot drift.
            let weight = pallet_talk_stake::AllowedStake::<T>::get(who);
            Pallet::<T>::settle_capacity_at(who, weight);
            // 1 `AllowedStake` read + 1 `Capacity` read in the settle, 1 `Capacity` write.
            reads = reads.saturating_add(2);
            writes = writes.saturating_add(1);
        }

        log::info!(
            target: crate::LOG_TARGET,
            "migration v4->v5: dropped {removed} retired repost rows, settled {} capacity buckets ({reads} reads, {writes} writes)",
            holders.len(),
        );
        T::DbWeight::get().reads_writes(reads, writes)
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        let now = frame_system::Pallet::<T>::block_number();
        // Every account's READABLE capacity right now. `post_upgrade` requires the identical value —
        // settling must be observably neutral.
        let capacities: Vec<(T::AccountId, u128)> = Capacity::<T>::iter_keys()
            .map(|who| {
                let cap = Pallet::<T>::current_capacity(&who, now);
                (who, cap)
            })
            .collect();
        // The live chain HAS repost rows — count them (an operator reading the dry-run wants to see how
        // many rows this is about to delete), never assert they are absent. They are NOT carried into the
        // payload: `post_upgrade` proves the strictly stronger property that BOTH maps are now empty, which
        // a before/after count comparison cannot (a count says how many went, not that none stayed).
        log::info!(
            target: crate::LOG_TARGET,
            "migration v4->v5 pre: {} capacity buckets, {} Reposts rows, {} RepostCount rows (all repost rows will be DELETED)",
            capacities.len(),
            retired::Reposts::<T>::iter().count(),
            retired::RepostCount::<T>::iter().count(),
        );
        Ok(capacities.encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let capacities: Vec<(T::AccountId, u128)> =
            Decode::decode(&mut &state[..]).map_err(|_| {
                sp_runtime::TryRuntimeError::Other("microblog v5: bad pre_upgrade state")
            })?;
        let now = frame_system::Pallet::<T>::block_number();

        // (a) Both retired maps are fully drained — no orphan rows left under an undeclared prefix. This is
        // also what catches a `clear` that stopped early and handed back a cursor.
        ensure!(
            retired::Reposts::<T>::iter().next().is_none(),
            "microblog v5: Reposts must be fully drained"
        );
        ensure!(
            retired::RepostCount::<T>::iter().next().is_none(),
            "microblog v5: RepostCount must be fully drained"
        );

        // (b) No bucket was created or dropped...
        ensure!(
            Capacity::<T>::iter_keys().count() == capacities.len(),
            "microblog v5: settling must not add or remove a capacity row"
        );
        for (who, before) in &capacities {
            // ...every account's readable capacity is UNCHANGED (the neutrality contract)...
            ensure!(
                Pallet::<T>::current_capacity(who, now) == *before,
                "microblog v5: settling changed an account's readable capacity"
            );
            // ...and every row is now stamped at THIS block, so no stale `last_block` survives.
            let row = Capacity::<T>::get(who).ok_or(sp_runtime::TryRuntimeError::Other(
                "microblog v5: row vanished",
            ))?;
            ensure!(
                row.last_block == now,
                "microblog v5: every capacity row must be restamped to the upgrade block"
            );
        }
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV4ToV5`] on `Pallet`'s storage version moving 4 → 5.
/// Idempotent — runs the inner migration only when the on-chain version is exactly 4, then writes 5.
pub type MigrateV4ToV5<T> = VersionedMigration<
    4,
    5,
    InnerMigrateV4ToV5<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
