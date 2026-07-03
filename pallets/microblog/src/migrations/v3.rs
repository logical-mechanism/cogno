//! Storage migration **v2 → v3**: backfill the reply aggregates added in spec 119.
//!
//! Both `ReplyCount` and `RepliesByParent` are NEW maps (empty after the struct-only addition), so —
//! like the `v2` reverse-index backfill — no existing row needs translating. Instead this populates
//! them from the forward state so a post's reply count + its direct-reply list read with one keyed
//! lookup (no full-`Posts` scan) for pre-v3 data:
//!   - For every `Posts[id]` whose `parent == Some(pid)` (i.e. `id` is a reply of `pid`):
//!       - `ReplyCount[pid]` += 1, and
//!       - `RepliesByParent[pid][id] = ()`.
//!
//! Content is append-only (`delete_post` was removed in M0), so a single forward pass over `Posts`
//! reconstructs the exact aggregates the live `post_message` reply path now maintains incrementally.
//!
//! Wired into the runtime's `SingleBlockMigrations` and guarded by [`VersionedMigration`], so it runs
//! exactly once (when the on-chain storage version is 2) and self-skips on any re-run.

use crate::{Config, Pallet, Posts, RepliesByParent, ReplyCount};
use frame_support::{
    migrations::VersionedMigration,
    traits::{Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
};

#[cfg(feature = "try-runtime")]
extern crate alloc;
#[cfg(feature = "try-runtime")]
use alloc::vec::Vec;
// Encode/Decode + `ensure!` are only used by the try-runtime hooks below.
#[cfg(feature = "try-runtime")]
use frame_support::{ensure, pallet_prelude::*};

/// The unchecked inner migration wrapped by [`MigrateV2ToV3`]. Register `MigrateV2ToV3` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV2ToV3<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV2ToV3<T> {
    fn on_runtime_upgrade() -> Weight {
        let mut reads: u64 = 0;
        let mut writes: u64 = 0;

        // One forward pass over Posts: each reply (`parent == Some(pid)`) bumps its parent's count and
        // records the reverse edge. `mutate` is read+write; the insert is a write.
        for (id, post) in Posts::<T>::iter() {
            reads = reads.saturating_add(1);
            if let Some(parent) = post.parent {
                ReplyCount::<T>::mutate(parent, |c| *c = c.saturating_add(1));
                RepliesByParent::<T>::insert(parent, id, ());
                writes = writes.saturating_add(2);
            }
        }

        log::info!(
            target: crate::LOG_TARGET,
            "migration v2->v3: backfilled ReplyCount + RepliesByParent ({reads} reads, {writes} writes)",
        );
        T::DbWeight::get().reads_writes(reads, writes)
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        // The expected number of reply edges = the number of posts with a parent.
        let replies = Posts::<T>::iter()
            .filter(|(_, p)| p.parent.is_some())
            .count() as u64;
        Ok(replies.encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let replies: u64 = Decode::decode(&mut &state[..]).map_err(|_| {
            sp_runtime::TryRuntimeError::Other("microblog v3: bad pre_upgrade state")
        })?;
        // Every reply edge is recorded once in RepliesByParent.
        ensure!(
            RepliesByParent::<T>::iter().count() as u64 == replies,
            "microblog v3: RepliesByParent edge count must equal the number of replies"
        );
        // The per-parent counts must sum to the total reply edges (no double-count, none dropped).
        let total_count: u64 = ReplyCount::<T>::iter().map(|(_, c)| c as u64).sum();
        ensure!(
            total_count == replies,
            "microblog v3: ReplyCount must sum to the number of replies"
        );
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV2ToV3`] on `Pallet`'s storage version moving 2 → 3.
/// Idempotent — runs the inner migration only when the on-chain version is exactly 2, then writes 3.
pub type MigrateV2ToV3<T> = VersionedMigration<
    2,
    3,
    InnerMigrateV2ToV3<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
