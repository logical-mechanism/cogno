//! # Microblog pallet (cogno-chain)
//!
//! **M2c shape: feeless, capacity-metered posting.** `post_message` is now **feeless**
//! (`#[pallet::feeless_if]` + the runtime's `SkipCheckIfFeeless<ChargeTransactionPayment>`)
//! and rate-limited by a regenerating, stake-weighted **talk-capacity** meter folded into
//! this pallet (DR-24). The whole anti-spam budget is the [`CheckCapacity`] transaction
//! extension: it gates **inclusion** in `validate()` (over-budget → `ExhaustsResources` at
//! the pool) and **consumes** capacity in `post_dispatch_details()` — never the reverse
//! (`ECONOMICS.md` §4/§7, `L3-chain.md` §4.3/§5).
//!
//! Per-account weight comes from [`pallet_talk_stake::AllowedStake`] (`set_stake`, written
//! by the follower / sudo in dev). The lazy token-bucket math (`current_capacity` /
//! `on_first_bind` / `post_cost` / `consume`) is `ECONOMICS.md` §4.1 verbatim, computed
//! O(1) on access — no per-block sweep. Cardano-sourced weight + the CIP-8 identity gate
//! are still later milestones (M2 gate / M2d Cardano weight; in M2c the operator sets
//! weight via `talk-stake::set_stake` + [`force_set_capacity`] under sudo).
//!
//! ## Anti-farm invariants (do not break)
//! - **First touch starts at ZERO** (`current_capacity` `None ⇒ 0`): a new identity charges
//!   up from empty, never a full bucket — closes the cheap-identity burst farm.
//! - **The `Capacity` row is never deleted** on unlock; only `weight → 0` clamps it. So a
//!   lock/unlock/relock cycle can't read a `None` first-touch and re-mint (relock farm).
//! - **`consume` is the sole writer**; `current_capacity` is pure (safe in `validate()`).
//! - **Going-forward-only**: weight changes (in talk-stake) never touch `cap_last`.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub mod weights;
pub use weights::*;

use codec::{Decode, DecodeWithMemTracking, Encode};
use frame_support::{
	dispatch::{DispatchInfo, PostDispatchInfo},
	traits::IsSubType,
	weights::Weight,
};
use scale_info::TypeInfo;
use sp_runtime::{
	impl_tx_ext_default,
	traits::{
		DispatchInfoOf, Dispatchable, PostDispatchInfoOf, TransactionExtension, ValidateResult,
	},
	transaction_validity::{
		InvalidTransaction, TransactionSource, TransactionValidityError, ValidTransaction,
	},
	SaturatedConversion,
};

// ───────────────────────────────────────────────────────────────────────────────────────
// Loose-coupling traits that wire pallet-microblog ↔ pallet-cogno-gate WITHOUT a Cargo
// dependency cycle. Both live HERE, in the depended-upon crate: pallet-cogno-gate depends on
// pallet-microblog (to call `on_first_bind` at link), so the shared traits must live in
// microblog — if they lived in cogno-gate, microblog would have to depend on cogno-gate and the
// two crates would form a cycle. (L3-chain.md §4.4, the M2 architectural gotcha.) Neither
// pallet names the other's crate in a trait bound; the runtime supplies the concrete cross-impl.
// ───────────────────────────────────────────────────────────────────────────────────────

/// The identity gate microblog consults before accepting a post. Implemented by
/// `pallet-cogno-gate` (M2); wired to microblog's `Config::IdentityGate` in the runtime.
pub trait IsAllowed<AccountId> {
	/// Whether `who` has a live 1:1 Cardano-identity binding (⇒ may post).
	fn is_allowed(who: &AccountId) -> bool;
}

/// The first-bind hook `pallet-cogno-gate` calls (via its `OnBind` Config type) when it links an
/// identity. Implemented by microblog's own `Pallet` below (→ `on_first_bind`).
pub trait OnIdentityBind<AccountId> {
	/// Called once when `who` is first bound: primes the capacity row + provider ref.
	fn on_bind(who: &AccountId);
}

