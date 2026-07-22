//! Storage migration **v6 → v7** (spec 207): add `Poll.kind`.
//!
//! Governance polls (the SPO + dRep chambers) add a `kind` discriminant to every poll. Every existing
//! poll is a regular STAKE poll, so this appends `kind = PollKind::Stake` to each [`crate::Polls`] row —
//! a pure, lossless re-encode: every poll keeps its `options` + `close_at` unchanged, and the chamber
//! tallies are a read-time addition, not stored. `Poll` is the ONLY storage item whose shape changed, so
//! it is the only map translated.
//!
//! Like the earlier poll re-encodes, correctness rests on `translate` visiting EVERY row (the appended
//! `kind` needs a trailing byte a v6 row does not have, so an un-migrated row genuinely cannot decode as
//! the new `Poll`), and `post_upgrade` proves the row count survived and every migrated poll defaulted to
//! `Stake`. Wired into the runtime's `SingleBlockMigrations` behind [`VersionedMigration`], so it runs
//! exactly once (on-chain version 6 → 7) and self-skips on re-run.

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

/// The **v6** on-chain encoding of a poll — [`Poll`] MINUS the appended `kind`.
#[derive(
    Encode, Decode, CloneNoBound, PartialEqNoBound, EqNoBound, DebugNoBound, TypeInfo, MaxEncodedLen,
)]
#[scale_info(skip_type_params(T))]
pub struct OldPoll<T: Config> {
    pub options: BoundedVec<BoundedVec<u8, T::MaxPollOptionLen>, T::MaxPollOptions>,
    pub close_at: Option<BlockNumberFor<T>>,
}

/// The unchecked inner migration wrapped by [`MigrateV6ToV7`]. Register `MigrateV6ToV7` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV6ToV7<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV6ToV7<T> {
    fn on_runtime_upgrade() -> Weight {
        let mut rows: u64 = 0;
        // Every existing poll is a regular stake poll: append `kind = Stake`, keep options + close_at.
        Polls::<T>::translate::<OldPoll<T>, _>(|_id, old| {
            rows = rows.saturating_add(1);
            Some(Poll {
                options: old.options,
                close_at: old.close_at,
                kind: PollKind::Stake,
            })
        });
        log::info!(
            target: crate::LOG_TARGET,
            "migration v6->v7: re-encoded {rows} poll row(s) to add Poll.kind = Stake",
        );
        // 1 read + 1 write per re-encoded row.
        T::DbWeight::get().reads_writes(rows, rows)
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        // Row count via `iter_keys` (decodes only keys — value-type-independent, so it reads pre-migration).
        let polls = Polls::<T>::iter_keys().count() as u64;
        log::info!(target: crate::LOG_TARGET, "migration v6->v7 pre: {polls} Polls");
        Ok(polls.encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let polls: u64 = Decode::decode(&mut &state[..]).map_err(|_| {
            sp_runtime::TryRuntimeError::Other("microblog v7: bad pre_upgrade state")
        })?;
        // Every row still DECODES under the new `Poll` type (an un-migrated row would fail), and the count
        // is unchanged.
        ensure!(
            Polls::<T>::iter().count() as u64 == polls,
            "microblog v7: Polls row count changed / a row failed to decode"
        );
        // Every migrated poll defaults to the regular stake lens.
        ensure!(
            Polls::<T>::iter().all(|(_, p)| matches!(p.kind, PollKind::Stake)),
            "microblog v7: every migrated poll must default to kind == Stake"
        );
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV6ToV7`] on `Pallet`'s storage version moving 6 → 7.
/// Idempotent — runs the inner migration only when the on-chain version is exactly 6, then writes 7.
pub type MigrateV6ToV7<T> = VersionedMigration<
    6,
    7,
    InnerMigrateV6ToV7<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
