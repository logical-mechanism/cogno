//! Storage migration **v0 → v1**: add `banner` / `location` / `website` to [`crate::Profile`] (spec 118).
//!
//! Adding fields re-encodes every [`crate::Profiles`] row, so old rows (which lack the three new
//! fields) can no longer be decoded under the new `Profile` type until translated. This migration
//! decodes each row as [`OldProfile`] (the exact v0 layout) and rebuilds it as the new
//! [`crate::Profile`] with the three new `BoundedVec`s defaulted empty. Real profiles survive
//! unchanged except for the appended-empty fields.
//!
//! Wired into the runtime's `SingleBlockMigrations` and guarded by [`VersionedMigration`], so it runs
//! exactly once (when the on-chain storage version is 0) and self-skips on any re-run.

use crate::{Config, Pallet, Profile, Profiles};
use frame_support::{
    migrations::VersionedMigration,
    pallet_prelude::*,
    traits::{Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
    BoundedVec,
};

#[cfg(feature = "try-runtime")]
extern crate alloc;
#[cfg(feature = "try-runtime")]
use alloc::vec::Vec;

/// The **v0** on-chain encoding of `Profile` — byte-identical to today's [`crate::Profile`] MINUS the
/// `banner` / `location` / `website` fields. Field order must match the v0 wire order exactly.
#[derive(
    Encode, Decode, CloneNoBound, PartialEqNoBound, EqNoBound, DebugNoBound, TypeInfo, MaxEncodedLen,
)]
#[scale_info(skip_type_params(T))]
pub struct OldProfile<T: Config> {
    pub display_name: BoundedVec<u8, T::MaxName>,
    pub bio: BoundedVec<u8, T::MaxBio>,
    pub avatar: BoundedVec<u8, T::MaxAvatar>,
}

/// The unchecked inner migration wrapped by [`MigrateV0ToV1`]. Register `MigrateV0ToV1` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV0ToV1<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV0ToV1<T> {
    fn on_runtime_upgrade() -> Weight {
        let mut count: u64 = 0;
        Profiles::<T>::translate::<OldProfile<T>, _>(|_who, old| {
            count = count.saturating_add(1);
            Some(Profile::<T> {
                display_name: old.display_name,
                bio: old.bio,
                avatar: old.avatar,
                banner: BoundedVec::default(),
                location: BoundedVec::default(),
                website: BoundedVec::default(),
            })
        });
        log::info!(
            target: crate::LOG_TARGET,
            "migration v0->v1: translated {count} Profiles row(s) (banner/location/website defaulted empty)",
        );
        T::DbWeight::get().reads_writes(count, count)
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        Ok((Profiles::<T>::iter().count() as u64).encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let before: u64 = Decode::decode(&mut &state[..])
            .map_err(|_| sp_runtime::TryRuntimeError::Other("profile v1: bad pre_upgrade state"))?;
        let after = Profiles::<T>::iter().count() as u64;
        ensure!(
            before == after,
            "profile v1: Profiles count changed during migration"
        );
        ensure!(
            Profiles::<T>::iter()
                .all(|(_, p)| p.banner.is_empty() && p.location.is_empty() && p.website.is_empty()),
            "profile v1: migrated profiles must have empty banner/location/website"
        );
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV0ToV1`] on `Pallet`'s storage version moving 0 → 1.
pub type MigrateV0ToV1<T> = VersionedMigration<
    0,
    1,
    InnerMigrateV0ToV1<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