#[frame_support::pallet]
pub mod pallet {
	use super::*;
	use alloc::vec::Vec;
	use frame_support::pallet_prelude::*;
	use frame_system::pallet_prelude::*;
	use sp_runtime::{traits::Saturating, SaturatedConversion};

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	/// The pallet's configuration trait. Tightly coupled to `pallet-talk-stake` (the weight
	/// source the capacity meter reads).
	#[pallet::config]
	pub trait Config: frame_system::Config + pallet_talk_stake::Config {
		/// The overarching runtime event type.
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>>
			+ IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// The Cardano-identity gate (M2): `post_message` is rejected with `NotAllowed` unless
		/// `IdentityGate::is_allowed(&who)`. Wired to `CognoGate` in the runtime. This is the
		/// authoritative on-chain Sybil gate; the capacity extension is separate spam control.
		type IdentityGate: IsAllowed<Self::AccountId>;
		/// Maximum length, in bytes, of a post's text. Bounds PoV / proof size. (DR-10b: 512.)
		#[pallet::constant]
		type MaxLength: Get<u32>;
		/// Maximum number of posts tracked per author in the on-chain `ByAuthor` index.
		/// (DR-10b: 10_000. Complete history beyond this is served by the off-chain indexer.)
		#[pallet::constant]
		type MaxPostsPerAuthor: Get<u32>;

		// ── talk-capacity constants (ECONOMICS §4; all runtime-tunable, read from metadata
		//    by the client capacity battery — never hardcode there) ─────────────────────────
		/// Capacity ceiling per unit weight: `cap = min(weight · CapRatio, Ceiling)`
		/// (micro-capacity units per lovelace).
		#[pallet::constant]
		type CapRatio: Get<u128>;
		/// Regeneration per unit weight per block: `rate = weight · RegenPerBlock`
		/// (micro-capacity units per lovelace per block).
		#[pallet::constant]
		type RegenPerBlock: Get<u128>;
		/// Hard capacity ceiling (capped-linear curve, DR-11) — a single mega-whale cannot
		/// dominate the mempool regardless of stake.
		#[pallet::constant]
		type Ceiling: Get<u128>;
		/// Flat per-post cost: `need = BaseCost + PerByteCost · len` (micro-capacity units).
		#[pallet::constant]
		type BaseCost: Get<u128>;
		/// Per-byte post cost (micro-capacity units per byte).
		#[pallet::constant]
		type PerByteCost: Get<u128>;

		/// Origin allowed to force a capacity row (operator/migration; **sudo in dev**). The
		/// future `cogno-gate` `link_identity` will call [`Pallet::on_first_bind`] directly;
		/// this dispatchable is the M2c stand-in that lets the operator prime/pre-charge an
		/// account's battery without the Cardano side wired.
		type ForceOrigin: EnsureOrigin<Self::RuntimeOrigin>;

		/// Weight information for this pallet's dispatchables.
		type WeightInfo: WeightInfo;
	}

