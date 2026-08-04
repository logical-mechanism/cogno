//! Storage migration **v11 → v12** (spec 225): backfill the ordered likes index.
//!
//! `LikesByAccount[account][desc_key(post)] = ()` is the index [`crate::Pallet::likes_page`] now walks.
//! Live state has none of it — every like cast before this upgrade only ever wrote the hash-ordered
//! [`crate::VotesByAccount`] — so without this backfill a pre-upgrade Likes tab reads as EMPTY. It is the
//! same load-bearing shape as [`super::v11`]'s reply spine, for the same reason.
//!
//! The source is `VotesByAccount`, which the pallet STILL DECLARES, and the destination is a brand new
//! prefix. So, exactly as in `v11`, there is no retired shape to re-address and therefore no
//! `#[storage_alias]` anywhere near this file — the trap that macro sets (it takes the on-chain item name
//! from the ALIAS TYPE NAME, so a `FooV11` alias silently addresses a prefix nothing ever wrote and the
//! migration iterates zero rows while reporting success) cannot be sprung here.
//!
//! **ONE STREAMING PASS, no buffer at all.** `v11` had to drain its source into a `BTreeSet` first
//! because the destination's `seq` had to be assigned in a specific order that the hash-ordered source
//! does not iterate in. This migration has no such problem: the destination key is a pure function of
//! the post id ([`crate::Pallet::desc_key`]), so a row can be written the moment it is read and the
//! source's iteration order is irrelevant. That is worth saying out loud, because "collect first" is the
//! pattern next door and copying it here would reintroduce an O(#likes) heap allocation for nothing.
//!
//! Iterating one storage item while writing another is safe: `KeyPrefixIterator` walks
//! `sp_io::storage::next_key` filtered by the SOURCE prefix (`twox128("Microblog") ++
//! twox128("VotesByAccount")`), and every key written lands under a different second half, so nothing
//! written can appear in what is being read. This is the same distinct-prefix argument `v11` makes; it is
//! `v10` — where the old and new items shared a prefix — that needed a read-remove-then-write ordering
//! rule, and none of that applies here.
//!
//! The membership map is KEPT, not replaced. It answers "does this account like that post?" in O(1),
//! which the viewer overlay and `try_state` both use, and retiring it would turn this into a
//! rows-moving migration that needs a retired-shape alias and a prefix sweep. Two items maintained in
//! lockstep by one writer is the deal `RepliesByParent` + `RepliesByParentSeq` already struck in this
//! pallet, and `try_state` pins the two as equal sets in both directions.
//!
//! Cost, measured against live preprod at block 417 429: **33 `VotesByAccount` rows across 6 accounts**.
//! That is 33 reads and 33 writes, with no heap. A fresh mainnet genesis has none. Wired into the
//! runtime's `SingleBlockMigrations` behind [`VersionedMigration`], so it runs exactly once (on-chain
//! version 11 → 12) and self-skips on re-run.

