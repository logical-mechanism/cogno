//! # Profile pallet (cogno-chain)
//!
//! A **mutable per-account display profile** (display name, bio, avatar reference) for the social
//! app. Distinct from the rest of the social surface: a profile is *presentation state*, not content
//! — it overwrites freely (unlike permanent posts).
//!
//! ## Placement & coupling
//! It is a STANDALONE pallet (not folded into microblog or cogno-gate) so the security-sensitive
//! identity verifier and the feeless hot path stay lean. It gates writes on a live Cardano-identity
//! binding by reusing the [`pallet_microblog::IsAllowed`] trait (wired to `CognoGate` in the runtime)
//! — the same loose-coupling seam posting uses, with no new cross-crate dependency cycle (microblog
//! is the depended-upon crate; it never names this one).
//!
//! ## Fee posture (named honestly)
//! [`Pallet::set_profile`] / [`Pallet::clear_profile`] are **fee-bearing** (NOT feeless). Profiles are
//! low-frequency, so the tx fee is its own anti-spam — exactly cogno-gate's `link_identity_signed`
//! posture. This avoids a second capacity transaction-extension (the feeless+capacity machinery stays
//! reserved for the high-frequency microblog social writes). A frontend can sponsor the fee for a
//! freshly-derived posting key the same way the bind relay does (a later, FE-side step).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

pub mod weights;
pub use weights::*;

/// Log target for this pallet's operator-facing diagnostics. Off-chain only; the on-chain audit
/// trail is the event stream.
pub const LOG_TARGET: &str = "runtime::profile";