	/// A single post.
	///
	/// `*NoBound` derives are used because `Post` is generic over `T: Config`; the plain
	/// derives would wrongly require `T: Clone/Eq/Debug` (the fields only need `T::AccountId`).
	#[derive(
		Encode, Decode, CloneNoBound, PartialEqNoBound, EqNoBound, DebugNoBound, TypeInfo, MaxEncodedLen,
	)]
	#[scale_info(skip_type_params(T))]
	pub struct Post<T: Config> {
		/// The author's account id (the sr25519 posting key).
		pub author: T::AccountId,
		/// The post body, bounded to `MaxLength` bytes.
		pub text: BoundedVec<u8, T::MaxLength>,
		/// Optional parent post id, for replies / threading.
		pub parent: Option<u64>,
		/// The block number at which the post was created.
		pub at: BlockNumberFor<T>,
	}

	/// The lazy token-bucket state for one identity (`ECONOMICS.md` §4.1).
	///
	/// `cap_last` is the banked micro-capacity at `last_block`; `current_capacity` regenerates
	/// it on read. `OptionQuery` is load-bearing: `None` (a genuinely new identity) vs `Some`
	/// IS the first-touch/relock anti-farm logic.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	pub struct CapacityState<BN> {
		/// Banked micro-capacity units at the last touch.
		pub cap_last: u128,
		/// The block number of the last touch.
		pub last_block: BN,
	}

	/// The id that will be assigned to the next post. `u64` (DR-21).
	#[pallet::storage]
	pub type NextPostId<T> = StorageValue<_, u64, ValueQuery>;

	/// All posts, keyed by id.
	#[pallet::storage]
	pub type Posts<T: Config> = StorageMap<_, Blake2_128Concat, u64, Post<T>>;

	/// Per-author index of post ids, bounded to `MaxPostsPerAuthor`.
	#[pallet::storage]
	pub type ByAuthor<T: Config> = StorageMap<
		_,
		Blake2_128Concat,
		T::AccountId,
		BoundedVec<u64, T::MaxPostsPerAuthor>,
		ValueQuery,
	>;

	/// Per-identity talk-capacity bucket. `None` ⇒ never-bound (first touch = 0); the row is
	/// **never deleted** on unlock (relock-farm guard, `ECONOMICS.md` §6.1).
	#[pallet::storage]
	pub type Capacity<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, CapacityState<BlockNumberFor<T>>, OptionQuery>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A post was created.
		PostCreated { id: u64, author: T::AccountId },
		/// A post was deleted by its author.
		PostDeleted { id: u64 },
		/// A capacity bucket was force-set by the `ForceOrigin` (operator/migration/dev).
		CapacityForced { who: T::AccountId, cap_last: u128 },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// The post text exceeded `MaxLength`.
		TooLong,
		/// No post exists with the given id.
		NotFound,
		/// The caller is not the author of the post.
		NotAuthor,
		/// The author has reached `MaxPostsPerAuthor` and cannot be indexed for another post.
		TooManyPosts,
		/// The caller has not bound a Cardano identity via the gate (`IdentityGate::is_allowed`
		/// returned `false`). The M2 anti-Sybil gate (`L3-chain.md` §4.4/§5.1).
		NotAllowed,
	}

	impl<T: Config> Pallet<T> {
		/// Lazy regenerate-on-read (`ECONOMICS.md` §4.1). **Pure** — no writes — so it is safe
		/// to call repeatedly inside `validate()`.
		///
		/// ⚑ `None ⇒ 0` (first-touch is empty, not full) and all arithmetic is `saturating_*`,
		/// so an identity idle for years saturates into the `min(cap, …)` clamp, never wraps.
		pub fn current_capacity(who: &T::AccountId, now: BlockNumberFor<T>) -> u128 {
			let weight = pallet_talk_stake::AllowedStake::<T>::get(who); // 0 if unbound/unlocked
			let cap_linear = weight.saturating_mul(T::CapRatio::get());
			let cap = core::cmp::min(cap_linear, T::Ceiling::get()); // capped-linear (DR-11)
			match Capacity::<T>::get(who) {
				None => 0, // first-touch = ZERO (charges up); closes the cheap-identity burst farm
				Some(s) => {
					let elapsed: u128 = now.saturating_sub(s.last_block).saturated_into();
					let regen = weight
						.saturating_mul(T::RegenPerBlock::get())
						.saturating_mul(elapsed);
					core::cmp::min(cap, s.cap_last.saturating_add(regen))
				},
			}
		}

		/// Stamp the bucket empty **and dated** at first bind, and give the account a provider
		/// reference so a feeless post is not rejected by `CheckNonce` (`L3-chain.md` §5.5).
		/// Idempotent: a no-op if a row already exists, so a relock cannot re-mint.
		pub fn on_first_bind(who: &T::AccountId) {
			if !Capacity::<T>::contains_key(who) {
				let now = frame_system::Pallet::<T>::block_number();
				Capacity::<T>::insert(who, CapacityState { cap_last: 0, last_block: now });
				// Feeless posters need a provider ref (issue #3991); revoke would dec it.
				let _ = frame_system::Pallet::<T>::inc_providers(who);
			}
		}

		/// The capacity cost of a post of `len` bytes (`ECONOMICS.md` §4.2).
		pub fn post_cost(len: u32) -> u128 {
			T::BaseCost::get().saturating_add(T::PerByteCost::get().saturating_mul(len as u128))
		}

		/// Spend `cost` capacity for `who` at `now`. **The sole writer** of the bucket — called
		/// only from `CheckCapacity::post_dispatch_details` (inclusion), never `validate()`.
		/// `saturating_sub` floors at 0, so even an operator-forced over-budget post can only
		/// zero the bucket, never underflow.
		pub fn consume(who: &T::AccountId, now: BlockNumberFor<T>, cost: u128) {
			let current = Self::current_capacity(who, now);
			Capacity::<T>::insert(
				who,
				CapacityState { cap_last: current.saturating_sub(cost), last_block: now },
			);
		}
	}

	/// The first-bind hook `pallet-cogno-gate` invokes (via its `OnBind` Config type) at
	/// `link_identity`. Delegates to the idempotent [`Pallet::on_first_bind`] — so the gate
	/// primes the capacity row + provider ref without taking a Cargo dependency on cogno-gate.
	impl<T: Config> super::OnIdentityBind<T::AccountId> for Pallet<T> {
		fn on_bind(who: &T::AccountId) {
			Self::on_first_bind(who);
		}
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Create a post with the given `text` bytes and optional `parent` (reply target).
		///
		/// **Feeless** (`feeless_if` below + the runtime's `SkipCheckIfFeeless`); inclusion is
		/// gated by the [`CheckCapacity`] extension at the pool, which also consumes capacity on
		/// inclusion. Fails `TooLong` if `text` exceeds `MaxLength`, or `TooManyPosts` if the
		/// author's index is full.
		#[pallet::call_index(0)]
		#[pallet::weight(<T as Config>::WeightInfo::post_message(text.len() as u32))]
		#[pallet::feeless_if(|_origin: &OriginFor<T>, _text: &Vec<u8>, _parent: &Option<u64>| -> bool { true })]
		pub fn post_message(
			origin: OriginFor<T>,
			text: Vec<u8>,
			parent: Option<u64>,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			// ⚑ M2 identity gate (belt-and-suspenders): a weighted-but-unbound account (e.g. a
			// sudo misconfig) is rejected here even though the capacity extension already rejects
			// the unbound-because-unweighted case at the pool. Identity ≠ rate limit.
			ensure!(T::IdentityGate::is_allowed(&who), Error::<T>::NotAllowed);
			let bounded: BoundedVec<u8, T::MaxLength> =
				text.try_into().map_err(|_| Error::<T>::TooLong)?;

			let id = NextPostId::<T>::get();
			// Index into `ByAuthor` first: on overflow this returns `Err`, the whole dispatch
			// rolls back (so the id is NOT consumed), and the caller sees a real `TooManyPosts`.
			ByAuthor::<T>::try_mutate(&who, |ids| ids.try_push(id))
				.map_err(|_| Error::<T>::TooManyPosts)?;

			let at = frame_system::Pallet::<T>::block_number();
			Posts::<T>::insert(id, Post { author: who.clone(), text: bounded, parent, at });
			NextPostId::<T>::put(id.saturating_add(1));

			Self::deposit_event(Event::PostCreated { id, author: who });
			Ok(())
		}

		/// Delete a post you authored. Kept **fee-bearing** (NOT feeless) and outside the
		/// capacity meter: a tiny fee prevents free delete-spam, and you can only delete posts
		/// you own. (The feeless budget is reserved for `post_message`, `L3-chain.md` §5.)
		#[pallet::call_index(1)]
		#[pallet::weight(<T as Config>::WeightInfo::delete_post())]
		pub fn delete_post(origin: OriginFor<T>, id: u64) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let post = Posts::<T>::get(id).ok_or(Error::<T>::NotFound)?;
			ensure!(post.author == who, Error::<T>::NotAuthor);

			Posts::<T>::remove(id);
			ByAuthor::<T>::mutate(&who, |ids| {
				if let Some(pos) = ids.iter().position(|x| *x == id) {
					ids.swap_remove(pos);
				}
			});

			Self::deposit_event(Event::PostDeleted { id });
			Ok(())
		}

		/// Force a capacity bucket for `who` to `cap_last` (dated at the current block), gated
		/// by `ForceOrigin`. The **M2c operator/dev stand-in** for the future gate's first-bind
		/// bookkeeping: it primes the row + provider ref (via [`Pallet::on_first_bind`]) and lets
		/// the operator pre-charge a battery so the showcase is interactive immediately.
		/// (Cardano-sourced weight + on-first-bind-at-`link_identity` are M2/M2d.)
		#[pallet::call_index(2)]
		#[pallet::weight(<T as Config>::WeightInfo::force_set_capacity())]
		pub fn force_set_capacity(
			origin: OriginFor<T>,
			who: T::AccountId,
			cap_last: u128,
		) -> DispatchResult {
			T::ForceOrigin::ensure_origin(origin)?;
			Self::on_first_bind(&who); // ensure the row + provider ref exist
			let now = frame_system::Pallet::<T>::block_number();
			Capacity::<T>::insert(&who, CapacityState { cap_last, last_block: now });
			Self::deposit_event(Event::CapacityForced { who, cap_last });
			Ok(())
		}
	}
}

