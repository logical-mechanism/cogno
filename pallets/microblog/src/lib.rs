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

/// Log target for this pallet's operator-facing diagnostics (rejections, idempotent no-ops,
/// clamps, provider-ref failures). Events remain the on-chain audit trail; these `log::` lines
/// are stderr/journald-only and add NO new Event variants or spec change.
pub const LOG_TARGET: &str = "runtime::microblog";

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

pub mod weights;
pub use weights::*;

/// Storage migrations for this pallet (`v1` adds `Post.quote` — the project's first migration).
pub mod migrations;

use codec::{Decode, DecodeWithMemTracking, Encode};
use frame_support::{
	dispatch::{DispatchInfo, PostDispatchInfo},
	traits::{Get, IsSubType},
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

	/// Benchmark-only setup hook (DR-05): force `who` into the allowed set so a subsequent
	/// `is_allowed(who)` returns `true`. This lets `post_message` be benchmarked end-to-end
	/// through the *real* runtime gate (`CognoGate`) — where the `whitelisted_caller` is
	/// otherwise unbound and would be rejected `NotAllowed` — without the microblog crate
	/// depending on cogno-gate. The real gate inserts a binding; the test mock is a no-op.
	#[cfg(feature = "runtime-benchmarks")]
	fn benchmark_set_allowed(who: &AccountId);
}

/// The bind/revoke lifecycle hooks `pallet-cogno-gate` calls (via its `OnBind` Config type).
/// Implemented by microblog's own `Pallet` below. The two are symmetric (`gate-1`): `on_bind`
/// takes a provider reference, `on_revoke` releases it, so a bind/revoke cycle nets to zero.
pub trait OnIdentityBind<AccountId> {
	/// Called when `who` is bound: primes the (relock-safe) capacity row and takes a provider
	/// reference (so a feeless poster's first post is not rejected by `CheckNonce`, issue #3991).
	fn on_bind(who: &AccountId);

	/// Called when `who`'s binding is revoked: releases the provider reference taken at `on_bind`
	/// and zeroes the banked capacity, but KEEPS the capacity row (the never-delete relock-farm
	/// guard — a re-bind must not read a `None` first-touch and mint a fresh bucket).
	fn on_revoke(who: &AccountId);
}

/// Prices a feeless call that the [`CheckCapacity`] extension meters but that does **not** belong to
/// this pallet — e.g. `pallet-profile`'s writes, which draw on the SAME single per-account talk-capacity
/// battery as posting. The runtime supplies the concrete impl (it can match every pallet's `Call`), so
/// microblog meters foreign feeless calls WITHOUT ever naming those crates in a trait bound — the same
/// no-Cargo-cycle posture as [`IsAllowed`]/[`OnIdentityBind`] (microblog is the depended-upon crate).
///
/// Returns the capacity cost (micro-capacity units) for a call it prices, or `None` for any call it
/// does not (those pass through the extension unmetered, exactly like microblog's own `metered_cost`
/// returns `None` for `force_set_capacity`). It is only ever consulted for calls that are NOT this
/// pallet's, so an impl can match purely on the foreign variants.
pub trait ForeignCapacityCost<RuntimeCall> {
	/// The talk-capacity cost of `call`, or `None` if this source does not price it.
	fn cost(call: &RuntimeCall) -> Option<u128>;
}

/// Default: meter nothing foreign. A runtime with no extra feeless pallets wires `type ForeignCost = ()`.
impl<RuntimeCall> ForeignCapacityCost<RuntimeCall> for () {
	fn cost(_call: &RuntimeCall) -> Option<u128> {
		None
	}
}

#[frame_support::pallet]
pub mod pallet {
	use super::*;
	use alloc::vec::Vec;
	use frame_support::pallet_prelude::*;
	use frame_system::pallet_prelude::*;
	use sp_runtime::{traits::Saturating, SaturatedConversion};

	/// The current storage version of pallet-microblog. v0 (implicit, pre-quote) → v1 adds the
	/// `quote: Option<u64>` field to [`Post`]; v1 → v2 backfills the `Followers`/`VotesByAccount`
	/// reverse indexes; v2 → v3 backfills the `ReplyCount`/`RepliesByParent` reply aggregates. Bumped
	/// in lockstep with each `migrations::v*` migration; every `VersionedMigration` version-guard
	/// self-skips once the on-chain version has advanced past it.
	const STORAGE_VERSION: StorageVersion = StorageVersion::new(3);

	#[pallet::pallet]
	#[pallet::storage_version(STORAGE_VERSION)]
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

		// ── per-action capacity costs for the social engagement calls (all feeless + metered
		//    through the SAME single talk-capacity battery as `post_message`/`quote_post`). Quote
		//    reuses `post_cost` (it is a post); these flat costs price the lighter signal/relationship
		//    actions. Toggle pairs (`clear_vote`, `unfollow`) meter at the SAME cost as their on-side
		//    so there is no free-churn asymmetry. ─────────────────────────────────────────────────
		/// Flat capacity cost of a `vote` or `clear_vote` (micro-capacity units).
		#[pallet::constant]
		type VoteCost: Get<u128>;
		/// Flat capacity cost of a `repost` (micro-capacity units).
		#[pallet::constant]
		type RepostCost: Get<u128>;
		/// Flat capacity cost of a `follow` or `unfollow` (micro-capacity units).
		#[pallet::constant]
		type FollowCost: Get<u128>;

		/// Maximum number of options a poll may have. (`create_poll` rejects more; ≥2 required.)
		#[pallet::constant]
		type MaxPollOptions: Get<u32>;
		/// Maximum length, in bytes, of a single poll option's label.
		#[pallet::constant]
		type MaxPollOptionLen: Get<u32>;

		/// Origin allowed to force a capacity row (operator/migration; **sudo in dev**). The
		/// future `cogno-gate` `link_identity` will call [`Pallet::on_first_bind`] directly;
		/// this dispatchable is the M2c stand-in that lets the operator prime/pre-charge an
		/// account's battery without the Cardano side wired.
		type ForceOrigin: EnsureOrigin<Self::RuntimeOrigin>;

