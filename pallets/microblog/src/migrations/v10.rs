//! Storage migration **v9 → v10** (spec 212): repage the two per-author indexes.
//!
//! `ByAuthor` and `TopLevelByAuthor` were `StorageMap<AccountId, BoundedVec<u64, MaxPostsPerAuthor>>`.
//! Both become `StorageDoubleMap<AccountId, u64 /* seq */, u64 /* post id */>` beside an explicit
//! `u64` counter, so appending a post costs one counter read plus two writes at ANY history length
//! instead of decoding and re-encoding the author's entire vector.
//!
//! ⚠ THE OLD AND NEW ITEMS SHARE A STORAGE PREFIX. The v9 shape ([`crate::migrations::legacy::blob`],
//! which owns it because `v4` writes it too) addresses the SAME `(pallet, item)` name, so the old
//! single-map rows and the new double-map rows live under one prefix and are distinguished only by key
//! length. Two consequences the code below depends on:
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
//! Cost: one pass over every author, holding one author's id list in memory at a time. Preprod carries
//! a handful of authors with short vectors; a fresh mainnet genesis has none at all. Wired into the
//! runtime's `SingleBlockMigrations` behind [`VersionedMigration`], so it runs exactly once (on-chain
//! version 9 → 10) and self-skips on re-run.

