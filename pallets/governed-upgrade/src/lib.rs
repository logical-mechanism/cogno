#![cfg_attr(not(feature = "std"), no_std)]

//! # governed-upgrade pallet — sudo-free committee-governed runtime upgrades (index 7)
//!
//! cogno-chain is **sudo-free** from genesis: there is no root/break-glass key, so the classic
//! `sudo(system.set_code(..))` dev escape hatch does not exist here. `frame_system`'s own `set_code`
//! (call_index 2) and `authorize_upgrade` (call_index 9) both hardcode `ensure_root(origin)?` — they
//! CANNOT be re-gated to the committee via `Config` — so this thin pallet provides the one missing piece:
//! a single dispatchable, [`Call::authorize_upgrade`], gated by the shared [`Config::AuthorityOrigin`]
//! (a ≥3/5 `FollowerCommittee` supermajority), that records the authorized code hash by calling
//! `frame_system`'s **origin-free** inner [`frame_system::Pallet::do_authorize_upgrade`] with
//! `check_version = true`.
//!
//! The actual (multi-hundred-KB) WASM blob is supplied **later, permissionlessly**, by anyone via the
//! existing `frame_system::apply_authorized_upgrade` (System call_index 11, "All origins are allowed"),
//! which re-derives `blake2_256(code)`, checks it matches the authorized hash, and — because the
//! authorization carried `check_version = true` — refuses a changed spec-name or a non-increasing
//! `spec_version` (`frame_system::Pallet::can_set_code`). So **the committee motion carries only the
//! 32-byte hash** (cheap to propose/vote/close), the heavy upload is a separate tx, and the "refuse a
//! non-increasing `spec_version`" guarantee comes for free from `frame_system`.
//!
//! Least-privilege: this pallet lets the committee authorize a runtime upgrade and **nothing else** — it
//! does NOT expose `set_storage`/`kill_storage`/`kill_prefix` (the other Root-only `frame_system` calls).
//! It has no storage of its own (the authorization lives in `frame_system::AuthorizedUpgrade`). It does
//! NOT touch talk-stake weight (observer-written) and no other pallet depends on it.

pub mod weights;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub use pallet::*;
pub use weights::*;

#[frame_support::pallet]
pub mod pallet {
	use super::*;
	use frame_support::pallet_prelude::*;
	use frame_system::pallet_prelude::*;

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		/// The overarching runtime event type.
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;

		/// The ONLY origin allowed to authorize a runtime upgrade. In cogno-chain this is the shared
		/// `AuthorityOrigin` — a ≥3/5 `FollowerCommittee` supermajority (sudo-free; no `EnsureRoot`
		/// fallback) — the same gate as `add_validator` / `set_members` / `revoke`.
		type AuthorityOrigin: EnsureOrigin<Self::RuntimeOrigin>;

		/// Dispatch weights.
		type WeightInfo: WeightInfo;
	}

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A runtime upgrade to `code_hash` was authorized by an [`Config::AuthorityOrigin`] (≥3/5
		/// committee) motion. The WASM is then uploaded permissionlessly via
		/// `frame_system::apply_authorized_upgrade`, which enforces the `spec_version` increase. This is
		/// the pallet-scoped audit marker for the sudo-free upgrade path (distinct from, and emitted
		/// alongside, `frame_system`'s own `UpgradeAuthorized`).
		UpgradeAuthorized { code_hash: T::Hash },
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Authorize a runtime upgrade to `code_hash` — the sudo-free, committee-governed analogue of
		/// `sudo(system.set_code(..))`. Gated by [`Config::AuthorityOrigin`] (≥3/5 committee).
		///
		/// Records the authorized hash in `frame_system` with version-checking **on**; the WASM itself is
		/// supplied later by ANYONE via the permissionless `frame_system::apply_authorized_upgrade`, which
		/// refuses a non-increasing `spec_version` / changed spec-name. There is deliberately no
		/// `authorize_upgrade_without_checks` analogue — the sudo-free path is always version-checked.
		///
		/// `code_hash` is `blake2_256(wasm)` (the runtime `Hashing`); the CLI computes it from the compiled
		/// `.wasm` so the committee can propose/vote/close on a 32-byte value, not the blob.
		#[pallet::call_index(0)]
		#[pallet::weight(<T as Config>::WeightInfo::authorize_upgrade())]
		pub fn authorize_upgrade(origin: OriginFor<T>, code_hash: T::Hash) -> DispatchResult {
			T::AuthorityOrigin::ensure_origin(origin)?;
			// `check_version = true` → `apply_authorized_upgrade` later enforces spec_name unchanged +
			// spec_version strictly increasing (`can_set_code`). This IS the sudo-free monotonicity guard.
			frame_system::Pallet::<T>::do_authorize_upgrade(code_hash, true);
			Self::deposit_event(Event::UpgradeAuthorized { code_hash });
			Ok(())
		}
	}
}
