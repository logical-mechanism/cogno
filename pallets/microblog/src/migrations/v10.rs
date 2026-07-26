//! Storage migration **v9 → v10** (spec 212): repage the two per-author indexes.
//!
//! `ByAuthor` and `TopLevelByAuthor` were `StorageMap<AccountId, BoundedVec<u64, MaxPostsPerAuthor>>`.
//! Both become `StorageDoubleMap<AccountId, u64 /* seq */, u64 /* post id */>` beside an explicit
//! `u64` counter, so appending a post costs one counter read plus two writes at ANY history length
//! instead of decoding and re-encoding the author's entire vector.
//!
//! ⚠ THE OLD AND NEW ITEMS SHARE A STORAGE PREFIX. The v9 shape is re-declared below against the SAME
//! `(pallet, item)` name, so the old single-map rows and the new double-map rows live under one prefix
//! and are distinguished only by key length. Two consequences the code below depends on:
//!
//!   1. Order is load-bearing: read every old row, REMOVE it by its exact old key, and only then write
//!      the new rows. `clear_prefix` would be wrong (it would also delete anything already written),
//!      and writing first would leave the old rows to be mis-decoded forever.
//!   2. The old alias must NEVER be read again after step 3 — not even to assert "no rows left".
//!      `Blake2_128Concat::reverse` strips 16 bytes and decodes an `AccountId` from the first 32 of
//!      what remains, IGNORING the trailing `blake2_128concat(seq)`, so every NEW key decodes
//!      "successfully" as an old key; and a new `u64` value decodes as a (garbage, usually empty)
//!      `Vec<u64>`. `post_upgrade` therefore asserts on the NEW items only.
//!
//! The alias values are `Vec<u64>`, not `BoundedVec<u64, _>`: the two are SCALE-identical, and the
//! plain `Vec` sidesteps the `MaxPostsPerAuthor` bound that this upgrade removes from `Config`.
//!
//! Cost: one pass over every author, holding one author's id list in memory at a time. Preprod carries
//! a handful of authors with short vectors; a fresh mainnet genesis has none at all. Wired into the
//! runtime's `SingleBlockMigrations` behind [`VersionedMigration`], so it runs exactly once (on-chain
//! version 9 → 10) and self-skips on re-run.

use crate::{ByAuthor, ByAuthorCount, Config, Pallet, TopLevelByAuthor, TopLevelByAuthorCount};
use alloc::vec::Vec;
use frame_support::{
    migrations::VersionedMigration,
    pallet_prelude::*,
    storage::types::StorageMap as RawStorageMap,
    traits::{Get, PalletInfoAccess, StorageInstance, UncheckedOnRuntimeUpgrade},
    weights::Weight,
    Blake2_128Concat,
};

#[cfg(feature = "try-runtime")]
use frame_support::ensure;

// ⚠ NOT `#[storage_alias]`. That macro takes the on-chain STORAGE ITEM NAME from the ALIAS TYPE NAME,
// so a `ByAuthorV9` alias silently addresses `twox128("Microblog") ++ twox128("ByAuthorV9")` — a prefix
// nothing has ever written. The migration then iterates zero rows, reports success, and leaves every
// real v9 row orphaned under the shared `ByAuthor` prefix where the new double map cannot decode it.
// (That is not hypothetical: it is what the first cut of this file did, it passed its own unit tests —
// which wrote and read through the same wrong prefix, so they were self-fulfilling — and only the
// `try-runtime` dry-run against real preprod state caught it.)
//
// So the prefix is spelled out. `STORAGE_PREFIX` is the REAL item name; the Rust type keeps the `V9`
// suffix so it is obvious at every call site which shape is meant. `alias_prefixes_match_the_live_items`
// in the tests pins the two together against the pallet's own items.

/// Addresses the `Microblog::ByAuthor` prefix with the v9 (blob) value shape.
pub struct ByAuthorV9Prefix<T>(core::marker::PhantomData<T>);
impl<T: Config> StorageInstance for ByAuthorV9Prefix<T> {
    fn pallet_prefix() -> &'static str {
        <Pallet<T> as PalletInfoAccess>::name()
    }
    const STORAGE_PREFIX: &'static str = "ByAuthor";
}

/// Addresses the `Microblog::TopLevelByAuthor` prefix with the v9 (blob) value shape.
pub struct TopLevelByAuthorV9Prefix<T>(core::marker::PhantomData<T>);
impl<T: Config> StorageInstance for TopLevelByAuthorV9Prefix<T> {
    fn pallet_prefix() -> &'static str {
        <Pallet<T> as PalletInfoAccess>::name()
    }
    const STORAGE_PREFIX: &'static str = "TopLevelByAuthor";
}

/// The **v9** on-chain shape of `ByAuthor` — one blob of post ids per author.
pub type ByAuthorV9<T> = RawStorageMap<
    ByAuthorV9Prefix<T>,
    Blake2_128Concat,
    <T as frame_system::Config>::AccountId,
    Vec<u64>,
    ValueQuery,
>;

/// The **v9** on-chain shape of `TopLevelByAuthor` — same blob, reply-free.
pub type TopLevelByAuthorV9<T> = RawStorageMap<
    TopLevelByAuthorV9Prefix<T>,
    Blake2_128Concat,
    <T as frame_system::Config>::AccountId,
    Vec<u64>,
    ValueQuery,
