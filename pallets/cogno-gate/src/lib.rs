//! # Cogno-gate pallet (cogno-chain)
//!
//! **The anti-Sybil identity anchor (M2): a hard 1:1 binding between a Cardano owner
//! Address and a Substrate posting account.** This is the "Cardano READ link" — the gate that
//! turns an anonymous sr25519 key into a Cardano-anchored identity so that one Cardano owner
//! Address maps to exactly one posting account, and back (`L3-chain.md` §4.1, `L2-follower.md`
//! §7/§8, DR-01/DR-02/DR-07/DR-14).
//!
//! ## What is bound (DR-01)
//! The key is the **32-byte `blake2b_256` of the serialized owner Cardano Address** (== the L1
//! beacon `token_name`), NOT a bare 28-byte payment-key-hash. Identity is the *whole* CIP-19
//! Address (payment + stake credential). The chain does **zero** Cardano/CIP-8 crypto: the
//! trusted off-chain Cogno-Follower verifies the CIP-8 signature (reusing `pycardano.cip.cip8.
//! verify`) and submits the already-computed 32-byte hash through [`Config::FollowerOrigin`].
//! The on-chain self-proof (runtime ed25519 verify) is the deferred D1 upgrade.
//!
//! ## The 1:1 Sybil invariant (do not break it)
//! `link_identity` rejects a second bind on **either** side — [`PkhOf`] (account → identity)
//! and [`AccountOf`] (identity → account) are both checked. Skipping the reverse-map check
//! would let one identity bind many accounts → multiply talk capacity → defeat the entire
//! anti-Sybil purpose of the chain.
//!
//! ## Loose coupling (the M2 architectural gotcha)
//! cogno-gate calls **into** `pallet-microblog` ([`pallet_microblog::OnIdentityBind`] →
//! `on_first_bind`) at link, and microblog calls **into** cogno-gate
//! ([`pallet_microblog::IsAllowed`] → `is_allowed`) at post. Implementing that literally would
//! make each pallet Cargo-depend on the other (a cycle). It is broken by two traits that BOTH
//! live in `pallet-microblog` (the depended-upon crate): cogno-gate *implements* `IsAllowed`
//! and *consumes* `OnIdentityBind` (wired to `Microblog` in the runtime). Neither pallet names
//! the other's crate in a trait bound.
//!
//! ## v1 trust posture (named honestly — DR-07)
//! `FollowerOrigin` is a single trusted key (+ `EnsureRoot` sudo escape hatch) in v1 dev — the
//! crown jewel: its compromise = arbitrary identity forgery. It is an `EnsureOrigin`, so the
//! widen to a 3-of-5 k-of-t committee (D2, before any mainnet) is signature-free.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub mod weights;
pub use weights::*;

/// The on-chain identity key: the 32-byte `blake2b_256` of the serialized owner Cardano
/// Address (== the L1 beacon `token_name`, DR-01). A fixed `[u8; 32]` (not a `BoundedVec`):
/// it is exactly a hash, so the codec enforces the length for free and the `AccountOf` key is
/// the raw 32 bytes with no length prefix — the client's `AccountOf` readback keys on the
/// identical bytes.
pub type IdentityHash = [u8; 32];