// ───────────────────────────────────────────────────────────────────────────────────────
// The `CheckCapacity` transaction extension — the WHOLE anti-spam budget for feeless posts.
//
// `validate()` (pool) gates inclusion: an over-budget `post_message` is rejected with
// `ExhaustsResources` BEFORE it is gossiped/included for free. `post_dispatch_details()`
// (inclusion) is the only place capacity is consumed. Never consume in `validate()` (the
// pool calls it many times per tx); never do crypto there (heavy uncharged compute is itself
// a DoS). It touches only ~2 cheap reads: `AllowedStake`, `Capacity`, block number.
// (`L3-chain.md` §5.1, shape verified against polkadot-sdk's own extensions for this version.)
// ───────────────────────────────────────────────────────────────────────────────────────

/// `TransactionExtension` that gates feeless `post_message` inclusion on talk capacity.
#[derive(Encode, Decode, DecodeWithMemTracking, Clone, Eq, PartialEq, TypeInfo)]
#[scale_info(skip_type_params(T))]
pub struct CheckCapacity<T>(core::marker::PhantomData<T>);

impl<T: Config + Send + Sync> CheckCapacity<T> {
	/// Construct a new `CheckCapacity` extension.
	pub fn new() -> Self {
		Self(core::marker::PhantomData)
	}
}

