//! Storage migrations for `pallet-cardano-roles`.
//!
//! `v0 → v1` (spec 207) adds the governance-poll chamber `weight` to every [`crate::ObservedRole`]. The
//! role tag gains a delegated-stake weight (a pool's total delegated stake for an ownership SPO, a dRep's
//! total delegated voting stake) that governance polls tally the role's vote by. This migration re-encodes
//! every [`crate::ObservedRoles`] row, appending `weight = 0`; the observer overwrites each account's set
//! with the LIVE delegated stake on its next observation, so the zero is a transient placeholder only.
//!
//! The pallet shipped (spec 206) without an explicit storage version, so its on-chain version is the
//! implicit `0`. Declaring `STORAGE_VERSION = 1` + this [`VersionedMigration`] moves it `0 → 1` exactly
//! once: it self-skips if the version has already advanced, and is a no-op on a chain where the pallet was
//! introduced together with this change (`ObservedRoles` is then empty). `translate` visits every row (an
//! un-migrated row lacks the appended `u128` weight byte, so it genuinely cannot decode as the new
//! `ObservedRole`), so no residual old-format row survives a completed run.

use crate::{
    Config, ObservedRole, ObservedRoleSet, ObservedRoles, Pallet, RoleCredential, RoleKind,
    MAX_OBSERVED_ROLES_PER_ACCOUNT,
};
use frame_support::{
    migrations::VersionedMigration,
    pallet_prelude::*,
    traits::{Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
    BoundedVec,
};

// `Vec`, `ensure!`, and `sp_runtime` are only used by the try-runtime hooks below. The roles pallet has no
// direct `sp-runtime` dependency, so reach `TryRuntimeError` through frame_support's re-export.
#[cfg(feature = "try-runtime")]
use alloc::vec::Vec;
#[cfg(feature = "try-runtime")]
use frame_support::ensure;
#[cfg(feature = "try-runtime")]
use frame_support::sp_runtime;

/// The **v0** on-chain encoding of an observed role — [`ObservedRole`] MINUS the appended chamber `weight`.
#[derive(Clone, PartialEq, Eq, Encode, Decode, MaxEncodedLen, TypeInfo, Debug)]
pub struct OldObservedRole {
    pub kind: RoleKind,
    pub id: RoleCredential,
}

/// The v0 observed-role set (the same bound the live type uses), re-declared over [`OldObservedRole`].
type OldObservedRoleSet = BoundedVec<OldObservedRole, ConstU32<MAX_OBSERVED_ROLES_PER_ACCOUNT>>;

/// The unchecked inner migration wrapped by [`MigrateV0ToV1`]. Register `MigrateV0ToV1` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV0ToV1<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV0ToV1<T> {
    fn on_runtime_upgrade() -> Weight {
        let mut rows: u64 = 0;
        ObservedRoles::<T>::translate::<OldObservedRoleSet, _>(|_who, old| {
            rows = rows.saturating_add(1);
            let mut new = ObservedRoleSet::default();
            for r in old.into_iter() {
                // weight 0 until the observer re-derives the live delegated stake next block (both bounds
                // are identical, so every push fits).
                let _ = new.try_push(ObservedRole {
                    kind: r.kind,
                    id: r.id,
                    weight: 0,
                });
            }
            Some(new)
        });
        log::info!(
            target: crate::LOG_TARGET,
            "migration v0->v1: re-encoded {rows} ObservedRoles row(s) to add chamber weight = 0 (re-derived by the observer next block)",
        );
        // 1 read + 1 write per re-encoded row.
        T::DbWeight::get().reads_writes(rows, rows)
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        let rows = ObservedRoles::<T>::iter_keys().count() as u64;
        log::info!(target: crate::LOG_TARGET, "migration v0->v1 pre: {rows} ObservedRoles");
        Ok(rows.encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let rows: u64 = Decode::decode(&mut &state[..]).map_err(|_| {
            sp_runtime::TryRuntimeError::Other("cardano-roles v1: bad pre_upgrade state")
        })?;
        // Every row still DECODES under the new `ObservedRole` type (an un-migrated row would fail), and
        // the count is unchanged.
        ensure!(
            ObservedRoles::<T>::iter().count() as u64 == rows,
            "cardano-roles v1: ObservedRoles row count changed / a row failed to decode"
        );
        // Every migrated role defaults to weight 0 (the observer re-derives the live weight next block).
        ensure!(
            ObservedRoles::<T>::iter().all(|(_, set)| set.iter().all(|r| r.weight == 0)),
            "cardano-roles v1: every migrated role must default to weight == 0"
        );
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV0ToV1`] on `Pallet`'s storage version moving 0 → 1.
/// Idempotent — runs only when the on-chain version is exactly 0, then writes 1.
pub type MigrateV0ToV1<T> = VersionedMigration<
    0,
    1,
    InnerMigrateV0ToV1<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