#[frame_support::pallet]
pub mod pallet {
	use super::*;
	use alloc::vec::Vec;
	use frame_support::pallet_prelude::*;
	use frame_system::pallet_prelude::*;
	// The two cross-pallet traits live in microblog (the depended-upon crate) to avoid a
	// dependency cycle — see the module docs. cogno-gate implements `IsAllowed` and consumes
	// `OnIdentityBind`.
	use pallet_microblog::{IsAllowed, OnIdentityBind};

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		/// The overarching runtime event type.
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>>
			+ IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// The authority allowed to write identity bindings — the trusted Cogno-Follower in the
		/// full system; a single key **plus `EnsureRoot`/sudo escape hatch** in v1 dev (DR-07).
		/// An `EnsureOrigin` (never `ensure_signed`): the public pool must not be able to forge
		/// identities. Same shape as `pallet-talk-stake`'s `SetStakeOrigin` — identity and
		/// weight share one trust boundary — so the widen to a k-of-t committee is signature-free.
		type FollowerOrigin: EnsureOrigin<Self::RuntimeOrigin>;
		/// First-bind hook into `pallet-microblog`: primes the capacity row + a provider
		/// reference so a freshly-bound feeless poster's first post is not rejected by
		/// `CheckNonce` (issue #3991). Wired to `Microblog` in the runtime. Defined in microblog
		/// (not here) to avoid a Cargo dependency cycle. `on_first_bind` is idempotent and
		/// already owns the `inc_providers` call — do not increment providers again here.
		type OnBind: OnIdentityBind<Self::AccountId>;
		/// Weight information for this pallet's dispatchables.
		type WeightInfo: WeightInfo;
	}

	/// Forward map: posting account → its bound 32-byte Cardano identity hash. `is_allowed`
	/// (the microblog post gate) is `contains_key` on this map. `OptionQuery` ⇒ an unbound
	/// account reads `None` ⇒ cannot post.
	#[pallet::storage]
	pub type PkhOf<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, IdentityHash, OptionQuery>;

	/// Reverse map: 32-byte Cardano identity hash → the one posting account it is bound to. The
	/// client's bind readback queries this by the 32-byte key (DR-01). Load-bearing for the 1:1
	/// invariant: a second account cannot claim an already-bound identity.
	#[pallet::storage]
	pub type AccountOf<T: Config> =
		StorageMap<_, Blake2_128Concat, IdentityHash, T::AccountId, OptionQuery>;

	/// Optional cogno_v3 thread pointer (5 raw bytes / 10 hex chars — `ConstU32<10>`, **never**
	/// `<4>`, DR-23) bound to a posting account, for joining the live cogno_v3 forum. Kept in the
	/// on-wire interface even though the v1 UX may defer the thread join — a settled field is not
	/// silently dropped.
	#[pallet::storage]
	pub type ThreadOf<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, BoundedVec<u8, ConstU32<10>>, OptionQuery>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A Cardano identity was bound 1:1 to a posting account (the D0 per-bind audit record,
		/// DR-07). `identity` is `blake2b_256(serialized owner Address)`.
		IdentityLinked { who: T::AccountId, identity: IdentityHash },
		/// A binding was revoked (the v1 manual-operator-ban path, DR-14). The capacity row +
		/// provider ref are intentionally left in place (M2b owns the full teardown).
		Revoked { who: T::AccountId, identity: IdentityHash },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// This posting account is already bound to an identity (1:1, account side).
		AccountAlreadyBound,
		/// This Cardano identity is already bound to an account (1:1, identity side). Named
		/// `PkhAlreadyBound` for cross-doc continuity; the key is the 32-byte Address hash.
		PkhAlreadyBound,
		/// The supplied thread pointer exceeded 10 bytes (5 raw bytes / 10 hex chars, DR-23).
		BadThread,
		/// No binding exists for this account (revoke target not found).
		NotBound,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Bind a Cardano `identity_hash` 1:1 to `substrate_account`. Gated by `FollowerOrigin`
		/// (the trusted follower; sudo in dev) — the chain trusts that the follower already
		/// verified the CIP-8 proof off-chain (`L2-follower.md` §7).
		///
		/// `identity_hash` = `blake2b_256(serialized owner Address)` (DR-01). Rejects a second
		/// bind on **either** side (`AccountAlreadyBound` / `PkhAlreadyBound`) — the 1:1 Sybil
		/// invariant. On success it primes the account's microblog capacity row + provider ref
		/// via [`Config::OnBind`] (`on_first_bind`), so the bound account can immediately post
		/// feelessly once weighted. `thread_pointer` is the optional cogno_v3 thread join.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::link_identity())]
		pub fn link_identity(
			origin: OriginFor<T>,
			identity_hash: IdentityHash,
			substrate_account: T::AccountId,
			thread_pointer: Option<Vec<u8>>,
		) -> DispatchResult {
			T::FollowerOrigin::ensure_origin(origin)?;

			// 1:1 enforcement — reject a second bind on EITHER side (the anti-Sybil anchor).
			ensure!(
				!PkhOf::<T>::contains_key(&substrate_account),
				Error::<T>::AccountAlreadyBound
			);
			ensure!(!AccountOf::<T>::contains_key(identity_hash), Error::<T>::PkhAlreadyBound);

			// Validate the optional thread pointer up front (fallible) before any write.
			let thread = match thread_pointer {
				Some(ptr) => Some(
					BoundedVec::<u8, ConstU32<10>>::try_from(ptr)
						.map_err(|_| Error::<T>::BadThread)?,
				),
				None => None,
			};

			PkhOf::<T>::insert(&substrate_account, identity_hash);
			AccountOf::<T>::insert(identity_hash, &substrate_account);
			if let Some(t) = thread {
				ThreadOf::<T>::insert(&substrate_account, t);
			}

			// Prime the microblog capacity row + provider ref (idempotent). on_first_bind ALREADY
			// calls inc_providers — do NOT increment providers again here, or revoke's single
			// dec would leave the count stuck.
			T::OnBind::on_bind(&substrate_account);

			Self::deposit_event(Event::IdentityLinked {
				who: substrate_account,
				identity: identity_hash,
			});
			Ok(())
		}

		/// Revoke an account's binding (the v1 manual-operator-ban path, DR-14). Gated by
		/// `FollowerOrigin`. Removes both directional maps + the thread pointer, so `is_allowed`
		/// flips to `false` and the account can no longer post.
		///
		/// ⚑ v1 scope (M2): this is the *ban* mechanism — it does **not** tear down the microblog
		/// capacity row or the provider reference. Those pair with microblog's never-delete-row
		/// anti-farm invariant (a relock must not re-mint a fresh bucket); the full teardown
		/// (`dec_providers` + row policy, atomically) is M2b. Leaving the provider ref is the
		/// consistent choice: the row still exists and still needs it.
		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::revoke())]
		pub fn revoke(origin: OriginFor<T>, substrate_account: T::AccountId) -> DispatchResult {
			T::FollowerOrigin::ensure_origin(origin)?;
			let identity = PkhOf::<T>::take(&substrate_account).ok_or(Error::<T>::NotBound)?;
			AccountOf::<T>::remove(identity);
			ThreadOf::<T>::remove(&substrate_account);
			Self::deposit_event(Event::Revoked { who: substrate_account, identity });
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		/// The identity hash bound to `who`, if any. Read-only helper for tooling/readback.
		pub fn identity_of(who: &T::AccountId) -> Option<IdentityHash> {
			PkhOf::<T>::get(who)
		}
	}

	/// The microblog post gate: an account may post iff it has a live 1:1 binding. This is the
	/// authoritative on-chain Sybil gate (the capacity pool extension is separate spam control).
	impl<T: Config> IsAllowed<T::AccountId> for Pallet<T> {
		fn is_allowed(who: &T::AccountId) -> bool {
			PkhOf::<T>::contains_key(who)
		}
	}
}
