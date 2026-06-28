//! Storage migration **v3 → v4**: backfill the top-level-post index added in spec 121.
//!
//! `TopLevelPosts` (seq → post id), `NextTopLevelSeq` (the seq counter / global top-level count) and
//! `TopLevelByAuthor` (per-author reply-free post-id list) are NEW maps, so — like the v2/v3
//! backfills — no existing row needs translating. This populates them from the forward state so
//! `feed_page` reads exactly N top-level posts (no reply over-scan) and the profile post count is the
//! author's TOP-LEVEL count, for pre-v4 data:
//!   - collect every `Posts[id]` whose `parent == None` (a top-level post — a plain post, a quote, or
//!     a poll host) in ASCENDING id order (= creation order), and for the k-th such id assign
//!     `TopLevelPosts[k] = id`, push `id` onto `TopLevelByAuthor[author]`, and set `NextTopLevelSeq`
//!     to the total.
//!
//! Ascending-id order is load-bearing: post ids are monotonic, so it reproduces the exact seq order
//! the live `index_top_level` path assigns incrementally. Content is append-only (`delete_post` was
//! removed in M0), so a single pass reconstructs the index exactly.
//!
//! Wired into the runtime's `SingleBlockMigrations` and guarded by [`VersionedMigration`], so it runs
//! exactly once (when the on-chain storage version is 3) and self-skips on any re-run.

use crate::{Config, NextTopLevelSeq, Pallet, Posts, TopLevelByAuthor, TopLevelPosts};
use alloc::vec::Vec;
use frame_support::{
	migrations::VersionedMigration,
	traits::{Get, UncheckedOnRuntimeUpgrade},
	weights::Weight,
};

// Encode/Decode + `ensure!` are only used by the try-runtime hooks below.
#[cfg(feature = "try-runtime")]
use frame_support::{ensure, pallet_prelude::*};

/// The unchecked inner migration wrapped by [`MigrateV3ToV4`]. Register `MigrateV3ToV4` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV3ToV4<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV3ToV4<T> {
	fn on_runtime_upgrade() -> Weight {
		let mut reads: u64 = 0;
		let mut writes: u64 = 0;

		// One forward pass over Posts (hash-ordered), keeping the TOP-LEVEL ids + their authors.
		let mut top: Vec<(u64, T::AccountId)> = Vec::new();
		for (id, post) in Posts::<T>::iter() {
			reads = reads.saturating_add(1);
			if post.parent.is_none() {
				top.push((id, post.author));
			}
		}
		// Sort by id so seq == creation order (post ids are monotonic) — the order the live
		// `index_top_level` path assigns incrementally.
		top.sort_unstable_by_key(|(id, _)| *id);

		let mut seq: u64 = 0;
		for (id, author) in &top {
			TopLevelPosts::<T>::insert(seq, *id);
			// `try_push` cannot exceed the bound here: `TopLevelByAuthor` is a subset of the author's
			// posts, and `ByAuthor` (the superset) already fit `MaxPostsPerAuthor`. Best-effort on the
			// impossible failure (it would only drop an over-cap tail, never corrupt other state).
			let _ = TopLevelByAuthor::<T>::try_mutate(author, |ids| ids.try_push(*id));
			seq = seq.saturating_add(1);
			writes = writes.saturating_add(2);
		}
		NextTopLevelSeq::<T>::put(seq);
		writes = writes.saturating_add(1);

		log::info!(
			target: crate::LOG_TARGET,
			"migration v3->v4: backfilled {seq} top-level posts into the index ({reads} reads, {writes} writes)",
		);
		T::DbWeight::get().reads_writes(reads, writes)
	}

	#[cfg(feature = "try-runtime")]
	fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
		// The expected top-level count = posts with no parent.
		let top = Posts::<T>::iter().filter(|(_, p)| p.parent.is_none()).count() as u64;
		Ok(top.encode())
	}

	#[cfg(feature = "try-runtime")]
	fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
		let expected: u64 = Decode::decode(&mut &state[..])
			.map_err(|_| sp_runtime::TryRuntimeError::Other("microblog v4: bad pre_upgrade state"))?;
		// The seq counter, the `TopLevelPosts` entry count, and the per-author lists must all agree
		// with the number of top-level posts (none dropped, none double-counted).
		ensure!(
			NextTopLevelSeq::<T>::get() == expected,
			"microblog v4: NextTopLevelSeq must equal the top-level post count"
		);
		ensure!(
			TopLevelPosts::<T>::iter().count() as u64 == expected,
			"microblog v4: TopLevelPosts entry count must equal the top-level post count"
		);
		let by_author: u64 = TopLevelByAuthor::<T>::iter().map(|(_, ids)| ids.len() as u64).sum();
		ensure!(
			by_author == expected,
			"microblog v4: TopLevelByAuthor lengths must sum to the top-level post count"
		);
		// Density + order (the load-bearing newest-first paging invariant, not just cardinality):
		// `TopLevelPosts` is exactly seq `0..expected`, the seq-th being the seq-th top-level id in
		// ascending id order, and nothing at `expected`.
		let mut ids: Vec<u64> =
			Posts::<T>::iter().filter(|(_, p)| p.parent.is_none()).map(|(id, _)| id).collect();
		ids.sort_unstable();
		for (seq, id) in ids.iter().enumerate() {
			ensure!(
				TopLevelPosts::<T>::get(seq as u64) == Some(*id),
				"microblog v4: TopLevelPosts[seq] must be the seq-th top-level id in ascending order"
			);
		}
		ensure!(
			TopLevelPosts::<T>::get(expected).is_none(),
			"microblog v4: TopLevelPosts must be dense 0..count (no entry at `count`)"
		);
		Ok(())
	}
}

/// The public migration: gates [`InnerMigrateV3ToV4`] on `Pallet`'s storage version moving 3 → 4.
/// Idempotent — runs the inner migration only when the on-chain version is exactly 3, then writes 4.
pub type MigrateV3ToV4<T> = VersionedMigration<
	3,
	4,
	InnerMigrateV3ToV4<T>,
	Pallet<T>,
	<T as frame_system::Config>::DbWeight,
>;