use crate::migrations::legacy::blob::{
    ByAuthor as ByAuthorV9, TopLevelByAuthor as TopLevelByAuthorV9,
};
use crate::{
    ByAuthor, ByAuthorCount, Capacity, CapacityState, Config, Pallet, TopLevelByAuthor,
    TopLevelByAuthorCount,
};
use alloc::vec::Vec;
use frame_support::{
    migrations::VersionedMigration,
    traits::{Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
};
use frame_system::pallet_prelude::BlockNumberFor;

// `Encode`/`Decode` (for the pre/post-upgrade state blob) and `ensure!` are only used by the
// try-runtime hooks below.
#[cfg(feature = "try-runtime")]
use frame_support::{ensure, pallet_prelude::*};

/// The **spec-211** capacity constants — the unit every LIVE `Capacity.cap_last` is denominated in.
/// Historical values: no code can read them any more (the runtime carries only today's), so they are
/// written down here, next to the factor derived from them.
pub mod v9_constants {
    /// `BaseCost` (one post) before spec 212.
    pub const BASE_COST: u128 = 50_000_000;
    /// Capacity ceiling per unit weight, before spec 212.
    pub const CAP_RATIO: u128 = 50;
    /// The absolute bucket ceiling, before spec 212.
    pub const CEILING: u128 = 5_000_000_000_000;
    /// Per-byte post cost, before spec 212.
    pub const PER_BYTE_COST: u128 = 50_000;
}

/// How much bigger a spec-212 micro-capacity unit is than a spec-211 one. `BaseCost` moved
/// 50_000_000 -> 3_000_000_000, and `CapRatio` / `Ceiling` / `PerByteCost` / `VoteCost` /
/// `FollowCost` / `ProfileCost` all moved with it by the SAME factor. Stored `Capacity.cap_last`
/// values are denominated in those units, so they are rescaled by this below.
///
/// ⚠ This is a number in THIS crate that must mirror constants set in another one
/// (`runtime/src/configs/mod.rs`). A bare literal would be tied to nothing: retune `BaseCost` again
/// before this migration is enacted and every live bucket is silently scaled by the wrong factor —
/// and `post_upgrade` cannot catch it, because it asserts `banked * CAPACITY_UNIT_RESCALE` against
/// this same constant and so agrees with itself. So the runtime PINS it at COMPILE time, against
/// [`v9_constants`] and its own live values, in the `const _: () = assert!(…)` block beside the
/// capacity `parameter_types!`. A further retune fails the build instead.
pub const CAPACITY_UNIT_RESCALE: u128 = 60;

/// The unchecked inner migration wrapped by [`MigrateV9ToV10`]. Register `MigrateV9ToV10` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV9ToV10<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV9ToV10<T> {
    fn on_runtime_upgrade() -> Weight {
        // Old author ROWS read + removed, across both maps — including the empty-vec ones that get no
        // counter. This is the weight basis.
        let mut rows: u64 = 0;
        // Counter rows WRITTEN, across both maps — only the authors that actually had ids.
        let mut authors: u64 = 0;
        // Post ids rewritten as new double-map rows, across both maps.
        let mut ids: u64 = 0;

        // ── ByAuthor ────────────────────────────────────────────────────────────────────────────
        // Collect first: the iterator walks the very prefix the new rows are about to be written to.
        let old: Vec<(T::AccountId, Vec<u64>)> = ByAuthorV9::<T>::iter().collect();
        for (author, _) in old.iter() {
            ByAuthorV9::<T>::remove(author);
        }
        // Every OLD row is read and removed, whether or not it carries ids — so `rows` (not `authors`)
        // is what the weight below is charged on. An empty-vec row still costs one read plus one
        // remove; charging only the authors that got a counter under-counts a state carrying many
        // post-less author rows, and a single-block migration's weight is reported POST HOC, so the
        // block-weight limiter cannot catch the shortfall.
        rows = rows.saturating_add(old.len() as u64);
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
        rows = rows.saturating_add(old_top.len() as u64);
        for (author, list) in old_top {
            let mut seq: u64 = 0;
            for id in list {
                TopLevelByAuthor::<T>::insert(&author, seq, id);
                seq = seq.saturating_add(1);
            }
            if seq > 0 {
                TopLevelByAuthorCount::<T>::insert(&author, seq);
                authors = authors.saturating_add(1);
                ids = ids.saturating_add(seq);
            }
        }

        // ── Capacity: rescale the stored buckets into the new units ─────────────────────────────
        //
        // Spec 212 also rescales the talk-capacity unit by exactly one factor (`BaseCost` 5e7 -> 3e9,
        // and every other capacity constant with it). `Capacity.cap_last` is a stored quantity IN
        // THOSE UNITS, so leaving it alone would silently devalue every live bucket 60-fold: an
        // account holding a full 100-post battery would read as holding 1.6 posts and be throttled
        // until it refilled, which now takes 5 hours.
        //
        // The bucket is the only stored capacity quantity — `last_block` is a block number and the
        // ceiling/rate are derived from constants at read time — so this one field is the whole
        // change. Multiplying is exact and cannot overflow the new ceiling: the old value was already
        // clamped to `min(w·50, 5e12)` and the new ceiling is `min(w·3000, 3e14)`, i.e. the same bound
        // scaled by the same factor.
        let rescale = CAPACITY_UNIT_RESCALE;
        let mut buckets: u64 = 0;
        Capacity::<T>::translate::<CapacityState<BlockNumberFor<T>>, _>(|_who, old| {
            buckets = buckets.saturating_add(1);
            Some(CapacityState {
                cap_last: old.cap_last.saturating_mul(rescale),
                last_block: old.last_block,
            })
        });

        log::info!(
            target: crate::LOG_TARGET,
            "migration v9->v10: repaged the per-author indexes ({rows} author row(s), {authors} counter(s), \
             {ids} id(s) rewritten); rescaled {buckets} capacity bucket(s) by {rescale}x",
        );
        // Per OLD author row: 1 read of the blob + 1 remove — `rows` already spans both maps and
        // includes the empty ones. Per author that had ids: 1 counter write. Per id: 1 row write.
        // Plus 1 read + 1 write per rescaled capacity bucket.
        T::DbWeight::get().reads_writes(
            rows.saturating_add(buckets),
            rows.saturating_add(authors)
                .saturating_add(ids)
                .saturating_add(buckets),
        )
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        // Sum the v9 blob lengths. Safe to read the old alias HERE: no new-shape row exists yet.
        let by_author: u64 = ByAuthorV9::<T>::iter().map(|(_, v)| v.len() as u64).sum();
        let top_level: u64 = TopLevelByAuthorV9::<T>::iter()
            .map(|(_, v)| v.len() as u64)
            .sum();
        // The pre-rescale bucket total, so `post_upgrade` can prove the rescale was applied EXACTLY
        // once (a doubled or skipped pass would leave the total off by a factor of the rescale).
        let banked: u128 = Capacity::<T>::iter().map(|(_, s)| s.cap_last).sum();
        let buckets: u64 = Capacity::<T>::iter().count() as u64;
        log::info!(
            target: crate::LOG_TARGET,
            "migration v9->v10 pre: {by_author} ByAuthor id(s), {top_level} TopLevelByAuthor id(s), \
             {buckets} capacity bucket(s) banking {banked} micro-capacity",
        );
        Ok((by_author, top_level, banked, buckets).encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let (by_author, top_level, banked, buckets): (u64, u64, u128, u64) =
            Decode::decode(&mut &state[..]).map_err(|_| {
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
        // The capacity rescale ran EXACTLY once, over every bucket: no row gained or lost, and the
        // banked total moved by exactly the unit factor. A skipped pass leaves it unchanged and a
        // doubled one squares the factor, so equality here rules out both.
        ensure!(
            Capacity::<T>::iter().count() as u64 == buckets,
            "microblog v10: the capacity rescale must not add or drop a bucket"
        );
        // The factor itself is pinned to the runtime's live constants at COMPILE time (see the
        // `const _: () = assert!(…)` beside the capacity `parameter_types!`), so this only has to
        // prove the pass ran once over every bucket.
        ensure!(
            Capacity::<T>::iter().map(|(_, s)| s.cap_last).sum::<u128>()
                == banked.saturating_mul(CAPACITY_UNIT_RESCALE),
            "microblog v10: banked capacity must scale by exactly CAPACITY_UNIT_RESCALE"
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
