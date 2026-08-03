//! Storage migration **v1 → v2** (spec 217): re-derive the role badge sets so a widened cap lands.
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
//! ## What it does: re-push the basis THROUGH the sink, rather than clear and wait
//!
//! The basis row is the full set, and the sink is the thing that was truncated — so the fix is to hand
//! each basis row back to [`crate::Config::RoleSink`], which re-runs the fit under the new cap and
//! stores the result. Nothing is cleared, nothing is deferred, and no account is ever between the two
//! states.
//!
//! The obvious alternative — drop the basis and let the next observation rebuild it, the way
//! [`super::v1`] must — is wrong HERE, and not just wasteful. Dropping the basis alone leaves an account
//! whose Cardano roles have lapsed rendering a verified badge for ever (`derive_call` produces a role
//! CLEAR only by iterating the basis, so with no row there is nothing to take back). Dropping the basis
//! *and* clearing the sink fixes that but opens a window: every badge set on the chain reads EMPTY from
//! the migration until an observation lands, and an observation is not guaranteed to land in that block.
//! The node fail-closed abstains on a db-sync error, a stale tip or a timeout, and a re-emission larger
//! than `MaxChangesPerBlock` pages over several blocks. A `close_poll` inside that window computes zero
//! SPO and dRep chamber weight and zero participation, and freezes it into `PollResult` permanently —
//! there is no re-pricing path. That is the exact harm spec 217 exists to prevent, so the migration for
//! it must not open the window itself.
//!
//! Keeping the basis keeps the lapse path intact too: an account that has since lost its roles is
//! re-derived here to what it last held, and the next observation clears it exactly as it always would.
//!
//! v1 has no such choice. The pre-215 basis recorded only WHICH accounts held roles, never WHICH roles,
//! so there is nothing for it to re-push and clearing the sink is the only honest option. The live chain
//! is spec 214, so a 214 → 217 enactment takes that window from v1 regardless; what this migration can
//! do is not add a second one, and be correct on the 215/216 → 217 path where v1 does not run at all.
//!
//! ## Cost
//!
//! Two reads per basis row (the row itself, plus the sink's own read-before-write) and at most one
//! write. `apply_roles` is idempotent — it compares against what is stored and returns without writing
//! or emitting when the re-derived set matches — so on a chain where nothing was ever truncated this
//! costs reads only, and `RolesUpdated` fires precisely for the accounts the raise actually fixes.
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
        // `iter()`, not `drain()`: the basis is the INPUT here and stays exactly as it is. The sink lives
        // in another pallet's storage, so nothing writes to the map being walked.
        let mut accounts: u64 = 0;
        for (who, roles) in LastObservedRoles::<T>::iter() {
            T::RoleSink::set_roles(&who, &roles);
            accounts = accounts.saturating_add(1);
        }

        log::info!(
            target: crate::LOG_TARGET,
            "cardano-observer v1 -> v2: re-derived the badge set of {accounts} role basis row(s) under \
             the widened per-account cap; the basis itself is unchanged",
        );

        // Per row: the basis read, plus the sink's read-before-write inside `apply_roles`, plus at most
        // one write (none where the re-derived set already matches).
        T::DbWeight::get().reads_writes(accounts.saturating_mul(2), accounts)
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
        // The basis is what the re-derive reads FROM, so losing a row would silently un-badge that
        // account until its Cardano roles next moved. The pallet's own `try_state` re-checks the shape of
        // every row (bound, non-empty) after this returns.
        let after = LastObservedRoles::<T>::iter().count() as u32;
        ensure!(
            before == after,
            "v2: the role basis must be carried through untouched"
        );
        log::info!(
            target: crate::LOG_TARGET,
            "cardano-observer v1 -> v2 post_upgrade: {after} role basis row(s) re-derived, none dropped",
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
