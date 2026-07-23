//! Storage migration **v8 → v9** (spec 209): add `Poll.action`.
//!
//! spec 209 adds two new [`crate::PollKind`] variants (`Spo`, `Drep`) and an optional governance-action
//! tag to every poll. The new enum variants need no data change (existing rows are `Stake`/`Governance`,
//! whose discriminants are unmoved), but the appended `Poll.action` field does: every existing poll is
//! untagged, so this appends `action = None` to each [`crate::Polls`] row — a pure, lossless re-encode
//! that keeps `options` + `close_at` + `kind` unchanged. `Poll` is the ONLY storage item whose shape
//! changed, so it is the only map translated.
//!
//! Like the earlier poll re-encodes, correctness rests on `translate` visiting EVERY row (the appended
//! `Option` needs a trailing byte a v8 row does not have, so an un-migrated row genuinely cannot decode as
//! the new `Poll`), and `post_upgrade` proves the row count survived and every migrated poll defaulted to
//! `action = None`. Wired into the runtime's `SingleBlockMigrations` behind [`VersionedMigration`], so it
//! runs exactly once (on-chain version 8 → 9) and self-skips on re-run.

use crate::{Config, Pallet, Poll, PollKind, Polls};
use frame_support::{
    migrations::VersionedMigration,
    pallet_prelude::*,
    traits::{Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
    BoundedVec,
};
use frame_system::pallet_prelude::BlockNumberFor;

// `Vec` + `ensure!` are only used by the try-runtime hooks below.
#[cfg(feature = "try-runtime")]
use alloc::vec::Vec;
#[cfg(feature = "try-runtime")]
use frame_support::ensure;

/// The **v8** on-chain encoding of a poll — [`Poll`] MINUS the appended `action`.
#[derive(
    Encode, Decode, CloneNoBound, PartialEqNoBound, EqNoBound, DebugNoBound, TypeInfo, MaxEncodedLen,
)]
#[scale_info(skip_type_params(T))]
pub struct OldPoll<T: Config> {
    pub options: BoundedVec<BoundedVec<u8, T::MaxPollOptionLen>, T::MaxPollOptions>,
    pub close_at: Option<BlockNumberFor<T>>,
    pub kind: PollKind,
}

/// The unchecked inner migration wrapped by [`MigrateV8ToV9`]. Register `MigrateV8ToV9` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV8ToV9<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV8ToV9<T> {
    fn on_runtime_upgrade() -> Weight {
        let mut rows: u64 = 0;
        // Every existing poll is untagged: append `action = None`, keep options + close_at + kind.
        Polls::<T>::translate::<OldPoll<T>, _>(|_id, old| {
            rows = rows.saturating_add(1);
            Some(Poll {
                options: old.options,
                close_at: old.close_at,
                kind: old.kind,
                action: None,
            })
        });
        log::info!(
            target: crate::LOG_TARGET,
            "migration v8->v9: re-encoded {rows} poll row(s) to add Poll.action = None",
        );
        // 1 read + 1 write per re-encoded row.
        T::DbWeight::get().reads_writes(rows, rows)
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        // Row count via `iter_keys` (decodes only keys — value-type-independent, so it reads pre-migration).
        let polls = Polls::<T>::iter_keys().count() as u64;
        log::info!(target: crate::LOG_TARGET, "migration v8->v9 pre: {polls} Polls");
        Ok(polls.encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let polls: u64 = Decode::decode(&mut &state[..]).map_err(|_| {
            sp_runtime::TryRuntimeError::Other("microblog v9: bad pre_upgrade state")
        })?;
        // Every row still DECODES under the new `Poll` type (an un-migrated row would fail), and the count
        // is unchanged.
        ensure!(
            Polls::<T>::iter().count() as u64 == polls,
            "microblog v9: Polls row count changed / a row failed to decode"
        );
        // Every migrated poll defaults to no governance-action tag.
        ensure!(
            Polls::<T>::iter().all(|(_, p)| p.action.is_none()),
            "microblog v9: every migrated poll must default to action == None"
        );
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV8ToV9`] on `Pallet`'s storage version moving 8 → 9.
/// Idempotent — runs the inner migration only when the on-chain version is exactly 8, then writes 9.
pub type MigrateV8ToV9<T> = VersionedMigration<
    8,
    9,
    InnerMigrateV8ToV9<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
