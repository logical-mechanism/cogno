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

/// The on-chain CIP-8 (COSE_Sign1) identity self-proof verifier (D1 — trustless identity).
pub mod cip8;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

pub mod weights;
pub use weights::*;

/// Log target for operator-facing diagnostics on the identity-gate edge paths (rejections,
/// idempotent revoke no-ops, the bind/revoke provider-ref lifecycle). These are `log::` lines
/// only — the on-chain audit trail is still the `IdentityLinked`/`Revoked` events, NOT logs.
pub const LOG_TARGET: &str = "runtime::cogno-gate";

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
	use frame_support::{pallet_prelude::*, sp_runtime::traits::Zero};
	use frame_system::{ensure_signed, pallet_prelude::*};
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
		/// Bind/revoke lifecycle hook into `pallet-microblog`: `on_bind` primes the capacity row + a
		/// provider reference so a freshly-bound feeless poster's first post is not rejected by
		/// `CheckNonce` (issue #3991), and `on_revoke` releases that ref. Wired to `Microblog` in the
		/// runtime. Defined in microblog (not here) to avoid a Cargo dependency cycle. `on_bind` owns
		/// the single `inc_providers` call (balanced by one `dec_providers` in `on_revoke`) — do not
		/// increment providers again here.
		type OnBind: OnIdentityBind<Self::AccountId>;
		/// The Cardano network the trustless self-proof ([`Call::link_identity_signed`]) binds for — the
		/// low nibble of the address header byte (0 = testnet, 1 = mainnet). The beacon-name identity
		/// carries NO network byte, so this pins which network's addresses may bind (else a mainnet and a
		/// testnet address with the same credentials would collide on the identical identity). See [`cip8`].
		#[pallet::constant]
		type CardanoNetwork: Get<u8>;
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

	/// Permanently-banned identities — the manual-operator-ban tombstone (DR-14). [`Call::revoke`]
	/// inserts here; the permissionless [`Call::link_identity_signed`] refuses to (re)bind a tombstoned
	/// identity, so an eternally-valid CIP-8 proof replayed after a ban does NOT resurrect the binding.
	/// Never removed (a tombstone is permanent — your "ban means ban" decision).
	#[pallet::storage]
	pub type Tombstoned<T: Config> = StorageMap<_, Blake2_128Concat, IdentityHash, (), OptionQuery>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A Cardano identity was bound 1:1 to a posting account (the D0 per-bind audit record,
		/// DR-07). `identity` is `blake2b_256(serialized owner Address)`.
		IdentityLinked { who: T::AccountId, identity: IdentityHash },
		/// A binding was revoked (the v1 manual-operator-ban path, DR-14). The provider ref is
		/// released and the banked capacity zeroed; the capacity row itself is kept (relock-farm
		/// guard) — see [`pallet_microblog::OnIdentityBind::on_revoke`] (gate-1).
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
		/// The submitted CIP-8 self-proof failed verification (signature / address-key bind / format /
		/// unsupported address). The node log carries the specific [`cip8::Cip8Error`] variant.
		ProofInvalid,
		/// The proof commits a different chain's genesis hash (anti-cross-chain replay).
		WrongGenesis,
		/// This Cardano identity was permanently banned (revoked) and cannot be re-bound (the tombstone).
		IdentityTombstoned,
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
		/// via [`Config::OnBind::on_bind`], so the bound account can immediately post feelessly
		/// once weighted. `thread_pointer` is the optional cogno_v3 thread join.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::link_identity())]
		pub fn link_identity(
			origin: OriginFor<T>,
			identity_hash: IdentityHash,
			substrate_account: T::AccountId,
			thread_pointer: Option<Vec<u8>>,
		) -> DispatchResult {
			T::FollowerOrigin::ensure_origin(origin)?;
			Self::do_bind(&substrate_account, identity_hash, thread_pointer)
		}

		/// **Trustless bind (D1).** Anyone submits the CIP-8 (COSE_Sign1) `signData` proof their Cardano
		/// wallet produced over the pinned bind payload, and the RUNTIME verifies it on-chain
		/// ([`cip8::verify_bind_proof`]) — **no trusted writer**. `ensure_signed` is the FEE payer (the
		/// DoS defence: an unbound junk-proof spammer must pay), but the BOUND account + identity come from
		/// the cryptographically-verified proof, so the submitter cannot retarget it (front-running a
		/// valid proof merely completes the intended bind). The signed payload must commit THIS chain's
		/// genesis (anti-cross-chain); a tombstoned (revoked) identity is refused.
		///
		/// ⚠ The verifier is the anti-Sybil crown jewel — a bug forges any identity. It is hardened by an
		/// adversarial threat-model + tests but has NOT had a formal external audit (`L2-follower.md`
		/// §7.2): **MAINNET PREREQUISITE — independent verifier audit** before real value.
		#[pallet::call_index(2)]
		#[pallet::weight(T::WeightInfo::link_identity_signed())]
		pub fn link_identity_signed(
			origin: OriginFor<T>,
			cose_sign1: BoundedVec<u8, ConstU32<512>>,
			cose_key: BoundedVec<u8, ConstU32<128>>,
			thread_pointer: Option<Vec<u8>>,
		) -> DispatchResult {
			// NOT feeless: the signed submitter pays the tx fee, so a junk proof costs the attacker.
			let _submitter = ensure_signed(origin)?;
			// Verify the wallet signature on-chain (the trustless core). The bounded args were already
			// size-capped at decode, before this heavy path runs.
			let proof = cip8::verify_bind_proof(&cose_sign1, &cose_key, T::CardanoNetwork::get())
				.map_err(|e| {
					log::warn!(target: LOG_TARGET, "link_identity_signed: proof rejected: {e:?}");
					Error::<T>::ProofInvalid
				})?;
			// Anti-cross-chain: the signed payload must commit THIS chain's genesis hash (block 0).
			let genesis = frame_system::Pallet::<T>::block_hash(BlockNumberFor::<T>::zero());
			ensure!(genesis.as_ref() == proof.genesis.as_slice(), Error::<T>::WrongGenesis);
			// The bound account is the 32-byte sr25519 key the PROOF commits — never the submitter.
			let account =
				T::AccountId::decode(&mut &proof.account[..]).map_err(|_| Error::<T>::ProofInvalid)?;
			log::debug!(target: LOG_TARGET, "link_identity_signed: verified proof for identity={:?}", proof.identity);
			Self::do_bind(&account, proof.identity, thread_pointer)
		}

		/// Revoke an account's binding (the v1 manual-operator-ban path, DR-14). Gated by
		/// `FollowerOrigin`. Removes both directional maps + the thread pointer, so `is_allowed`
		/// flips to `false` and the account can no longer post.
		///
		/// Calls [`OnIdentityBind::on_revoke`] so the bind/revoke lifecycle is symmetric (`gate-1`):
		/// the provider reference taken at `link_identity` is released and the banked capacity is
		/// zeroed, while the `Capacity` row itself is KEPT (microblog's never-delete relock-farm
		/// invariant — a relock must not read a fresh first-touch bucket).
		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::revoke())]
		pub fn revoke(origin: OriginFor<T>, substrate_account: T::AccountId) -> DispatchResult {
			T::FollowerOrigin::ensure_origin(origin)?;
			// A revoke of a never-bound account is REJECTED with NotBound (no state change, no event) —
			// it is NOT a silent success. Log it at debug so a relayer/operator can tell a stale/retried
			// revoke from a real one without scraping for the (deliberately absent) event.
			let identity = match PkhOf::<T>::take(&substrate_account) {
				Some(id) => id,
				None => {
					log::debug!(
						target: LOG_TARGET,
						"revoke rejected: account not bound (NotBound) — nothing to release",
					);
					return Err(Error::<T>::NotBound.into());
				},
			};
			AccountOf::<T>::remove(identity);
			ThreadOf::<T>::remove(&substrate_account);
			// Tombstone the identity PERMANENTLY: the permissionless `link_identity_signed` path consults
			// `Tombstoned` and refuses to re-bind it, so a ban cannot be undone by replaying an
			// (eternally-valid) CIP-8 proof. A tombstone is never removed (your "ban means ban" decision).
			Tombstoned::<T>::insert(identity, ());
			// Symmetric teardown (gate-1): release the provider ref taken at bind + zero the banked
			// capacity, while microblog KEEPS the (relock-safe) capacity row. NOTE: `on_revoke` is
			// infallible today; if it is ever made fallible, an Err here would leak the bind/revoke
			// provider-ref symmetry (the count stays incremented) — it MUST be error-checked then.
			T::OnBind::on_revoke(&substrate_account);
			log::debug!(
				target: LOG_TARGET,
				"revoke ok: identity={:?} unbound, provider ref released + banked capacity zeroed via on_revoke",
				identity,
			);
			Self::deposit_event(Event::Revoked { who: substrate_account, identity });
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		/// The identity hash bound to `who`, if any. Read-only helper for tooling/readback.
		pub fn identity_of(who: &T::AccountId) -> Option<IdentityHash> {
			PkhOf::<T>::get(who)
		}

		/// The shared 1:1 bind body, called by BOTH the trusted [`Call::link_identity`] and the trustless
		/// [`Call::link_identity_signed`]: the tombstone + double-bind checks, the thread-pointer
		/// validation, the two directional maps, the microblog `on_bind` (provider ref + capacity row),
		/// and the `IdentityLinked` event. NOT a dispatchable — it performs no origin check; each caller
		/// authorizes per its own rule (FollowerOrigin vs a verified cryptographic proof).
		pub(crate) fn do_bind(
			account: &T::AccountId,
			identity: IdentityHash,
			thread_pointer: Option<Vec<u8>>,
		) -> DispatchResult {
			// A permanently-banned (revoked) identity can never be re-bound (the tombstone, DR-14).
			ensure!(!Tombstoned::<T>::contains_key(identity), Error::<T>::IdentityTombstoned);
			// 1:1 enforcement — reject a second bind on EITHER side (the anti-Sybil anchor). A rejected
			// bind is an operator-visible anomaly — warn so it surfaces in the node logs.
			if PkhOf::<T>::contains_key(account) {
				log::warn!(target: LOG_TARGET, "do_bind rejected: account already bound; identity={identity:?}");
				return Err(Error::<T>::AccountAlreadyBound.into());
			}
			if AccountOf::<T>::contains_key(identity) {
				log::warn!(target: LOG_TARGET, "do_bind rejected: identity already bound; identity={identity:?}");
				return Err(Error::<T>::PkhAlreadyBound.into());
			}
			// Validate the optional thread pointer up front (fallible) before any write.
			let thread = match thread_pointer {
				Some(ptr) => {
					let len = ptr.len();
					Some(BoundedVec::<u8, ConstU32<10>>::try_from(ptr).map_err(|_| {
						log::warn!(target: LOG_TARGET, "do_bind rejected: thread pointer too long ({len} bytes > 10)");
						Error::<T>::BadThread
					})?)
				},
				None => None,
			};
			PkhOf::<T>::insert(account, identity);
			AccountOf::<T>::insert(identity, account);
			if let Some(t) = thread {
				ThreadOf::<T>::insert(account, t);
			}
			// on_bind owns the single inc_providers (balanced by on_revoke's dec) — the gate-1 invariant.
			T::OnBind::on_bind(account);
			log::debug!(target: LOG_TARGET, "do_bind ok: identity={identity:?} bound 1:1, provider ref taken");
			Self::deposit_event(Event::IdentityLinked { who: account.clone(), identity });
			Ok(())
		}
	}

	/// The microblog post gate: an account may post iff it has a live 1:1 binding. This is the
	/// authoritative on-chain Sybil gate (the capacity pool extension is separate spam control).
	impl<T: Config> IsAllowed<T::AccountId> for Pallet<T> {
		fn is_allowed(who: &T::AccountId) -> bool {
			PkhOf::<T>::contains_key(who)
		}

		/// Benchmark-only (DR-05): bind `who` to a dummy identity so `microblog::post_message`
		/// can be benchmarked through the real gate. Writes only the forward map (`PkhOf`, which
		/// `is_allowed` reads) — NOT `AccountOf` — so repeated calls with the same dummy hash do
		/// not trip the 1:1 reverse-side invariant across benchmark iterations.
		#[cfg(feature = "runtime-benchmarks")]
		fn benchmark_set_allowed(who: &T::AccountId) {
			PkhOf::<T>::insert(who, [0u8; 32]);
		}
	}
}
