//! Storage migration **v0 → v1**: add `quote: Option<u64>` to [`crate::Post`].
//!
//! This is cogno-chain's first runtime storage migration. Adding a field re-encodes every
//! [`crate::Posts`] row, so old rows (which lack `quote`) can no longer be decoded under the new
//! `Post` type until they are translated. The migration decodes each row as [`OldPost`] (the exact
//! v0 layout), rebuilds it as the new [`crate::Post`] with `quote: None`, and writes it back. Real
//! preprod posts created at v0 survive unchanged except for the defaulted `quote`.
//!
//! It is wired into the runtime's `SingleBlockMigrations` and guarded by [`VersionedMigration`], so
//! it runs exactly once (when the on-chain storage version is 0) and self-skips on any re-run.

use crate::{Config, Pallet, Post, Posts};
use frame_support::{
	migrations::VersionedMigration,
	pallet_prelude::*,
	traits::{Get, UncheckedOnRuntimeUpgrade},
	weights::Weight,
	BoundedVec,
};
use frame_system::pallet_prelude::BlockNumberFor;

#[cfg(feature = "try-runtime")]
extern crate alloc;
#[cfg(feature = "try-runtime")]
use alloc::vec::Vec;

/// The **v0** on-chain encoding of `Post` — byte-identical to today's [`crate::Post`] MINUS the
/// `quote` field. The `*NoBound` derives + `skip_type_params(T)` mirror the live struct so SCALE
/// decode of an old row succeeds. (Field order matters: it must match the v0 wire order exactly.)
#[derive(
	Encode, Decode, CloneNoBound, PartialEqNoBound, EqNoBound, DebugNoBound, TypeInfo, MaxEncodedLen,
)]
#[scale_info(skip_type_params(T))]
pub struct OldPost<T: Config> {
	/// The author's account id.
	pub author: T::AccountId,
	/// The post body.
	pub text: BoundedVec<u8, T::MaxLength>,
	/// Optional parent post id (reply).
	pub parent: Option<u64>,
	/// The block number at which the post was created.
	pub at: BlockNumberFor<T>,
}

/// The unchecked inner migration wrapped by [`MigrateV0ToV1`]. Do not register this directly —
/// register `MigrateV0ToV1` (the version-guarded wrapper) so it is idempotent.
pub struct InnerMigrateV0ToV1<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV0ToV1<T> {
	fn on_runtime_upgrade() -> Weight {
		let mut count: u64 = 0;
		// `translate` drains each value (decoding it as `OldPost`) and re-inserts the mapped `Post`
		// under the same key: one read + one write per row. Returning `Some(..)` keeps the row.
		Posts::<T>::translate::<OldPost<T>, _>(|_id, old| {
			count = count.saturating_add(1);
			Some(Post::<T> {
				author: old.author,
				text: old.text,
				parent: old.parent,
				at: old.at,
				quote: None, // pre-v1 posts have no quote
			})
		});
		log::info!(
			target: crate::LOG_TARGET,
			"migration v0->v1: translated {count} Posts row(s) to add `quote: None`",
		);
		T::DbWeight::get().reads_writes(count, count)
	}

	#[cfg(feature = "try-runtime")]
	fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
		let n = Posts::<T>::iter().count() as u64;
		Ok(n.encode())
	}

	#[cfg(feature = "try-runtime")]
	fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
		let before: u64 = Decode::decode(&mut &state[..])
			.map_err(|_| sp_runtime::TryRuntimeError::Other("microblog v1: bad pre_upgrade state"))?;
		let after = Posts::<T>::iter().count() as u64;
		ensure!(before == after, "microblog v1: Posts count changed during migration");
		ensure!(
			Posts::<T>::iter().all(|(_, p)| p.quote.is_none()),
			"microblog v1: every migrated post must have quote == None"
		);
		Ok(())
	}
}

/// The public migration: gates [`InnerMigrateV0ToV1`] on `Pallet`'s storage version moving 0 → 1.
/// Idempotent — `VersionedMigration` runs the inner migration only when the on-chain version is
/// exactly 0, then writes version 1; a re-run on an already-migrated chain is a no-op (one read).
pub type MigrateV0ToV1<T> = VersionedMigration<
	0,
	1,
	InnerMigrateV0ToV1<T>,
	Pallet<T>,
	<T as frame_system::Config>::DbWeight,
>;
