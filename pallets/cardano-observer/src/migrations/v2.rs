//! Storage migration **v1 → v2** (spec 217): re-derive the role basis so a widened badge cap lands.
//!
//! Spec 217 raises `pallet_cardano_roles::MAX_OBSERVED_ROLES_PER_ACCOUNT` from 16 to 32, so that a real
//! mSPO stops having its surplus pools truncated out of its badge set — and out of the governance-poll
//! chamber weight and participation count that `poll_chamber_weights` derives from that same set.
//!
//! ## Why a constant raise needs a migration at all
//!
//! It does NOT need one for decode safety. `ObservedRoleSet` is a `BoundedVec`, whose `Decode` reads a
//! compact length and then bound-checks it, so every stored row (length ≤ 16 ≤ 32) decodes byte-
//! identically under the wider bound. Nothing has to be rewritten to be *readable*. (Narrowing would be
//! the unsafe direction: `ObservedRoles` is `ValueQuery`, so an over-long row would fail to decode and
//! hand back a silently EMPTY badge set.)
//!
//! It needs one because the raise is otherwise INERT on exactly the accounts it is meant to fix.
//! [`crate::Pallet::derive_call`] emits a `RoleChange` only where the newly-derived set DIFFERS from
//! [`crate::LastObservedRoles`] — and that basis is bounded by `Config::MaxRolesPerAccount` (32), which
//! the sink cap never touched. So a truncated account's basis row already held the FULL set: the diff
//! sees no difference, emits nothing, and `pallet_cardano_roles::ObservedRoles` keeps serving the old
//! 16-badge row until that operator's Cardano roles happen to change. The under-count the raise exists
//! to remove would survive the upgrade that removes it.
//!
//! ## What it does
//!
//! Clears the role basis, and clears the SINK for every account it drops — the same pairing, for the
//! same reason, as [`super::v1`]. Dropping the basis row alone would be a half-measure with a nasty
//! failure mode: `derive_call` produces a role CLEAR only by iterating the basis, so an account whose
//! roles have lapsed since the last observation would be absent from both the basis and the snapshot,
//! no change would ever be emitted for it, and it would keep rendering a verified badge (and feeding
//! its pool's stake into every chamber tally) for ever. `unclaim_role` and `revoke_role` deliberately
//! do not clear `ObservedRoles` — they document that "the observer drops the badge on its next
//! observation", which is precisely the promise a bare basis drop would break, and for the
//! `revoke_role` case the credential is tombstoned so the account can never self-heal by re-claiming.
//!
//! Clearing both is safe in both directions: an account that still holds roles is re-emitted IN FULL by
//! the enactment block's own `create_inherent` (which runs later in the same block, against the migrated
//! state) and lands under the new, wider cap, so the clear is invisible; an account that has lost them
//! stays cleared, which is the truth.
//!
//! ## On the live chain this is a no-op, and it is still worth having
//!
//! The live chain is spec 214, so enacting 217 runs [`super::v1`] first, and v1 already empties the role
//! basis and clears the sink. This migration then iterates zero rows. Its value is that it makes the cap
//! raise correct on ANY enactment path rather than only on the one that happens to ship v1 alongside it —
//! a chain already at 215 or 216 would otherwise take the raise and keep serving truncated rows, with
//! nothing anywhere reporting it.
//!
//! Wired into the runtime's `SingleBlockMigrations` behind [`VersionedMigration`], so it runs exactly
//! once (on-chain version 1 → 2) and self-skips on re-run.

use crate::{Config, LastObservedRoles, Pallet, RoleSink};
use frame_support::{
    migrations::VersionedMigration,
    traits::{Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
};

#[cfg(feature = "try-runtime")]
use alloc::vec::Vec;
#[cfg(feature = "try-runtime")]
use codec::{Decode, Encode};
#[cfg(feature = "try-runtime")]
use frame_support::ensure;

pub struct InnerMigrateV1ToV2<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV1ToV2<T> {
    fn on_runtime_upgrade() -> Weight {
        // `drain()` reads and removes in one pass, so there is no window in which the basis is half
        // cleared and no second iteration over a map being mutated.
        let mut accounts: u64 = 0;
        for (who, _roles) in LastObservedRoles::<T>::drain() {
            T::RoleSink::set_roles(&who, &[]);
            accounts = accounts.saturating_add(1);
        }

        log::info!(
            target: crate::LOG_TARGET,
            "cardano-observer v1 -> v2: dropped {accounts} role basis row(s) and cleared their badge \
             sets; the next observation re-derives every one under the widened per-account cap",
        );

        // One read + one kill per drained row, plus one sink clear each (the roles pallet's `apply_roles`
        // does a single `ObservedRoles::remove` for an empty set).
        T::DbWeight::get().reads_writes(accounts, accounts.saturating_mul(2))
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        let accounts = LastObservedRoles::<T>::iter().count() as u32;
        log::info!(
            target: crate::LOG_TARGET,
            "cardano-observer v1 -> v2 pre_upgrade: role_accounts={accounts}",
        );
        Ok(accounts.encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        let before: u32 =
            Decode::decode(&mut &state[..]).map_err(|_| "v2 post_upgrade: undecodable state")?;
        ensure!(
            LastObservedRoles::<T>::iter().next().is_none(),
            "v2: the role basis should be empty after the migration"
        );
        log::info!(
            target: crate::LOG_TARGET,
            "cardano-observer v1 -> v2 post_upgrade: {before} role basis row(s) cleared",
        );
        Ok(())
    }
}

/// The registered migration: version-guarded, so it runs exactly once and self-skips afterwards.
pub type MigrateV1ToV2<T> = VersionedMigration<
    1,
    2,
    InnerMigrateV1ToV2<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