use crate::{Config, LikesByAccount, Pallet, VotesByAccount};
use frame_support::{
    migrations::VersionedMigration,
    traits::{Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
};

// `Encode`/`Decode` (for the pre/post-upgrade state blob) and `ensure!` are only used by the
// try-runtime hooks below.
#[cfg(feature = "try-runtime")]
use alloc::vec::Vec;
#[cfg(feature = "try-runtime")]
use frame_support::{ensure, pallet_prelude::*};

/// The unchecked inner migration wrapped by [`MigrateV11ToV12`]. Register `MigrateV11ToV12` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV11ToV12<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV11ToV12<T> {
    fn on_runtime_upgrade() -> Weight {
        let mut rows: u64 = 0;
        // `iter_keys`, not `iter`: the value is `()` and carries nothing, and a key walk also yields a
        // row whose value somehow failed to decode — which `iter` would silently skip, leaving that
        // like present in the membership map and absent from the index for ever.
        for (who, post) in VotesByAccount::<T>::iter_keys() {
            LikesByAccount::<T>::insert(&who, Pallet::<T>::desc_key(post), ());
            rows = rows.saturating_add(1);
        }

        log::info!(
            target: crate::LOG_TARGET,
            "migration v11->v12: backfilled the ordered likes index ({rows} like row(s))",
        );
        T::DbWeight::get().reads_writes(rows, rows)
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        use crate::{VoteDir, Votes};
        let rows: u64 = VotesByAccount::<T>::iter_keys().count() as u64;
        // The independent second opinion on how many rows SHOULD land. `Votes` is maintained by the
        // same writer but is a DIFFERENT storage item, so agreeing with it proves the walk saw the whole
        // index rather than proving the walk agrees with itself. (`check_tally_consistency` already
        // requires the two to match both ways, so a disagreement here is a pre-existing fault rather
        // than one this migration introduced — worth failing the dry-run over either way.)
        let up_votes: u64 = Votes::<T>::iter()
            .filter(|(_, _, r)| r.dir == VoteDir::Up)
            .count() as u64;
        // Nothing may exist under the new prefix yet: it is a fresh item, and a non-empty one would
        // mean the version guard let a re-run through.
        ensure!(
            LikesByAccount::<T>::iter_keys().next().is_none(),
            "microblog v12: LikesByAccount must be empty before the backfill"
        );
        log::info!(
            target: crate::LOG_TARGET,
            "migration v11->v12 pre: {rows} VotesByAccount row(s), {up_votes} Up vote(s)",
        );
        Ok((rows, up_votes).encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let (rows, up_votes): (u64, u64) = Decode::decode(&mut &state[..]).map_err(|_| {
            sp_runtime::TryRuntimeError::Other("microblog v12: bad pre_upgrade state")
        })?;
        ensure!(
            rows == up_votes,
            "microblog v12: VotesByAccount and the Up rows of Votes disagreed before the backfill"
        );
        // Exactly one ordered row per like — none dropped, none written twice.
        ensure!(
            LikesByAccount::<T>::iter_keys().count() as u64 == rows,
            "microblog v12: LikesByAccount row count must equal the VotesByAccount row count"
        );
        // The set equality `try_state` will enforce from here on, checked both ways once at the seam.
        // (`try_state` runs it too, but only if the dry-run is invoked with `--checks all`; a migration
        // that silently half-populated its index should fail on its OWN post_upgrade.)
        ensure!(
            VotesByAccount::<T>::iter_keys().all(|(who, post)| LikesByAccount::<T>::contains_key(
                &who,
                Pallet::<T>::desc_key(post)
            )),
            "microblog v12: a liked post is missing from the ordered index"
        );
        ensure!(
            LikesByAccount::<T>::iter_keys().all(|(who, key)| VotesByAccount::<T>::contains_key(
                &who,
                Pallet::<T>::post_of_desc_key(key)
            )),
            "microblog v12: an ordered-index row names a post that is not liked"
        );
        // The ordering the whole change exists for: iterating one account's prefix must yield STRICTLY
        // DESCENDING post ids. This is the one property no unit test on a mock can prove about live
        // state, and it is the one that silently degrades to nonsense if the key encoding is ever
        // "tidied" from big-endian `[u8; 8]` to a plain `u64`.
        for (who, _) in VotesByAccount::<T>::iter_keys() {
            let mut prev: Option<u64> = None;
            for key in LikesByAccount::<T>::iter_key_prefix(&who) {
                let id = Pallet::<T>::post_of_desc_key(key);
                if let Some(p) = prev {
                    ensure!(
                        id < p,
                        "microblog v12: LikesByAccount does not iterate in descending post id"
                    );
                }
                prev = Some(id);
            }
        }
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV11ToV12`] on `Pallet`'s storage version moving 11 → 12.
/// Idempotent — runs the inner migration only when the on-chain version is exactly 11, then writes 12.
pub type MigrateV11ToV12<T> = VersionedMigration<
    11,
    12,
    InnerMigrateV11ToV12<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