		/// Prices feeless calls from OTHER pallets (e.g. `pallet-profile`) against this pallet's one
		/// per-account capacity battery, so the whole app can be feeless while every write is still
		/// pool-gated by [`CheckCapacity`]. The runtime supplies it (it can see every pallet's `Call`);
		/// `()` meters nothing foreign. See [`ForeignCapacityCost`].
		type ForeignCost: ForeignCapacityCost<<Self as frame_system::Config>::RuntimeCall>;

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
		/// Optional id of a quoted post (quote-posts). Added in storage **v1**; pre-v1 posts are
		/// migrated to `None` (see [`crate::migrations::v1`]). A quote (`quote = Some`) is distinct
		/// from a reply (`parent = Some`): a quote references a post without being threaded under it.
		/// Appended LAST so the migration is a clean tail-append (`None` encodes as one `0x00` byte).
		pub quote: Option<u64>,
	}

	/// The direction of a stake-weighted vote on a post.
	#[derive(
		Encode, Decode, DecodeWithMemTracking, Clone, Copy, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen,
	)]
	pub enum VoteDir {
		/// An up-vote (endorsement).
		Up,
		/// A down-vote.
		Down,
	}

	/// One account's recorded vote on a post: its direction plus the voter's stake **weight snapshot
	/// at vote time**. The snapshot is load-bearing: the denormalized [`VoteTally`] is adjusted by
	/// reversing exactly this stored weight on a re-vote / clear (never by re-reading current stake),
	/// so the tally cannot drift and an off-chain indexer folding the events reproduces it byte-exactly.
	#[derive(Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	pub struct VoteRecord {
		/// The vote direction.
		pub dir: VoteDir,
		/// The voter's `pallet_talk_stake::VotingPower` (total Cardano stake) at the moment the vote
		/// was cast.
		pub weight: u128,
	}

	/// The denormalized stake-weighted vote tally for one post. `ValueQuery` (default all-zero) so an
	/// unvoted post reads cleanly with no `Option`/`Some(0)` ambiguity — the fold-determinism contract.
	#[derive(Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, Default, TypeInfo, MaxEncodedLen)]
	pub struct Tally {
		/// Sum of up-voters' weight snapshots.
		pub up_weight: u128,
		/// Sum of down-voters' weight snapshots.
		pub down_weight: u128,
		/// Count of up-votes.
		pub up_count: u32,
		/// Count of down-votes.
		pub down_count: u32,
	}

	/// A poll attached to a post: the fixed set of options voters choose between. The poll's question
	/// IS the host post's `text`, so a poll is a first-class post (it threads / quotes / reposts and
	/// shows in the feed); only the options + the stake-weighted per-option tally live here.
	#[derive(
		Encode, Decode, CloneNoBound, PartialEqNoBound, EqNoBound, DebugNoBound, TypeInfo, MaxEncodedLen,
	)]
	#[scale_info(skip_type_params(T))]
	pub struct Poll<T: Config> {
		/// The selectable options (each bounded to `MaxPollOptionLen`, up to `MaxPollOptions`).
		pub options: BoundedVec<BoundedVec<u8, T::MaxPollOptionLen>, T::MaxPollOptions>,
	}

	/// One account's recorded poll choice: the chosen option index + the voter's stake weight snapshot
	/// at cast time. Same drift-free contract as [`VoteRecord`]: a re-cast reverses THIS stored weight.
	#[derive(Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	pub struct PollVoteRecord {
		/// The chosen option index (`< options.len()`).
		pub option: u8,
		/// The voter's `VotingPower` (total Cardano stake) weight at cast time.
		pub weight: u128,
	}

	/// The stake-weighted tally for a single poll option. `ValueQuery` (default zero) keyed per option.
	#[derive(Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, Default, TypeInfo, MaxEncodedLen)]
	pub struct OptionTally {
		/// Sum of the weight snapshots of accounts currently choosing this option.
		pub weight: u128,
		/// Number of accounts currently choosing this option.
		pub count: u32,
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

	// ── social engagement storage (all ADDITIVE — empty at genesis, so they need NO migration;
	//    only the `Post` re-encode does). ─────────────────────────────────────────────────────────

	/// Per-(post, voter) vote record. `None` ⇒ that account has not voted on that post (exactly one
	/// representation of "not voting" — `clear_vote` `take`s the row). The sole input to the tally.
	#[pallet::storage]
	pub type Votes<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		u64,
		Blake2_128Concat,
		T::AccountId,
		VoteRecord,
		OptionQuery,
	>;

	/// Denormalized stake-weighted vote tally per post (`ValueQuery` ⇒ default all-zero).
	#[pallet::storage]
	pub type VoteTally<T: Config> = StorageMap<_, Blake2_128Concat, u64, Tally, ValueQuery>;

	/// Reverse "liked posts" index: `VotesByAccount[account][post] = ()` means `account` currently
	/// UP-votes `post` (drives the profile Likes tab without a reverse scan). Maintained in lockstep by
	/// `vote`/`clear_vote` (inserted on an Up vote, removed on a Down vote or a clear); backfilled from
	/// the Up rows of `Votes` by migration v2.
	#[pallet::storage]
	pub type VotesByAccount<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		T::AccountId,
		Blake2_128Concat,
		u64,
		(),
		OptionQuery,
	>;

	/// Per-(post, account) repost edge. **Permanent** (treated like content — there is no `unrepost`);
	/// a re-repost is rejected `AlreadyReposted`. `None` ⇒ that account has not reposted that post.
	#[pallet::storage]
	pub type Reposts<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		u64,
		Blake2_128Concat,
		T::AccountId,
		(),
		OptionQuery,
	>;

	/// Per-post repost count (`ValueQuery` ⇒ default 0). Only ever increments (reposts are permanent).
	#[pallet::storage]
	pub type RepostCount<T: Config> = StorageMap<_, Blake2_128Concat, u64, u32, ValueQuery>;

	/// Per-parent reply count (`ValueQuery` ⇒ default 0): the number of direct replies a post has.
	/// The denormalized aggregate mirroring [`RepostCount`] — lets a client read a post's reply count
	/// with one keyed lookup instead of scanning every post for `parent == id`. Maintained in lockstep
	/// with [`RepliesByParent`] on the reply-creation path. Content is append-only (`delete_post` was
	/// removed in M0; `@1` is permanently vacant), so — exactly like `RepostCount` — it **only ever
	/// increments**; there is no decrement path. Backfilled from existing `Posts` by migration v3.
	#[pallet::storage]
	pub type ReplyCount<T: Config> = StorageMap<_, Blake2_128Concat, u64, u32, ValueQuery>;

	/// Reverse parent → replies index: `RepliesByParent[parent][reply_id] = ()` ⇒ `reply_id` is a
	/// direct reply of `parent`. The keyed reverse lookup mirroring [`Reposts`], so a thread reads only
	/// ONE parent's children via `getEntries(parent)` (prefix iteration) instead of folding the whole
	/// post set. A `DoubleMap` (not a `BoundedVec<u64>`) deliberately: it imposes no per-post reply cap
	/// and supports prefix pagination. Maintained in lockstep with [`ReplyCount`] on the reply-creation
	/// path; append-only (no removal), backfilled from existing `Posts` by migration v3.
	#[pallet::storage]
	pub type RepliesByParent<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		u64,
		Blake2_128Concat,
		u64,
		(),
		OptionQuery,
	>;

	/// The follow graph: `Following[follower][followee] = ()` ⇒ `follower` follows `followee`.
	/// Toggleable (a relationship, not content): `unfollow` `take`s the edge. Followee is NOT
	/// existence-checked (mirrors the dangling-`parent` design — they may bind an identity later).
	#[pallet::storage]
	pub type Following<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		T::AccountId,
		Blake2_128Concat,
		T::AccountId,
		(),
		OptionQuery,
	>;

	/// Number of accounts following `who` (`ValueQuery` ⇒ default 0).
	#[pallet::storage]
	pub type FollowerCount<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

	/// Number of accounts `who` follows (`ValueQuery` ⇒ default 0).
	#[pallet::storage]
	pub type FollowingCount<T: Config> =
		StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

	/// Reverse follow index: `Followers[followee][follower] = ()` ⇒ `follower` follows `followee` —
	/// the mirror of `Following`, so "who follows X" is a direct prefix iteration (no full-account
	/// scan). Maintained in lockstep by `follow`/`unfollow`; backfilled from `Following` by migration v2.
	#[pallet::storage]
	pub type Followers<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		T::AccountId,
		Blake2_128Concat,
		T::AccountId,
		(),
		OptionQuery,
	>;

	/// Poll metadata keyed by the host post id. `None` ⇒ that post is not a poll.
	#[pallet::storage]
	pub type Polls<T: Config> = StorageMap<_, Blake2_128Concat, u64, Poll<T>, OptionQuery>;

	/// Per-(poll, voter) recorded choice. `None` ⇒ that account has not voted in that poll.
	#[pallet::storage]
	pub type PollVotes<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		u64,
		Blake2_128Concat,
		T::AccountId,
		PollVoteRecord,
		OptionQuery,
	>;

	/// Stake-weighted tally per (poll, option). `ValueQuery` ⇒ default-zero per option.
	#[pallet::storage]
	pub type PollTally<T: Config> = StorageDoubleMap<
		_,
		Blake2_128Concat,
		u64,
		Blake2_128Concat,
		u8,
		OptionTally,
		ValueQuery,
	>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A post was created (a plain post, a reply, or a quote — the shape is read from storage).
		PostCreated { id: u64, author: T::AccountId },
		/// A capacity bucket was force-set by the `ForceOrigin` (operator/migration/dev).
		CapacityForced { who: T::AccountId, cap_last: u128 },
		/// `who` (stake-`weight`) cast or changed a `dir` vote on post `id`. `weight` is the snapshot
		/// the tally was adjusted by — it lets an off-chain indexer fold the exact same tally.
		Voted { id: u64, who: T::AccountId, dir: VoteDir, weight: u128 },
		/// `who` cleared their vote on post `id` (the tally was adjusted by their stored weight).
		VoteCleared { id: u64, who: T::AccountId },
		/// `who` reposted post `id` (permanent — there is no un-repost).
		Reposted { id: u64, who: T::AccountId },
		/// `follower` started following `followee`.
		Followed { follower: T::AccountId, followee: T::AccountId },
		/// `follower` stopped following `followee`.
		Unfollowed { follower: T::AccountId, followee: T::AccountId },
		/// A poll was created (its question is the host post `id`'s text; options are in storage).
		PollCreated { id: u64, author: T::AccountId },
		/// `who` (stake-`weight`) cast or changed their vote on poll `id` to `option`.
		PollVoted { id: u64, who: T::AccountId, option: u8, weight: u128 },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// The post text exceeded `MaxLength`.
		TooLong,
		/// No post exists with the given id (a vote / repost / quote target that does not exist).
		NotFound,
		/// The author has reached `MaxPostsPerAuthor` and cannot be indexed for another post.
		TooManyPosts,
		/// The caller has not bound a Cardano identity via the gate (`IdentityGate::is_allowed`
		/// returned `false`). The M2 anti-Sybil gate (`L3-chain.md` §4.4/§5.1).
		NotAllowed,
		/// `clear_vote` was called but the caller has no vote on that post.
		NotVoted,
		/// `repost` was called but the caller has already reposted that post (reposts are permanent).
		AlreadyReposted,
		/// `follow` was called with the caller as the target.
		SelfFollow,
		/// `follow` was called but the caller already follows that target.
		AlreadyFollowing,
		/// `unfollow` was called but the caller does not follow that target.
		NotFollowing,
		/// `create_poll` was called with fewer than 2 options.
		NotEnoughOptions,
		/// `create_poll` was called with more than `MaxPollOptions` options.
		TooManyOptions,
		/// A poll option label exceeded `MaxPollOptionLen`.
		OptionTooLong,
		/// `cast_poll_vote` referenced a post that is not a poll.
		PollNotFound,
		/// `cast_poll_vote` referenced an option index outside the poll's options.
		InvalidOption,
	}

	impl<T: Config> Pallet<T> {
		/// The stake-backed capacity ceiling for a stake `weight`: `min(weight·CapRatio, Ceiling)`
		/// (capped-linear, DR-11). The SINGLE source of truth for the ceiling — both the live meter
		/// ([`current_capacity`]) and the `force_set_capacity` clamp call this, so the
		/// "voice == locked ADA" invariant can never drift between the two (`microblog-3`/CL1).
		pub fn capacity_ceiling(weight: u128) -> u128 {
			core::cmp::min(weight.saturating_mul(T::CapRatio::get()), T::Ceiling::get())
		}

		/// Lazy regenerate-on-read (`ECONOMICS.md` §4.1). **Pure** — no writes — so it is safe
		/// to call repeatedly inside `validate()`.
		///
		/// ⚑ `None ⇒ 0` (first-touch is empty, not full) and all arithmetic is `saturating_*`,
		/// so an identity idle for years saturates into the `min(cap, …)` clamp, never wraps.
		pub fn current_capacity(who: &T::AccountId, now: BlockNumberFor<T>) -> u128 {
			let weight = pallet_talk_stake::AllowedStake::<T>::get(who); // 0 if unbound/unlocked
			let cap = Self::capacity_ceiling(weight); // capped-linear (DR-11) — the stake-backed ceiling
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

		/// Stamp the capacity bucket empty **and dated** if the row does not yet exist. Idempotent:
		/// a no-op if a row already exists, so a relock cannot re-mint a fresh full-charging bucket.
		///
		/// ⚑ Row only — it does **not** touch the provider reference (that is the bind lifecycle's
		/// job, [`OnIdentityBind::on_bind`] / `on_revoke`). A force-primed but unbound account can't
		/// post (the identity gate rejects it) so it needs no provider ref.
		pub fn on_first_bind(who: &T::AccountId) {
			if !Capacity::<T>::contains_key(who) {
				let now = frame_system::Pallet::<T>::block_number();
				Capacity::<T>::insert(who, CapacityState { cap_last: 0, last_block: now });
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
			let remaining = current.saturating_sub(cost);
			// Operator audit trail for the spam gate: every debit (and whether it floored at 0).
			// debug, not an event — `consume` runs on inclusion and must not bloat the hot path.
			if cost > current {
				// An operator-forced over-budget post can floor the bucket at 0 (saturating_sub);
				// surface that the debit was larger than the banked balance.
				log::debug!(
					target: LOG_TARGET,
					"consume: {:?} debited cost={} from balance={} (floored to 0; over-budget)",
					who, cost, current,
				);
			} else {
				log::debug!(
					target: LOG_TARGET,
					"consume: {:?} debited cost={} ({} -> {})",
					who, cost, current, remaining,
				);
			}
			Capacity::<T>::insert(who, CapacityState { cap_last: remaining, last_block: now });
		}

		/// The talk-capacity cost of a feeless social call, or `None` if the call is not metered.
		///
		/// This is the single source of truth the [`CheckCapacity`] extension uses to price EVERY
		/// feeless action against the one per-account battery. **Pure** — it reads only `#[pallet::
		/// constant]`s + the call's own bytes (no storage), so it is safe to evaluate in `validate()`.
		/// A `None` (e.g. `force_set_capacity`) means the call is not capacity-metered and passes
		/// through the extension untouched.
		pub fn metered_cost(call: &Call<T>) -> Option<u128> {
			match call {
				// A post and a quote are both content priced by length.
				Call::post_message { text, .. } | Call::quote_post { text, .. } => {
					Some(Self::post_cost(text.len() as u32))
				},
				// Votes (and clearing a vote) are a flat signal cost.
				Call::vote { .. } | Call::clear_vote { .. } => Some(T::VoteCost::get()),
				// A repost is a flat amplification cost.
				Call::repost { .. } => Some(T::RepostCost::get()),
				// Follow / unfollow are a flat relationship cost (symmetric, no free-churn).
				Call::follow { .. } | Call::unfollow { .. } => Some(T::FollowCost::get()),
				// A poll is content priced by its question length; a poll vote is a flat signal cost.
				Call::create_poll { question, .. } => Some(Self::post_cost(question.len() as u32)),
				Call::cast_poll_vote { .. } => Some(T::VoteCost::get()),
				// Everything else (force_set_capacity, the codec phantom) is unmetered.
				_ => None,
			}
		}
	}

	/// The bind/revoke lifecycle hooks `pallet-cogno-gate` invokes (via its `OnBind` Config type),
	/// kept symmetric (`gate-1`) without a Cargo dependency on cogno-gate.
	impl<T: Config> super::OnIdentityBind<T::AccountId> for Pallet<T> {
		fn on_bind(who: &T::AccountId) {
			Self::on_first_bind(who); // ensure the (relock-safe) capacity row
			// Take a provider reference so the bound account's first feeless post is not rejected by
			// `CheckNonce` (issue #3991). `link_identity` only binds an unbound account, so this inc
			// is balanced by exactly one `dec` in `on_revoke`. `inc_providers` is infallible (it
			// returns Created/Existed, never an error) — the matching failable side is `dec_providers`.
			let _ = frame_system::Pallet::<T>::inc_providers(who);
		}

		fn on_revoke(who: &T::AccountId) {
			// Release the provider reference taken at `on_bind` (gate-1). Best-effort: an outstanding
			// consumer ref would make `dec_providers` fail, in which case the ref stays — no worse
			// than the prior always-leak behaviour, but log so the leak is observable.
			if let Err(e) = frame_system::Pallet::<T>::dec_providers(who) {
				log::warn!(
					target: LOG_TARGET,
					"on_revoke: dec_providers failed for {:?}: {:?} — provider ref leaked (outstanding consumer ref?)",
					who, e,
				);
			}
			// Zero the banked capacity but KEEP the row (never delete — relock-farm guard).
			if Capacity::<T>::contains_key(who) {
				let now = frame_system::Pallet::<T>::block_number();
				Capacity::<T>::insert(who, CapacityState { cap_last: 0, last_block: now });
			} else {
				// Revoke without a prior bind row: nothing to zero. Not an error (force-priming or
				// a re-revoke), but worth a debug trail for a confused operator.
				log::debug!(
					target: LOG_TARGET,
					"on_revoke: no capacity row for {:?} — nothing to zero (re-revoke or never primed)",
					who,
				);
			}
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
		// The benchmarked `post_message` weight measures the top-level (`parent: None`) path. A reply
		// (`parent: Some`) additionally reads+writes `ReplyCount` and writes `RepliesByParent` (the
		// denormalized reply aggregates), so charge that worst case — 1 read + 2 writes — on top. A
		// top-level post overpays slightly, which is the safe direction for the anti-spam weight
		// backstop. (Adding storage maps does not change the benchmark, so this avoids a double-count.)
		#[pallet::weight(<T as Config>::WeightInfo::post_message(text.len() as u32)
			.saturating_add(T::DbWeight::get().reads_writes(1, 2)))]
		#[pallet::feeless_if(|_origin: &OriginFor<T>, _text: &Vec<u8>, _parent: &Option<u64>| -> bool { true })]
		pub fn post_message(
			origin: OriginFor<T>,
			text: Vec<u8>,
			parent: Option<u64>,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			// ⚑ M2 identity gate (belt-and-suspenders): a weighted-but-unbound account (e.g. a
			// sudo misconfig) is rejected here even though the capacity extension already rejects
			// the unbound-because-unweighted case at the pool. Identity ≠ rate limit. No event is
			// emitted on rejection (the call reverts), so log it for the operator's audit trail.
			if !T::IdentityGate::is_allowed(&who) {
				log::debug!(
					target: LOG_TARGET,
					"post_message rejected: identity not allowed for {:?} (no live Cardano binding)",
					who,
				);
				return Err(Error::<T>::NotAllowed.into());
			}
			let bounded: BoundedVec<u8, T::MaxLength> =
				text.try_into().map_err(|_| Error::<T>::TooLong)?;

			let id = NextPostId::<T>::get();
			// Index into `ByAuthor` first: on overflow this returns `Err`, the whole dispatch
			// rolls back (so the id is NOT consumed), and the caller sees a real `TooManyPosts`.
			ByAuthor::<T>::try_mutate(&who, |ids| ids.try_push(id))
				.map_err(|_| Error::<T>::TooManyPosts)?;

			let at = frame_system::Pallet::<T>::block_number();
			// `quote: None` — a plain post or a reply. Quote-posts go through `quote_post`.
			Posts::<T>::insert(id, Post { author: who.clone(), text: bounded, parent, quote: None, at });
			// Maintain the denormalized reply aggregates when this post is a reply (same lockstep
			// pattern as `repost` → `RepostCount`/`Reposts`). `parent: Option<u64>` is `Copy`, so it is
			// still readable after being moved into the `Post` above. Append-only content ⇒ increment
			// only (there is no `delete`/decrement path).
			if let Some(parent_id) = parent {
				ReplyCount::<T>::mutate(parent_id, |c| *c = c.saturating_add(1));
				RepliesByParent::<T>::insert(parent_id, id, ());
			}
			NextPostId::<T>::put(id.saturating_add(1));

			Self::deposit_event(Event::PostCreated { id, author: who });
			Ok(())
		}

		// call_index 1 is PERMANENTLY VACANT: the M0 `delete_post` was removed — content is
		// append-only (no edit, no delete). The chain is a neutral permanent ledger; what a
		// frontend shows is the frontend's policy. Never reuse index 1 (on-wire contract).

		/// Force a capacity bucket for `who` to `cap_last` (dated at the current block), gated
		/// by `ForceOrigin`. The **M2c operator/dev stand-in** for the future gate's first-bind
		/// bookkeeping: it primes the capacity row (via [`Pallet::on_first_bind`]) and lets the
		/// operator pre-charge a battery so the showcase is interactive immediately. (The provider
		/// reference is taken at identity bind, not here — an unbound account can't post anyway.)
		/// (Cardano-sourced weight + on-first-bind-at-`link_identity` are M2/M2d.)
		///
		/// `cap_last` is **clamped to the stake-backed ceiling** `min(weight·CapRatio, Ceiling)`
		/// (microblog-3): the force can prime up to what the account's locked stake backs, but can
		/// never mint capacity above it — preserving the "voice == locked ADA" invariant even
		/// against a misconfigured/compromised authority origin. (The legitimate follower flow sets
		/// `set_stake` first, then forces exactly `min(weight·CapRatio, Ceiling)`, so it is unaffected.)
		#[pallet::call_index(2)]
		#[pallet::weight(<T as Config>::WeightInfo::force_set_capacity())]
		pub fn force_set_capacity(
			origin: OriginFor<T>,
			who: T::AccountId,
			cap_last: u128,
		) -> DispatchResult {
			T::ForceOrigin::ensure_origin(origin)?;
			Self::on_first_bind(&who); // ensure the (relock-safe) capacity row exists (no provider ref)
			let now = frame_system::Pallet::<T>::block_number();
			// Clamp to what the account's current weight backs — never pre-charge above the ceiling.
			// Shares the single ceiling helper with `current_capacity` so the two can't drift (CL1).
			let weight = pallet_talk_stake::AllowedStake::<T>::get(&who);
			let ceiling = Self::capacity_ceiling(weight);
			let requested = cap_last;
			let cap_last = core::cmp::min(cap_last, ceiling);
			// The CapacityForced event reports the STORED (clamped) value but not that clamping
			// occurred — surface the silent operator clamp so a misconfigured prime is visible.
			if requested > ceiling {
				log::warn!(
					target: LOG_TARGET,
					"force_set_capacity: clamped requested cap_last={} to ceiling={} for {:?} (weight={})",
					requested, ceiling, who, weight,
				);
			}
			Capacity::<T>::insert(&who, CapacityState { cap_last, last_block: now });
			Self::deposit_event(Event::CapacityForced { who, cap_last });
			Ok(())
		}

		// ── social engagement calls (all FEELESS + capacity-metered through the SAME single battery
		//    as `post_message`; the [`CheckCapacity`] extension prices each via `metered_cost` and
		//    consumes on inclusion). Each is identity-gated in its body (belt-and-suspenders, like
		//    `post_message`). Content (quote) is permanent; signals/relationships (vote, repost,
		//    follow) follow their own rule: votes/follows toggle, reposts are permanent. ───────────

		/// Quote-post: create a post whose body is `text` and which references `quoted_id` via the
		/// `Post.quote` field (distinct from a reply's `parent`). Feeless + capacity-metered.
		#[pallet::call_index(3)]
		#[pallet::weight(<T as Config>::WeightInfo::quote_post(text.len() as u32))]
		#[pallet::feeless_if(|_origin: &OriginFor<T>, _text: &Vec<u8>, _quoted_id: &u64| -> bool { true })]
		pub fn quote_post(origin: OriginFor<T>, text: Vec<u8>, quoted_id: u64) -> DispatchResult {
			let who = ensure_signed(origin)?;
			if !T::IdentityGate::is_allowed(&who) {
				log::debug!(target: LOG_TARGET, "quote_post rejected: identity not allowed for {who:?}");
				return Err(Error::<T>::NotAllowed.into());
			}
			// Unlike a reply's `parent` (intentionally unvalidated), a quote targets a real post —
			// a quote of a phantom id has no body to ever render. One cheap `contains_key` read.
			ensure!(Posts::<T>::contains_key(quoted_id), Error::<T>::NotFound);
			let bounded: BoundedVec<u8, T::MaxLength> =
				text.try_into().map_err(|_| Error::<T>::TooLong)?;

			let id = NextPostId::<T>::get();
			ByAuthor::<T>::try_mutate(&who, |ids| ids.try_push(id))
				.map_err(|_| Error::<T>::TooManyPosts)?;

			let at = frame_system::Pallet::<T>::block_number();
			Posts::<T>::insert(
				id,
				Post { author: who.clone(), text: bounded, parent: None, quote: Some(quoted_id), at },
			);
			NextPostId::<T>::put(id.saturating_add(1));

			Self::deposit_event(Event::PostCreated { id, author: who });
			Ok(())
		}

		/// Cast or change a **stake-weighted** vote on post `post_id`. The vote's weight is the
		/// caller's `pallet_talk_stake::VotingPower` snapshot at call time — the total Cardano stake
		/// of the caller's bound stake credential, NOT the posting deposit (`AllowedStake`). Re-voting
		/// (changing direction or re-voting the same direction at a new weight) deterministically
		/// reverses the PREVIOUSLY-STORED weight from the tally before applying the fresh one — so the
		/// tally never drifts and an indexer folding the `Voted` events reproduces it byte-exactly. Feeless.
		#[pallet::call_index(4)]
		#[pallet::weight(<T as Config>::WeightInfo::vote())]
		#[pallet::feeless_if(|_origin: &OriginFor<T>, _post_id: &u64, _dir: &VoteDir| -> bool { true })]
		pub fn vote(origin: OriginFor<T>, post_id: u64, dir: VoteDir) -> DispatchResult {
			let who = ensure_signed(origin)?;
			if !T::IdentityGate::is_allowed(&who) {
				log::debug!(target: LOG_TARGET, "vote rejected: identity not allowed for {who:?}");
				return Err(Error::<T>::NotAllowed.into());
			}
			ensure!(Posts::<T>::contains_key(post_id), Error::<T>::NotFound);
			let weight = pallet_talk_stake::VotingPower::<T>::get(&who); // total-stake weight AT vote time
			VoteTally::<T>::mutate(post_id, |t| {
				// 1. REVERSE the previously-stored record (if any) by its STORED weight — never by
				//    re-reading current stake — so the tally cannot drift across a stake change.
				if let Some(prev) = Votes::<T>::get(post_id, &who) {
					match prev.dir {
						VoteDir::Up => {
							t.up_weight = t.up_weight.saturating_sub(prev.weight);
							t.up_count = t.up_count.saturating_sub(1);
						},
						VoteDir::Down => {
							t.down_weight = t.down_weight.saturating_sub(prev.weight);
							t.down_count = t.down_count.saturating_sub(1);
						},
					}
				}
				// 2. APPLY the new vote with the freshly-snapshotted weight.
				match dir {
					VoteDir::Up => {
						t.up_weight = t.up_weight.saturating_add(weight);
						t.up_count = t.up_count.saturating_add(1);
					},
					VoteDir::Down => {
						t.down_weight = t.down_weight.saturating_add(weight);
						t.down_count = t.down_count.saturating_add(1);
					},
				}
			});
			Votes::<T>::insert(post_id, &who, VoteRecord { dir, weight });
			// Reverse liked-posts index (Up = liked); switching to Down clears the like.
			match dir {
				VoteDir::Up => VotesByAccount::<T>::insert(&who, post_id, ()),
				VoteDir::Down => {
					VotesByAccount::<T>::remove(&who, post_id);
				},
			}
			Self::deposit_event(Event::Voted { id: post_id, who, dir, weight });
			Ok(())
		}

		/// Clear the caller's vote on post `post_id`, reversing exactly the stored weight from the
		/// tally (so the fold stays deterministic). Fails `NotVoted` if there is no vote. Feeless.
		#[pallet::call_index(5)]
		#[pallet::weight(<T as Config>::WeightInfo::clear_vote())]
		#[pallet::feeless_if(|_origin: &OriginFor<T>, _post_id: &u64| -> bool { true })]
		pub fn clear_vote(origin: OriginFor<T>, post_id: u64) -> DispatchResult {
			let who = ensure_signed(origin)?;
			if !T::IdentityGate::is_allowed(&who) {
				log::debug!(target: LOG_TARGET, "clear_vote rejected: identity not allowed for {who:?}");
				return Err(Error::<T>::NotAllowed.into());
			}
			let prev = Votes::<T>::take(post_id, &who).ok_or(Error::<T>::NotVoted)?;
			VotesByAccount::<T>::remove(&who, post_id); // clear any like in the reverse index
			VoteTally::<T>::mutate(post_id, |t| match prev.dir {
				VoteDir::Up => {
					t.up_weight = t.up_weight.saturating_sub(prev.weight);
					t.up_count = t.up_count.saturating_sub(1);
				},
				VoteDir::Down => {
					t.down_weight = t.down_weight.saturating_sub(prev.weight);
					t.down_count = t.down_count.saturating_sub(1);
				},
			});
			Self::deposit_event(Event::VoteCleared { id: post_id, who });
			Ok(())
		}

		/// Repost post `post_id`. **Permanent** (treated like content — there is no un-repost);
		/// a duplicate repost fails `AlreadyReposted`. Feeless + capacity-metered.
		#[pallet::call_index(6)]
		#[pallet::weight(<T as Config>::WeightInfo::repost())]
		#[pallet::feeless_if(|_origin: &OriginFor<T>, _post_id: &u64| -> bool { true })]
		pub fn repost(origin: OriginFor<T>, post_id: u64) -> DispatchResult {
			let who = ensure_signed(origin)?;
			if !T::IdentityGate::is_allowed(&who) {
				log::debug!(target: LOG_TARGET, "repost rejected: identity not allowed for {who:?}");
				return Err(Error::<T>::NotAllowed.into());
			}
			ensure!(Posts::<T>::contains_key(post_id), Error::<T>::NotFound);
			ensure!(!Reposts::<T>::contains_key(post_id, &who), Error::<T>::AlreadyReposted);
			Reposts::<T>::insert(post_id, &who, ());
			RepostCount::<T>::mutate(post_id, |c| *c = c.saturating_add(1));
			Self::deposit_event(Event::Reposted { id: post_id, who });
			Ok(())
		}

		/// Follow `target`. The caller (follower) must have a live identity binding; `target` is NOT
		/// existence-checked (it may bind later). Fails `SelfFollow` / `AlreadyFollowing`. Feeless.
		#[pallet::call_index(7)]
		#[pallet::weight(<T as Config>::WeightInfo::follow())]
		#[pallet::feeless_if(|_origin: &OriginFor<T>, _target: &T::AccountId| -> bool { true })]
		pub fn follow(origin: OriginFor<T>, target: T::AccountId) -> DispatchResult {
			let who = ensure_signed(origin)?;
			if !T::IdentityGate::is_allowed(&who) {
				log::debug!(target: LOG_TARGET, "follow rejected: identity not allowed for {who:?}");
				return Err(Error::<T>::NotAllowed.into());
			}
			ensure!(who != target, Error::<T>::SelfFollow);
			ensure!(!Following::<T>::contains_key(&who, &target), Error::<T>::AlreadyFollowing);
			Following::<T>::insert(&who, &target, ());
			Followers::<T>::insert(&target, &who, ()); // reverse index, in lockstep
			FollowingCount::<T>::mutate(&who, |c| *c = c.saturating_add(1));
			FollowerCount::<T>::mutate(&target, |c| *c = c.saturating_add(1));
			Self::deposit_event(Event::Followed { follower: who, followee: target });
			Ok(())
		}

		/// Unfollow `target`. Fails `NotFollowing` if the caller does not follow it. Feeless.
		#[pallet::call_index(8)]
		#[pallet::weight(<T as Config>::WeightInfo::unfollow())]
		#[pallet::feeless_if(|_origin: &OriginFor<T>, _target: &T::AccountId| -> bool { true })]
		pub fn unfollow(origin: OriginFor<T>, target: T::AccountId) -> DispatchResult {
			let who = ensure_signed(origin)?;
			if !T::IdentityGate::is_allowed(&who) {
				log::debug!(target: LOG_TARGET, "unfollow rejected: identity not allowed for {who:?}");
				return Err(Error::<T>::NotAllowed.into());
			}
			ensure!(Following::<T>::take(&who, &target).is_some(), Error::<T>::NotFollowing);
			Followers::<T>::remove(&target, &who); // reverse index, in lockstep
			FollowingCount::<T>::mutate(&who, |c| *c = c.saturating_sub(1));
			FollowerCount::<T>::mutate(&target, |c| *c = c.saturating_sub(1));
			Self::deposit_event(Event::Unfollowed { follower: who, followee: target });
			Ok(())
		}

		/// Create a stake-weighted poll. The `question` becomes a normal post (so the poll threads /
		/// quotes / reposts and shows in the feed); `options` (2..=`MaxPollOptions`, each
		/// ≤`MaxPollOptionLen`) are stored alongside. Feeless + capacity-metered like a post.
		#[pallet::call_index(9)]
		#[pallet::weight(<T as Config>::WeightInfo::create_poll(question.len() as u32))]
		#[pallet::feeless_if(|_origin: &OriginFor<T>, _question: &Vec<u8>, _options: &Vec<Vec<u8>>| -> bool { true })]
		pub fn create_poll(
			origin: OriginFor<T>,
			question: Vec<u8>,
			options: Vec<Vec<u8>>,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			if !T::IdentityGate::is_allowed(&who) {
				log::debug!(target: LOG_TARGET, "create_poll rejected: identity not allowed for {who:?}");
				return Err(Error::<T>::NotAllowed.into());
			}
			ensure!(options.len() >= 2, Error::<T>::NotEnoughOptions);
			let text: BoundedVec<u8, T::MaxLength> =
				question.try_into().map_err(|_| Error::<T>::TooLong)?;
			// Bound each option, then the option set. Distinct errors so the caller knows which bound.
			let mut bounded_options: BoundedVec<BoundedVec<u8, T::MaxPollOptionLen>, T::MaxPollOptions> =
				Default::default();
			for opt in options {
				let bounded_opt: BoundedVec<u8, T::MaxPollOptionLen> =
					opt.try_into().map_err(|_| Error::<T>::OptionTooLong)?;
				bounded_options
					.try_push(bounded_opt)
					.map_err(|_| Error::<T>::TooManyOptions)?;
			}

			let id = NextPostId::<T>::get();
			ByAuthor::<T>::try_mutate(&who, |ids| ids.try_push(id))
				.map_err(|_| Error::<T>::TooManyPosts)?;
			let at = frame_system::Pallet::<T>::block_number();
			// The poll's question is an ordinary post (parent/quote None), so it lives in the feed.
			Posts::<T>::insert(id, Post { author: who.clone(), text, parent: None, quote: None, at });
			Polls::<T>::insert(id, Poll { options: bounded_options });
			NextPostId::<T>::put(id.saturating_add(1));

			// PostCreated keeps poll-unaware indexers/feeds folding it as a post; PollCreated flags
			// that this post carries options.
			Self::deposit_event(Event::PostCreated { id, author: who.clone() });
			Self::deposit_event(Event::PollCreated { id, author: who });
			Ok(())
		}

		/// Cast or change a **stake-weighted** vote in poll `post_id` for `option`. Weight is the
		/// caller's `pallet_talk_stake::VotingPower` snapshot (total Cardano stake of the bound stake
		/// credential, NOT the posting deposit); a re-cast reverses the PREVIOUSLY-STORED weight from
		/// the per-option tally before applying the fresh one (same drift-free fold as [`vote`]). Feeless.
		#[pallet::call_index(10)]
		#[pallet::weight(<T as Config>::WeightInfo::cast_poll_vote())]
		#[pallet::feeless_if(|_origin: &OriginFor<T>, _post_id: &u64, _option: &u8| -> bool { true })]
		pub fn cast_poll_vote(origin: OriginFor<T>, post_id: u64, option: u8) -> DispatchResult {
			let who = ensure_signed(origin)?;
			if !T::IdentityGate::is_allowed(&who) {
				log::debug!(target: LOG_TARGET, "cast_poll_vote rejected: identity not allowed for {who:?}");
				return Err(Error::<T>::NotAllowed.into());
			}
			let poll = Polls::<T>::get(post_id).ok_or(Error::<T>::PollNotFound)?;
			ensure!((option as usize) < poll.options.len(), Error::<T>::InvalidOption);
			let weight = pallet_talk_stake::VotingPower::<T>::get(&who); // total-stake weight AT cast time
			// 1. Reverse the previously-stored choice (if any) by its STORED weight — no drift.
			if let Some(prev) = PollVotes::<T>::get(post_id, &who) {
				PollTally::<T>::mutate(post_id, prev.option, |t| {
					t.weight = t.weight.saturating_sub(prev.weight);
					t.count = t.count.saturating_sub(1);
				});
			}
			// 2. Apply the new choice with the freshly-snapshotted weight.
			PollTally::<T>::mutate(post_id, option, |t| {
				t.weight = t.weight.saturating_add(weight);
				t.count = t.count.saturating_add(1);
			});
			PollVotes::<T>::insert(post_id, &who, PollVoteRecord { option, weight });
			Self::deposit_event(Event::PollVoted { id: post_id, who, option, weight });
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

	// We implement validate / prepare / post_dispatch_details (and a REAL weight) below; the
	// macro defaults nothing here.
	impl_tx_ext_default!(T::RuntimeCall;);

	/// The extension's weight is **real** (DR-05 / `L3-chain.md` §5.4), NOT zero: it covers the
	/// `AllowedStake` + `Capacity` reads `validate()` performs (`current_capacity`) and the
	/// `Capacity` write `consume()` performs in `post_dispatch`. Counting it here is what makes
	/// the feeless post path's FULL cost — the `post_message` call body PLUS this capacity gate —
	/// land in the block-weight backstop (`posts_per_block_max`); a zero here would understate
	/// the only anti-spam and leave silent free-spam headroom. Benchmarked as `check_capacity`.
	fn weight(&self, _call: &T::RuntimeCall) -> Weight {
		<T as Config>::WeightInfo::check_capacity()
	}

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
		// Price the call against the ONE per-account battery. A call from THIS pallet is priced by
		// `metered_cost`; any OTHER feeless call (e.g. `pallet-profile`'s writes) is priced by the
		// runtime-supplied `ForeignCost`. Both draw on the same battery and are gated here at the pool,
		// so the whole app stays feeless without a second capacity extension. A `None` from the relevant
		// source ⇒ not metered (e.g. `force_set_capacity`, or a foreign call the runtime does not price)
		// ⇒ pass through and consume nothing.
		let need = if let Some(inner) = call.is_sub_type() {
			// O(1) over-length reject at the POOL (microblog-4) for the text-bearing calls: a body
			// longer than `MaxLength` is guaranteed to fail `TooLong`, so metering + feeless-including
			// it would only burn block weight on a doomed tx. `Call` (malformed) — NOT
			// `ExhaustsResources` (which would be retried) — it must not be retried.
			let over_len = match inner {
				crate::pallet::Call::post_message { text, .. }
				| crate::pallet::Call::quote_post { text, .. }
				// A poll's question is also length-bounded by MaxLength (it becomes a post body).
				| crate::pallet::Call::create_poll { question: text, .. } => {
					text.len() as u32 > T::MaxLength::get()
				},
				_ => false,
			};
			if over_len {
				log::debug!(
					target: crate::LOG_TARGET,
					"CheckCapacity: call from {:?} rejected at pool: body len > MaxLength={} (malformed, not retried)",
					who, T::MaxLength::get(),
				);
				return Err(TransactionValidityError::Invalid(InvalidTransaction::Call));
			}
			crate::pallet::Pallet::<T>::metered_cost(inner)
		} else {
			// Not one of this pallet's calls: ask the runtime-supplied foreign cost source. This seam
			// lets `pallet-profile`'s feeless writes share the one battery without microblog depending
			// on the profile crate (no Cargo cycle).
			<T as Config>::ForeignCost::cost(call)
		};
		let Some(need) = need else {
			return Ok((ValidTransaction::default(), Pre { who: None, cost: 0 }, origin));
		};
		let now = frame_system::Pallet::<T>::block_number();
		let have = crate::pallet::Pallet::<T>::current_capacity(&who, now);
		if have < need {
			// POOL REJECT — bounds INCLUSION (the block author re-runs validate at build time and
			// rejects over-budget calls). On a feeless chain this IS the spam gate. Off-chain only
			// (the pool never touches storage): log so an operator can see who hit the gate.
			log::debug!(
				target: crate::LOG_TARGET,
				"CheckCapacity: call from {:?} rejected at pool: have={} < need={}",
				who, have, need,
			);
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
		Ok((vt, Pre { who: Some(who), cost: need }, origin))
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
