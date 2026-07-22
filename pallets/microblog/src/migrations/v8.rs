//! Storage migration **v7 → v8** (spec 208): freeze the SPO/dRep chambers into `PollResult`.
//!
//! Governance polls (spec 207) surfaced SPO + dRep chamber tallies, but a FINALIZED poll recomputed them
//! LIVE on every read, so a concluded poll's chambers kept re-pricing as delegation later moved. spec 208
//! freezes them at `close_poll`, which appends four chamber-snapshot vecs to [`crate::PollResult`]. This
//! migration re-encodes every [`crate::PollResults`] row, defaulting the appended vecs to EMPTY (read back
//! as 0) — which is correct: any poll finalized *before* this upgrade is a pre-governance (Stake) poll with
//! no chambers. On a chain that never finalized a poll `PollResults` is empty, so this is a no-op; the live
//! chain is pre-`PollResults` entirely, so it migrates nothing.
//!
//! Like the other poll re-encodes, correctness rests on `translate` visiting EVERY row (the appended vecs
//! need trailing bytes a v7 row does not have, so an un-migrated row genuinely cannot decode as the new
//! `PollResult`), and `post_upgrade` proves the row count survived and every migrated result carries empty
//! chamber snapshots. Wired into the runtime's `SingleBlockMigrations` behind [`VersionedMigration`], so it
//! runs exactly once (on-chain version 7 → 8) and self-skips on re-run.

use crate::{Config, Pallet, PollResult, PollResults};
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

/// The **v7** on-chain encoding of a poll result — [`PollResult`] MINUS the appended chamber snapshots.
#[derive(
    Encode, Decode, CloneNoBound, PartialEqNoBound, EqNoBound, DebugNoBound, TypeInfo, MaxEncodedLen,
)]
#[scale_info(skip_type_params(T))]
pub struct OldPollResult<T: Config> {
    pub option_weights: BoundedVec<u128, T::MaxPollOptions>,
    pub option_counts: BoundedVec<u32, T::MaxPollOptions>,
    pub closed_at: BlockNumberFor<T>,
}

/// The unchecked inner migration wrapped by [`MigrateV7ToV8`]. Register `MigrateV7ToV8` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV7ToV8<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV7ToV8<T> {
    fn on_runtime_upgrade() -> Weight {
        let mut rows: u64 = 0;
        // Every existing (Stake) result gains empty chamber snapshots; options + counts + closed_at survive.
        PollResults::<T>::translate::<OldPollResult<T>, _>(|_id, old| {
            rows = rows.saturating_add(1);
            Some(PollResult {
                option_weights: old.option_weights,
                option_counts: old.option_counts,
                option_spo_weights: Default::default(),
                option_spo_counts: Default::default(),
                option_drep_weights: Default::default(),
                option_drep_counts: Default::default(),
                closed_at: old.closed_at,
            })
        });
        log::info!(
            target: crate::LOG_TARGET,
            "migration v7->v8: re-encoded {rows} PollResults row(s) to add empty chamber snapshots",
        );
        // 1 read + 1 write per re-encoded row.
        T::DbWeight::get().reads_writes(rows, rows)
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        // Row count via `iter_keys` (decodes only keys — value-type-independent, so it reads pre-migration).
        let rows = PollResults::<T>::iter_keys().count() as u64;
        log::info!(target: crate::LOG_TARGET, "migration v7->v8 pre: {rows} PollResults");
        Ok(rows.encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let rows: u64 = Decode::decode(&mut &state[..]).map_err(|_| {
            sp_runtime::TryRuntimeError::Other("microblog v8: bad pre_upgrade state")
        })?;
        // Every row still DECODES under the new `PollResult` type (an un-migrated row would fail), and the
        // count is unchanged.
        ensure!(
            PollResults::<T>::iter().count() as u64 == rows,
            "microblog v8: PollResults row count changed / a row failed to decode"
        );
        // Every migrated result defaults to empty chamber snapshots (pre-v8 finalized polls are Stake).
        ensure!(
            PollResults::<T>::iter().all(|(_, r)| r.option_spo_weights.is_empty()
                && r.option_spo_counts.is_empty()
                && r.option_drep_weights.is_empty()
                && r.option_drep_counts.is_empty()),
            "microblog v8: every migrated PollResult must default to empty chamber snapshots"
        );
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV7ToV8`] on `Pallet`'s storage version moving 7 → 8.
/// Idempotent — runs the inner migration only when the on-chain version is exactly 7, then writes 8.
pub type MigrateV7ToV8<T> = VersionedMigration<
    7,
    8,
    InnerMigrateV7ToV8<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