impl<T: Config + Send + Sync> Default for CheckCapacity<T> {
	fn default() -> Self {
		Self::new()
	}
}

impl<T: Config + Send + Sync> core::fmt::Debug for CheckCapacity<T> {
	#[cfg(feature = "std")]
	fn fmt(&self, f: &mut core::fmt::Formatter) -> core::fmt::Result {
		write!(f, "CheckCapacity")
	}
	#[cfg(not(feature = "std"))]
	fn fmt(&self, _: &mut core::fmt::Formatter) -> core::fmt::Result {
		Ok(())
	}
}

/// Carried from `validate` → `post_dispatch_details`: the resolved poster + capacity cost.
/// `None` poster ⇒ this was not a signed `post_message` (nothing to consume).
pub struct Pre<T: Config> {
	who: Option<T::AccountId>,
	cost: u128,
}

impl<T: Config + Send + Sync> TransactionExtension<T::RuntimeCall> for CheckCapacity<T>
where
	T::RuntimeCall: Dispatchable<Info = DispatchInfo, PostInfo = PostDispatchInfo>
		+ IsSubType<crate::pallet::Call<T>>,
{
	const IDENTIFIER: &'static str = "CheckCapacity";
	type Implicit = ();
	type Val = Pre<T>;
	type Pre = Pre<T>;

	// `weight` defaults to zero; we implement validate / prepare / post_dispatch_details.
	impl_tx_ext_default!(T::RuntimeCall; weight);

	fn validate(
		&self,
		origin: <T::RuntimeCall as Dispatchable>::RuntimeOrigin,
		call: &T::RuntimeCall,
		_info: &DispatchInfoOf<T::RuntimeCall>,
		_len: usize,
		_self_implicit: Self::Implicit,
		_inherited_implication: &impl Encode,
		_source: TransactionSource,
	) -> ValidateResult<Self::Val, T::RuntimeCall> {
		// Pass through anything that isn't a signed origin (inherents, unsigned, etc.).
		let Ok(who) = frame_system::ensure_signed(origin.clone()) else {
			return Ok((ValidTransaction::default(), Pre { who: None, cost: 0 }, origin));
		};
		// Only meter `post_message`; everything else passes through untouched.
		if let Some(crate::pallet::Call::post_message { text, .. }) = call.is_sub_type() {
			let now = frame_system::Pallet::<T>::block_number();
			let have = crate::pallet::Pallet::<T>::current_capacity(&who, now);
			let need = crate::pallet::Pallet::<T>::post_cost(text.len() as u32);
			if have < need {
				// POOL REJECT — bounds INCLUSION (the block author re-runs validate at build
				// time and rejects over-budget posts). On a feeless chain this IS the spam gate.
				return Err(TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources));
			}
			// Priority tied to remaining headroom + short longevity so over-budget bursts age
			// out. u128 → u64 saturates (whale-scale headroom pins to u64::MAX; harmless).
			let vt = ValidTransaction {
				priority: have.saturating_sub(need).saturated_into::<u64>(),
				longevity: 8,
				propagate: true,
				..Default::default()
			};
			return Ok((vt, Pre { who: Some(who), cost: need }, origin));
		}
		Ok((ValidTransaction::default(), Pre { who: None, cost: 0 }, origin))
	}

	fn prepare(
		self,
		val: Self::Val,
		_origin: &<T::RuntimeCall as Dispatchable>::RuntimeOrigin,
		_call: &T::RuntimeCall,
		_info: &DispatchInfoOf<T::RuntimeCall>,
		_len: usize,
	) -> Result<Self::Pre, TransactionValidityError> {
		// Carry the resolved {who, cost} through to post-dispatch.
		Ok(val)
	}

	fn post_dispatch_details(
		pre: Self::Pre,
		_info: &DispatchInfoOf<T::RuntimeCall>,
		_post_info: &PostDispatchInfoOf<T::RuntimeCall>,
		_len: usize,
		_result: &sp_runtime::DispatchResult,
	) -> Result<Weight, TransactionValidityError> {
		// CONSUME here ONLY (inclusion), never in validate(). This is unspent-weight reporting
		// (refund nothing) — NOT the fee waiver (that is feeless_if + SkipCheckIfFeeless).
		if let Some(who) = pre.who {
			let now = frame_system::Pallet::<T>::block_number();
			crate::pallet::Pallet::<T>::consume(&who, now, pre.cost);
		}
		Ok(Weight::zero())
	}
}