>;

/// The unchecked inner migration wrapped by [`MigrateV9ToV10`]. Register `MigrateV9ToV10` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV9ToV10<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV9ToV10<T> {
    fn on_runtime_upgrade() -> Weight {
        let mut authors: u64 = 0;
        let mut ids: u64 = 0;

        // ── ByAuthor ────────────────────────────────────────────────────────────────────────────
        // Collect first: the iterator walks the very prefix the new rows are about to be written to.
        let old: Vec<(T::AccountId, Vec<u64>)> = ByAuthorV9::<T>::iter().collect();
        for (author, _) in old.iter() {
            ByAuthorV9::<T>::remove(author);
        }
        for (author, list) in old {
            let mut seq: u64 = 0;
            for id in list {
                ByAuthor::<T>::insert(&author, seq, id);
                seq = seq.saturating_add(1);
            }
            // A v9 author row could legitimately be an EMPTY vec (`ValueQuery` default written back by
            // a `try_mutate` that failed). Skip the counter write so a post-less author leaves no row —
            // `who_to_follow` ranks over exactly the accounts that have a `ByAuthorCount` row.
            if seq > 0 {
                ByAuthorCount::<T>::insert(&author, seq);
                authors = authors.saturating_add(1);
                ids = ids.saturating_add(seq);
            }
        }

        // ── TopLevelByAuthor ────────────────────────────────────────────────────────────────────
        let old_top: Vec<(T::AccountId, Vec<u64>)> = TopLevelByAuthorV9::<T>::iter().collect();
        for (author, _) in old_top.iter() {
            TopLevelByAuthorV9::<T>::remove(author);
        }
        for (author, list) in old_top {
            let mut seq: u64 = 0;
            for id in list {
                TopLevelByAuthor::<T>::insert(&author, seq, id);
                seq = seq.saturating_add(1);
            }
            if seq > 0 {
                TopLevelByAuthorCount::<T>::insert(&author, seq);
                ids = ids.saturating_add(seq);
            }
        }

        log::info!(
            target: crate::LOG_TARGET,
            "migration v9->v10: repaged the per-author indexes ({authors} author(s), {ids} id(s) rewritten)",
        );
        // Per author: 1 read of the old blob + 1 remove + 1 counter write, twice (both maps). Per id:
        // 1 row write. Charge both maps at the same author count — an over-count of the reply-free map
        // is the safe direction.
        let author_ops = authors.saturating_mul(2);
        T::DbWeight::get()
            .reads_writes(author_ops, author_ops.saturating_mul(2).saturating_add(ids))
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        // Sum the v9 blob lengths. Safe to read the old alias HERE: no new-shape row exists yet.
        let by_author: u64 = ByAuthorV9::<T>::iter().map(|(_, v)| v.len() as u64).sum();
        let top_level: u64 = TopLevelByAuthorV9::<T>::iter()
            .map(|(_, v)| v.len() as u64)
            .sum();
        log::info!(
            target: crate::LOG_TARGET,
            "migration v9->v10 pre: {by_author} ByAuthor id(s), {top_level} TopLevelByAuthor id(s)",
        );
        Ok((by_author, top_level).encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let (by_author, top_level): (u64, u64) = Decode::decode(&mut &state[..]).map_err(|_| {
            sp_runtime::TryRuntimeError::Other("microblog v10: bad pre_upgrade state")
        })?;
        // ⚠ Asserts on the NEW items only — see the module note: the v9 alias would happily "decode"
        // the new rows and report nonsense.
        ensure!(
            ByAuthor::<T>::iter().count() as u64 == by_author,
            "microblog v10: ByAuthor row count must equal the v9 id count"
        );
        ensure!(
            TopLevelByAuthor::<T>::iter().count() as u64 == top_level,
            "microblog v10: TopLevelByAuthor row count must equal the v9 id count"
        );
        // Every counter equals its author's row count, and every seq is inside `0..count` — the
        // density the seq-descending readers walk. (`check_tally_consistency` re-checks this on every
        // `try_state` block; asserting here pins it to the migration itself.)
        ensure!(
            ByAuthorCount::<T>::iter().map(|(_, c)| c).sum::<u64>() == by_author,
            "microblog v10: ByAuthorCount must sum to the v9 id count"
        );
        ensure!(
            TopLevelByAuthorCount::<T>::iter()
                .map(|(_, c)| c)
                .sum::<u64>()
                == top_level,
            "microblog v10: TopLevelByAuthorCount must sum to the v9 id count"
        );
        ensure!(
            ByAuthor::<T>::iter().all(|(a, seq, _)| seq < ByAuthorCount::<T>::get(&a)),
            "microblog v10: a ByAuthor seq is at or past its counter"
        );
        ensure!(
            TopLevelByAuthor::<T>::iter()
                .all(|(a, seq, _)| seq < TopLevelByAuthorCount::<T>::get(&a)),
            "microblog v10: a TopLevelByAuthor seq is at or past its counter"
        );
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV9ToV10`] on `Pallet`'s storage version moving 9 → 10.
/// Idempotent — runs the inner migration only when the on-chain version is exactly 9, then writes 10.
pub type MigrateV9ToV10<T> = VersionedMigration<
    9,
    10,
    InnerMigrateV9ToV10<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
