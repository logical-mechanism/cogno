//! Storage migration **v10 → v11** (spec 216): backfill the ordered reply spine.
//!
//! `RepliesByParentSeq[parent][seq] = reply_id` is the seq-keyed index [`crate::Pallet::replies_page`]
//! pages over. Live state has none of it — every reply written before this upgrade only ever wrote
//! [`crate::ReplyCount`] and the id-keyed [`crate::RepliesByParent`] — so without this backfill a
//! pre-upgrade thread reads as having ZERO replies (the spine is what both `thread` and `replies_page`
//! now walk, and an empty spine is indistinguishable from an empty thread to them).
//!
//! The source is `RepliesByParent`, which the pallet STILL DECLARES. So, unlike [`super::v10`], there is
//! no retired shape to re-address and therefore no `#[storage_alias]` anywhere near this file — the
//! trap that macro sets (it takes the on-chain item name from the ALIAS TYPE NAME, so a `FooV10` alias
//! silently addresses a prefix nothing ever wrote, and the migration then iterates zero rows and reports
//! success) simply cannot be sprung here. The two items also have DISTINCT prefixes
//! (`twox128("RepliesByParent")` vs `twox128("RepliesByParentSeq")`), so v10's read-remove-then-write
//! ordering rule does not apply either: nothing this writes can collide with what it reads.
//!
//! ORDER IS THE WHOLE POINT. `RepliesByParent` is a double map, so `iter_keys` yields HASH order — the
//! very reason the old `thread` had to materialize and sort the entire prefix, and the reason this index
//! exists. The backfill therefore drains every `(parent, reply_id)` pair into ONE `BTreeSet`, whose
//! iteration order is lexicographic on the tuple: grouped by parent, ascending by reply id within each
//! parent. That is exactly the order the live writer ([`crate::Pallet::index_reply`]) produces, because
//! ids come from the monotonic `NextPostId` and replies are append-only. One pass, no per-parent sort,
//! and the ordering `replies_page`'s cursor depends on holds by construction.
//!
//! Cost: one walk of `RepliesByParent` plus one write per reply. The live chain carries tens of posts;
//! a fresh mainnet genesis has none. Wired into the runtime's `SingleBlockMigrations` behind
//! [`VersionedMigration`], so it runs exactly once (on-chain version 10 → 11) and self-skips on re-run.

use crate::{Config, Pallet, RepliesByParent, RepliesByParentSeq};
use alloc::collections::BTreeSet;
use frame_support::{
    migrations::VersionedMigration,
    traits::{Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
};

// `Encode`/`Decode` (for the pre/post-upgrade state blob) and `ensure!` are only used by the
// try-runtime hooks below.
#[cfg(feature = "try-runtime")]
use crate::ReplyCount;
#[cfg(feature = "try-runtime")]
use alloc::vec::Vec;
#[cfg(feature = "try-runtime")]
use frame_support::{ensure, pallet_prelude::*};

/// The unchecked inner migration wrapped by [`MigrateV10ToV11`]. Register `MigrateV10ToV11` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV10ToV11<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV10ToV11<T> {
    fn on_runtime_upgrade() -> Weight {
        // Collect first, into a set ordered by (parent, reply id) — see the module note: the source
        // iterates in HASH order and the destination must be in ID order.
        let pairs: BTreeSet<(u64, u64)> = RepliesByParent::<T>::iter_keys().collect();
        let rows = pairs.len() as u64;

        let mut current: Option<u64> = None;
        let mut seq: u64 = 0;
        let mut parents: u64 = 0;
        for (parent, reply_id) in pairs {
            // A new parent group starts a new dense sequence. `BTreeSet` iteration is grouped by the
            // first tuple element, so this fires exactly once per parent.
            if current != Some(parent) {
                current = Some(parent);
                seq = 0;
                parents = parents.saturating_add(1);
            }
            RepliesByParentSeq::<T>::insert(parent, seq, reply_id);
            seq = seq.saturating_add(1);
        }

        log::info!(
            target: crate::LOG_TARGET,
            "migration v10->v11: backfilled the ordered reply spine ({rows} reply row(s) across \
             {parents} parent(s))",
        );
        // One read per source row (the `iter_keys` walk) and one write per spine row.
        T::DbWeight::get().reads_writes(rows, rows)
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        let rows: u64 = RepliesByParent::<T>::iter_keys().count() as u64;
        // The independent second opinion on how many rows SHOULD land: `ReplyCount` is maintained by the
        // same writer but is a different storage item, so agreeing with it proves the walk saw the whole
        // index rather than proving the walk agrees with itself. (`check_tally_consistency` already
        // requires the two to match, so a disagreement here is a pre-existing fault, not one this
        // migration introduced — worth failing the dry-run over either way.)
        let counted: u64 = ReplyCount::<T>::iter().map(|(_, c)| u64::from(c)).sum();
        // Nothing may exist under the new prefix yet: this is a fresh item, and a non-empty one would
        // mean the version guard let a re-run through.
        let existing: u64 = RepliesByParentSeq::<T>::iter().count() as u64;
        ensure!(
            existing == 0,
            "microblog v11: RepliesByParentSeq must be empty before the backfill"
        );
        log::info!(
            target: crate::LOG_TARGET,
            "migration v10->v11 pre: {rows} RepliesByParent row(s), {counted} counted by ReplyCount",
        );
        Ok((rows, counted).encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let (rows, counted): (u64, u64) = Decode::decode(&mut &state[..]).map_err(|_| {
            sp_runtime::TryRuntimeError::Other("microblog v11: bad pre_upgrade state")
        })?;
        ensure!(
            rows == counted,
            "microblog v11: RepliesByParent and ReplyCount disagreed before the backfill"
        );
        // Exactly one spine row per reply — no row dropped, none written twice.
        ensure!(
            RepliesByParentSeq::<T>::iter().count() as u64 == rows,
            "microblog v11: RepliesByParentSeq row count must equal the RepliesByParent row count"
        );
        // Every row is a real reply of its parent, and every seq is inside `0..ReplyCount[parent]` —
        // the density the seq-descending readers walk, and (with the row count above) the proof that
        // the seq set is exactly `0..count` per parent.
        ensure!(
            RepliesByParentSeq::<T>::iter()
                .all(|(p, seq, id)| seq < u64::from(ReplyCount::<T>::get(p))
                    && RepliesByParent::<T>::contains_key(p, id)),
            "microblog v11: a RepliesByParentSeq row is out of range or is not a reply of its parent"
        );
        // Ids ascend strictly with seq — what `replies_page`'s cursor and `thread`'s chronological
        // reverse both depend on. Checked against the NEXT slot by keyed read, exactly as
        // `check_tally_consistency` does, so no per-parent list goes on the heap.
        ensure!(
            RepliesByParentSeq::<T>::iter().all(|(p, seq, id)| RepliesByParentSeq::<T>::get(
                p,
                seq.saturating_add(1)
            )
            .is_none_or(|next| next > id)),
            "microblog v11: RepliesByParentSeq ids do not ascend with seq"
        );
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV10ToV11`] on `Pallet`'s storage version moving 10 → 11.
/// Idempotent — runs the inner migration only when the on-chain version is exactly 10, then writes 11.
pub type MigrateV10ToV11<T> = VersionedMigration<
    10,
    11,
    InnerMigrateV10ToV11<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
