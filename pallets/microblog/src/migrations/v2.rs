//! Storage migration **v1 → v2**: backfill the two reverse indexes added in spec 118.
//!
//! Both `Followers` and `VotesByAccount` are NEW maps (empty after the struct-only addition), so —
//! unlike the `v1` `Post` re-encode — no existing row needs translating. Instead this populates them
//! from the forward state so "who follows X" and the profile Likes tab work immediately for pre-v2
//! data:
//!   - `Followers[followee][follower]` from every `Following[follower][followee]` edge.
//!   - `VotesByAccount[account][post]` from every `Votes[post][account]` row whose dir is `Up`.
//!
//! Wired into the runtime's `SingleBlockMigrations` and guarded by [`VersionedMigration`], so it runs
//! exactly once (when the on-chain storage version is 1) and self-skips on any re-run.

use crate::{Config, Followers, Following, Pallet, VoteDir, Votes, VotesByAccount};
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

/// The unchecked inner migration wrapped by [`MigrateV1ToV2`]. Register `MigrateV1ToV2` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV1ToV2<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV1ToV2<T> {
    fn on_runtime_upgrade() -> Weight {
        let mut reads: u64 = 0;
        let mut writes: u64 = 0;

        // Followers from Following (mirror each edge).
        for (follower, followee, _) in Following::<T>::iter() {
            reads = reads.saturating_add(1);
            Followers::<T>::insert(&followee, &follower, ());
            writes = writes.saturating_add(1);
        }

        // VotesByAccount from the Up rows of Votes.
        for (post, account, rec) in Votes::<T>::iter() {
            reads = reads.saturating_add(1);
            if matches!(rec.dir, VoteDir::Up) {
                VotesByAccount::<T>::insert(&account, post, ());
                writes = writes.saturating_add(1);
            }
        }

        log::info!(
            target: crate::LOG_TARGET,
            "migration v1->v2: backfilled Followers + VotesByAccount ({reads} reads, {writes} writes)",
        );
        T::DbWeight::get().reads_writes(reads, writes)
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        let following = Following::<T>::iter().count() as u64;
        let likes = Votes::<T>::iter()
            .filter(|(_, _, r)| matches!(r.dir, VoteDir::Up))
            .count() as u64;
        Ok((following, likes).encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let (following, likes): (u64, u64) = Decode::decode(&mut &state[..]).map_err(|_| {
            sp_runtime::TryRuntimeError::Other("microblog v2: bad pre_upgrade state")
        })?;
        ensure!(
            Followers::<T>::iter().count() as u64 == following,
            "microblog v2: Followers count must equal Following count"
        );
        ensure!(
            VotesByAccount::<T>::iter().count() as u64 == likes,
            "microblog v2: VotesByAccount count must equal the number of Up votes"
        );
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV1ToV2`] on `Pallet`'s storage version moving 1 → 2.
/// Idempotent — runs the inner migration only when the on-chain version is exactly 1, then writes 2.
pub type MigrateV1ToV2<T> = VersionedMigration<
    1,
    2,
    InnerMigrateV1ToV2<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