#[frame_support::pallet]
pub mod pallet {
	use super::*;
	use alloc::vec::Vec;
	use frame_support::pallet_prelude::*;
	use frame_system::pallet_prelude::*;
	// The cross-pallet identity gate trait (defined in microblog to avoid a Cargo cycle).
	use pallet_microblog::IsAllowed;

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		/// The overarching runtime event type.
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>>
			+ IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// The Cardano-identity gate: only an account with a live 1:1 binding may set a profile.
		/// Wired to `CognoGate` in the runtime (the same `IsAllowed` impl microblog posting uses).
		type IdentityGate: IsAllowed<Self::AccountId>;
		/// Maximum display-name length in bytes.
		#[pallet::constant]
		type MaxName: Get<u32>;
		/// Maximum bio length in bytes.
		#[pallet::constant]
		type MaxBio: Get<u32>;
		/// Maximum avatar-reference length in bytes (a URL / IPFS CID — NOT image bytes).
		#[pallet::constant]
		type MaxAvatar: Get<u32>;
		/// Weight information for this pallet's dispatchables.
		type WeightInfo: WeightInfo;
	}

	/// One account's display profile. Mutable presentation state (overwritten by `set_profile`).
	///
	/// `*NoBound` derives because `Profile` is generic over `T: Config` (the bounds are on
	/// `T::MaxName`/`MaxBio`/`MaxAvatar`, not on `T` itself).
	#[derive(
		Encode, Decode, CloneNoBound, PartialEqNoBound, EqNoBound, DebugNoBound, TypeInfo, MaxEncodedLen,
	)]
	#[scale_info(skip_type_params(T))]
	pub struct Profile<T: Config> {
		/// Display name, bounded to `MaxName` bytes.
		pub display_name: BoundedVec<u8, T::MaxName>,
		/// Free-text bio, bounded to `MaxBio` bytes.
		pub bio: BoundedVec<u8, T::MaxBio>,
		/// Avatar reference (URL / IPFS CID), bounded to `MaxAvatar` bytes.
		pub avatar: BoundedVec<u8, T::MaxAvatar>,
	}

	/// Per-account profile. `OptionQuery` ⇒ `None` for an account that has never set one.
	#[pallet::storage]
	pub type Profiles<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, Profile<T>, OptionQuery>;

	/// The post id each account has pinned to the top of their profile. `None` ⇒ nothing pinned.
	/// Stored as a bare id (not validated against microblog on-chain — the FE/indexer renders it; a
	/// stale/foreign id simply shows nothing, mirroring the dangling-parent precedent).
	#[pallet::storage]
	pub type PinnedPost<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, u64, OptionQuery>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// `who` set or replaced their profile (the body is read from storage by an indexer).
		ProfileSet { who: T::AccountId },
		/// `who` cleared their profile.
		ProfileCleared { who: T::AccountId },
		/// `who` pinned post `id` to the top of their profile.
		PostPinned { who: T::AccountId, id: u64 },
		/// `who` removed their pinned post.
		PostUnpinned { who: T::AccountId },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// The caller has no live Cardano-identity binding (`IdentityGate::is_allowed` returned false).
		NotAllowed,
		/// The display name exceeded `MaxName`.
		NameTooLong,
		/// The bio exceeded `MaxBio`.
		BioTooLong,
		/// The avatar reference exceeded `MaxAvatar`.
		AvatarTooLong,
		/// `clear_profile` was called but the caller has no profile.
		NoProfile,
		/// `unpin_post` was called but the caller has nothing pinned.
		NotPinned,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Set (or overwrite) the caller's display profile. **Fee-bearing** (the caller pays the tx
		/// fee — the anti-spam for this low-frequency call). Requires a live identity binding.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::set_profile())]
		pub fn set_profile(
			origin: OriginFor<T>,
			display_name: Vec<u8>,
			bio: Vec<u8>,
			avatar: Vec<u8>,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			if !T::IdentityGate::is_allowed(&who) {
				log::debug!(target: LOG_TARGET, "set_profile rejected: identity not allowed for {who:?}");
				return Err(Error::<T>::NotAllowed.into());
			}
			let display_name: BoundedVec<u8, T::MaxName> =
				display_name.try_into().map_err(|_| Error::<T>::NameTooLong)?;
			let bio: BoundedVec<u8, T::MaxBio> = bio.try_into().map_err(|_| Error::<T>::BioTooLong)?;
			let avatar: BoundedVec<u8, T::MaxAvatar> =
				avatar.try_into().map_err(|_| Error::<T>::AvatarTooLong)?;
			Profiles::<T>::insert(&who, Profile { display_name, bio, avatar });
			Self::deposit_event(Event::ProfileSet { who });
			Ok(())
		}

		/// Clear the caller's profile. Fee-bearing. Fails `NoProfile` if there is nothing to clear.
		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::clear_profile())]
		pub fn clear_profile(origin: OriginFor<T>) -> DispatchResult {
			let who = ensure_signed(origin)?;
			ensure!(Profiles::<T>::take(&who).is_some(), Error::<T>::NoProfile);
			Self::deposit_event(Event::ProfileCleared { who });
			Ok(())
		}

		/// Pin post `id` to the top of the caller's profile (overwrites any prior pin). Fee-bearing;
		/// requires a live identity binding. The post id is not validated on-chain (FE renders it).
		#[pallet::call_index(2)]
		#[pallet::weight(T::WeightInfo::pin_post())]
		pub fn pin_post(origin: OriginFor<T>, id: u64) -> DispatchResult {
			let who = ensure_signed(origin)?;
			if !T::IdentityGate::is_allowed(&who) {
				log::debug!(target: LOG_TARGET, "pin_post rejected: identity not allowed for {who:?}");
				return Err(Error::<T>::NotAllowed.into());
			}
			PinnedPost::<T>::insert(&who, id);
			Self::deposit_event(Event::PostPinned { who, id });
			Ok(())
		}

		/// Remove the caller's pinned post. Fee-bearing. Fails `NotPinned` if nothing is pinned. No
		/// identity gate (a revoked account may still tidy up its own state).
		#[pallet::call_index(3)]
		#[pallet::weight(T::WeightInfo::unpin_post())]
		pub fn unpin_post(origin: OriginFor<T>) -> DispatchResult {
			let who = ensure_signed(origin)?;
			ensure!(PinnedPost::<T>::take(&who).is_some(), Error::<T>::NotPinned);
			Self::deposit_event(Event::PostUnpinned { who });
			Ok(())
		}
	}
}
