//! # Microblog pallet (cogno-chain)
//!
//! **M0 shape: plain text posting.** No identity gate, no talk-capacity, no feeless
//! extension — those arrive in later milestones (wallet gate = M2, feeless metered
//! posting = M2c, Cardano-sourced weight = M2d; see `docs/DECISION-REGISTER.md`
//! DR-24 / DR-13 / DR-14b). For M0, `post_message` is an ordinary *signed, fee-bearing*
//! extrinsic, rate-limited only by normal transaction fees and block weight.
//!
//! Storage is already the decided v1 baseline so later milestones bolt on without an
//! encoding break: post ids are `u64` (DR-21); `MaxLength` and `MaxPostsPerAuthor` are
//! pallet constants (DR-10b, wired to 512 / 10_000 in the runtime); every collection is
//! bounded; `parent` carries replies/threading (replies will be gated like any post,
//! DR-14b). Real benchmarked `WeightInfo` is DR-05 (a later milestone) — M0 ships
//! hand-set dev-grade weights, the same approach the upstream template uses.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub mod weights;
pub use weights::*;

#[frame_support::pallet]
pub mod pallet {
	use super::*;
	use alloc::vec::Vec;
	use frame_support::pallet_prelude::*;
	use frame_system::pallet_prelude::*;

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	/// The pallet's configuration trait.
	#[pallet::config]
	pub trait Config: frame_system::Config {
		/// The overarching runtime event type.
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>>
			+ IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// Maximum length, in bytes, of a post's text. Bounds PoV / proof size. (DR-10b: 512.)
		#[pallet::constant]
		type MaxLength: Get<u32>;
		/// Maximum number of posts tracked per author in the on-chain `ByAuthor` index.
		/// (DR-10b: 10_000. Complete history beyond this is served by the off-chain indexer.)
		#[pallet::constant]
		type MaxPostsPerAuthor: Get<u32>;
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

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A post was created.
		PostCreated { id: u64, author: T::AccountId },
		/// A post was deleted by its author.
		PostDeleted { id: u64 },
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
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Create a post with the given `text` bytes and optional `parent` (reply target).
		///
		/// M0: any signed origin may post (no gate yet). Fails `TooLong` if `text` exceeds
		/// `MaxLength`, or `TooManyPosts` if the author's index is full.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::post_message(text.len() as u32))]
		pub fn post_message(
			origin: OriginFor<T>,
			text: Vec<u8>,
			parent: Option<u64>,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let bounded: BoundedVec<u8, T::MaxLength> =
				text.try_into().map_err(|_| Error::<T>::TooLong)?;

			let id = NextPostId::<T>::get();
			// Index into `ByAuthor` first: on overflow this returns `Err`, the whole
			// dispatch rolls back (so the id is NOT consumed), and the caller sees a real
			// `TooManyPosts` error — the post is never silently dropped.
			ByAuthor::<T>::try_mutate(&who, |ids| ids.try_push(id))
				.map_err(|_| Error::<T>::TooManyPosts)?;

			let at = frame_system::Pallet::<T>::block_number();
			Posts::<T>::insert(id, Post { author: who.clone(), text: bounded, parent, at });
			NextPostId::<T>::put(id.saturating_add(1));

			Self::deposit_event(Event::PostCreated { id, author: who });
			Ok(())
		}

		/// Delete a post you authored.
		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::delete_post())]
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
	}
}
