//! # Microblog pallet (cogno-chain)
//!
//! **Feeless, capacity-metered posting.** `post_message` carries no fee (`#[pallet::feeless_if]` +
//! the runtime's `SkipCheckIfFeeless<ChargeTransactionPayment>`); it is rate-limited instead by a
//! regenerating, stake-weighted **talk-capacity** meter, which lives in this pallet rather than in a
//! pallet of its own. The whole anti-spam budget is the [`CheckCapacity`] transaction extension: it
//! gates **inclusion** in `validate()` (over-budget → `ExhaustsResources` at the pool) and **consumes**
//! capacity in `post_dispatch_details()` — never the reverse.
//!
//! Per-account weight comes from [`pallet_talk_stake::AllowedStake`], written ONLY by the
//! consensus-verified `cardano-observer` inherent (the sole weight writer — talk-stake is
//! call-less). The lazy token-bucket math (`current_capacity` / `on_first_bind` / `post_cost` /
//! `consume`) is computed O(1) on access — no per-block sweep. On a no-Cardano `--dev`/`local` chain,
//! weight is seeded at genesis (talk-stake `GenesisConfig`); [`Pallet::force_set_capacity`] (committee
//! `ForceOrigin`) remains an operator override. See docs/ECONOMICS.md.
//!
//! ## Anti-farm invariants (do not break)
//! - **First touch starts at ZERO** (`current_capacity` `None ⇒ 0`): a new identity charges
//!   up from empty, never a full bucket — closes the cheap-identity burst farm.
//! - **The `Capacity` row is never deleted** on unlock; only `weight → 0` clamps it. So a
//!   lock/unlock/relock cycle can't read a `None` first-touch and re-mint (relock farm).
//! - **`current_capacity` is PURE** (no writes — safe to call repeatedly in `validate()`); `consume`
//!   is the only writer on the transaction path.
//! - **Going-forward-only**: a weight change SETTLES the bucket at the OLD weight and restamps it, so
//!   regen can never accrue across a window the account spent at a different weight. A raise lifts the
//!   future `cap`/`rate` but credits nothing retroactively, and a zero-weight window banks nothing —
//!   which is what makes the relock guard hold on the observer's unlock path (`weight → 0`), not just on
//!   `on_revoke`.
//! - **[`Pallet::apply_observed_weight`] is the SOLE way weight enters the chain.** It owns the
//!   settle-then-apply order and the unchanged-weight guard; the runtime's observer `WeightSink` is a
//!   one-line delegation to it. Never call `pallet_talk_stake::apply_weight` from anywhere else — doing so
//!   changes the weight without settling and reintroduces the retro-credit farm.

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

/// Storage migrations for this pallet (`v1` adds `Post.quote`, the project's first; `v5` retires the
/// repost storage and settles every capacity bucket).
pub mod migrations;

use alloc::vec::Vec;
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
// two crates would form a cycle. Neither pallet names the other's crate in a trait bound; the
// runtime supplies the concrete cross-impl.
// ───────────────────────────────────────────────────────────────────────────────────────

/// The identity gate microblog consults before accepting a post. Implemented by
/// `pallet-cogno-gate`; wired to microblog's `Config::IdentityGate` in the runtime.
pub trait IsAllowed<AccountId> {
    /// Whether `who` has a live 1:1 Cardano-identity binding (⇒ may post).
    fn is_allowed(who: &AccountId) -> bool;

    /// Benchmark-only setup hook: force `who` into the allowed set so a subsequent
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

/// The bounded set of accounts that currently carry observed Cardano stake — the basis of every
/// LIVE weighted tally (post votes, account reputation, polls). The read path never stores a vote's
/// weight; instead it iterates THIS set and probes each staker's vote, summing their **current**
/// `pallet_talk_stake::VotingPower`. That makes the weighted score exact, single-valued and bounded by
/// one chain-wide constant (`MaxObserved`) rather than by how viral a post is — a hash-ordered voter
/// prefix would be an arbitrary subset that can drop the highest-stake voter and let a new vote LOWER
/// the score. See `docs/DYNAMIC-STAKE-VOTING-PLAN.md` §2.1.
///
/// The runtime wires this to `pallet_cardano_observer::LastObservedStake`, which is exactly the set of
/// accounts with non-zero `VotingPower` (the observer writes `VotingPower` from that same credited set
/// and clamps everything absent from it to `0`). It carries no Cargo dependency on cardano-observer —
/// microblog is the depended-upon crate — the same no-cycle seam as [`IsAllowed`]/[`ForeignCapacityCost`].
/// `()` yields the empty set (a dev/mock default with no observer).
pub trait StakerSet<AccountId> {
    /// The accounts with observed stake. Order-independent (the join sums), MaxObserved-bounded, and
    /// may contain a duplicate account harmlessly — the join de-duplicates before reading weight.
    fn stakers() -> Vec<AccountId>;
}

/// Default: no stakers (a chain with no observer). Every weighted join then reads `0`.
impl<AccountId> StakerSet<AccountId> for () {
    fn stakers() -> Vec<AccountId> {
        Vec::new()
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
    // v3 -> v4 (spec 121): backfill the top-level-post index (`TopLevelPosts` / `TopLevelByAuthor` /
    // `NextTopLevelSeq`) — see `migrations::v4`.
    // v4 -> v5 (spec 204): drop the retired repost storage and settle every capacity bucket onto the
    // settle-at-the-old-weight invariant — see `migrations::v5`.
    // v5 -> v6 (spec 205): stop STORING a vote's weight — drop the `weight` field from every vote/poll
    // record and tally (keeping only exact COUNTS), add `Poll.close_at` + the `PollResults` snapshot map.
    // Weighted scores are now derived LIVE at read time by joining the staker set against current
    // `VotingPower`, so a vote re-prices as stake moves — see `migrations::v6`.
    const STORAGE_VERSION: StorageVersion = StorageVersion::new(6);

    #[pallet::pallet]
    #[pallet::storage_version(STORAGE_VERSION)]
    pub struct Pallet<T>(_);

    #[pallet::hooks]
    impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
        /// Runs under `try-runtime` against a snapshot of REAL state (docs/UPGRADES.md's pre-enactment
        /// dry-run), so every migration — the v6 cutover and each future one — is checked to preserve the
        /// counter invariant before it is enacted. Delegates to the always-compiled
        /// [`Pallet::check_tally_consistency`] so a unit test drives the SAME assertions (CI cannot run the
        /// try-runtime hook) and the two can never drift apart.
        #[cfg(feature = "try-runtime")]
        fn try_state(_: BlockNumberFor<T>) -> Result<(), sp_runtime::TryRuntimeError> {
            Self::check_tally_consistency().map_err(Into::into)
        }
    }

    /// The pallet's configuration trait. Tightly coupled to `pallet-talk-stake` (the weight
    /// source the capacity meter reads).
    #[pallet::config]
    pub trait Config: frame_system::Config + pallet_talk_stake::Config {
        /// The overarching runtime event type.
        #[allow(deprecated)]
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
        /// The Cardano-identity gate: `post_message` is rejected with `NotAllowed` unless
        /// `IdentityGate::is_allowed(&who)`. Wired to `CognoGate` in the runtime. This is the
        /// authoritative on-chain Sybil gate; the capacity extension is separate spam control.
        type IdentityGate: IsAllowed<Self::AccountId>;
        /// Maximum length, in bytes, of a post's text. Bounds PoV / proof size. (512 in the runtime.)
        #[pallet::constant]
        type MaxLength: Get<u32>;
        /// Maximum number of posts tracked per author in the on-chain `ByAuthor` index.
        /// (10_000 in the runtime.)
        #[pallet::constant]
        type MaxPostsPerAuthor: Get<u32>;

        // ── talk-capacity constants (see docs/ECONOMICS.md; all runtime-tunable, read from metadata
        //    by the client capacity battery — never hardcode there) ─────────────────────────
        /// Capacity ceiling per unit weight: `cap = min(weight · CapRatio, Ceiling)`
        /// (micro-capacity units per lovelace).
        #[pallet::constant]
        type CapRatio: Get<u128>;
        /// Regeneration per unit weight per block: `rate = weight · RegenPerBlock`
        /// (micro-capacity units per lovelace per block).
        #[pallet::constant]
        type RegenPerBlock: Get<u128>;
        /// Hard capacity ceiling (the capped-linear curve) — a single mega-whale cannot
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
        /// Flat capacity cost of a `follow` or `unfollow` (micro-capacity units).
        #[pallet::constant]
        type FollowCost: Get<u128>;

        /// Maximum number of options a poll may have. (`create_poll` rejects more; ≥2 required.)
        #[pallet::constant]
        type MaxPollOptions: Get<u32>;
        /// Maximum length, in bytes, of a single poll option's label.
        #[pallet::constant]
        type MaxPollOptionLen: Get<u32>;

        /// Origin allowed to force a capacity row (operator/migration). Wired to the 3-of-5
        /// committee in the runtime; there is no sudo. `cogno-gate`'s bind calls
        /// [`Pallet::on_first_bind`] directly, so this is only an operator override.
        type ForceOrigin: EnsureOrigin<Self::RuntimeOrigin>;

        /// Prices feeless calls from OTHER pallets (e.g. `pallet-profile`) against this pallet's one
        /// per-account capacity battery, so the whole app can be feeless while every write is still
        /// pool-gated by [`CheckCapacity`]. The runtime supplies it (it can see every pallet's `Call`);
        /// `()` meters nothing foreign. See [`ForeignCapacityCost`].
        type ForeignCost: ForeignCapacityCost<<Self as frame_system::Config>::RuntimeCall>;

        /// The bounded set of accounts with observed Cardano stake — the basis of the LIVE weighted-tally
        /// join (post votes, account reputation, polls). The runtime wires it to
        /// `pallet_cardano_observer::LastObservedStake`; `()` is the empty dev/mock default. See
        /// [`StakerSet`] and `docs/DYNAMIC-STAKE-VOTING-PLAN.md`.
        type StakerSet: StakerSet<Self::AccountId>;

        /// Weight information for this pallet's dispatchables.
        type WeightInfo: WeightInfo;
    }

    /// A single post.
    ///
    /// `*NoBound` derives are used because `Post` is generic over `T: Config`; the plain
    /// derives would wrongly require `T: Clone/Eq/Debug` (the fields only need `T::AccountId`).
    #[derive(
        Encode,
        Decode,
        CloneNoBound,
        PartialEqNoBound,
        EqNoBound,
        DebugNoBound,
        TypeInfo,
        MaxEncodedLen,
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
        Encode,
        Decode,
        DecodeWithMemTracking,
        Clone,
        Copy,
        PartialEq,
        Eq,
        Debug,
        TypeInfo,
        MaxEncodedLen,
    )]
    pub enum VoteDir {
        /// An up-vote (endorsement).
        Up,
        /// A down-vote.
        Down,
    }

    /// One account's recorded vote on a post: just its **direction** (spec 205 / storage v6). The vote's
    /// weight is NO LONGER stored — a weighted score would go stale the moment the voter's stake moved.
    /// Instead the weighted tally is derived LIVE at read time by joining the staker set against current
    /// `VotingPower` (see [`Pallet::staker_weights`]). The stored [`VoteCounts`] keeps only exact,
    /// never-stale counts, adjusted O(1) on a re-vote / clear.
    #[derive(Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
    pub struct VoteRecord {
        /// The vote direction.
        pub dir: VoteDir,
    }

    /// The denormalized COUNTS for one post's votes (spec 205 / storage v6 — the stored-weight fields
    /// were removed; weighted scores are derived live). `ValueQuery` (default all-zero) so an unvoted
    /// post reads cleanly with no `Option`/`Some(0)` ambiguity. Adjusted O(1) by `vote`/`clear_vote`.
    /// This is the STORAGE value of [`VoteTally`] / [`AccountVoteTally`]; the 4-field [`Tally`] below is
    /// the (unchanged) WIRE type the read API returns, with weights filled from the live join.
    #[derive(
        Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, Default, TypeInfo, MaxEncodedLen,
    )]
    pub struct VoteCounts {
        /// Count of up-votes.
        pub up_count: u32,
        /// Count of down-votes.
        pub down_count: u32,
    }

    /// The stake-weighted vote tally as returned by the node read API — up/down WEIGHT (summed live from
    /// the staker set's current `VotingPower`) plus the exact up/down COUNTS. This is a WIRE-ONLY DTO
    /// (`PersonSummary` / `ProfileView` embed it, and `EnrichedPost` carries the same four numbers flat);
    /// its shape is deliberately UNCHANGED across the v6 storage cutover so the read API stays version 1
    /// and the deployed frontend keeps decoding it — only the two weight fields now carry LIVE numbers.
    #[derive(
        Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, Default, TypeInfo, MaxEncodedLen,
    )]
    pub struct Tally {
        /// Sum of up-voters' CURRENT `VotingPower` (live join, never a frozen snapshot).
        pub up_weight: u128,
        /// Sum of down-voters' CURRENT `VotingPower`.
        pub down_weight: u128,
        /// Count of up-votes.
        pub up_count: u32,
        /// Count of down-votes.
        pub down_count: u32,
    }

    /// A poll attached to a post: the fixed set of options voters choose between. The poll's question
    /// IS the host post's `text`, so a poll is a first-class post (it threads / quotes and shows in
    /// the feed); only the options + the stake-weighted per-option tally live here.
    #[derive(
        Encode,
        Decode,
        CloneNoBound,
        PartialEqNoBound,
        EqNoBound,
        DebugNoBound,
        TypeInfo,
        MaxEncodedLen,
    )]
    #[scale_info(skip_type_params(T))]
    pub struct Poll<T: Config> {
        /// The selectable options (each bounded to `MaxPollOptionLen`, up to `MaxPollOptions`).
        pub options: BoundedVec<BoundedVec<u8, T::MaxPollOptionLen>, T::MaxPollOptions>,
        /// Optional close deadline as a block number (spec 205 / storage v6). `None` ⇒ the poll floats
        /// forever (its weighted result re-prices with stake on every read); `Some(b)` ⇒ voting is
        /// rejected once `now ≥ b` and the result can be FROZEN by a permissionless `close_poll`. Existing
        /// polls migrate to `None` (the backward-compatible default).
        pub close_at: Option<BlockNumberFor<T>>,
    }

    /// One account's recorded poll choice: just the chosen option index (spec 205 / storage v6 — the
    /// stored weight was removed). Weighted per-option tallies are derived LIVE at read time from current
    /// `VotingPower`, or read from the frozen [`PollResult`] once the poll is closed. The stored
    /// [`OptionTally`] keeps only exact counts.
    #[derive(Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
    pub struct PollVoteRecord {
        /// The chosen option index (`< options.len()`).
        pub option: u8,
    }

    /// The COUNT of accounts currently choosing a single poll option (spec 205 / storage v6 — the
    /// stored-weight field was removed; per-option weight is derived live). `ValueQuery` (default zero)
    /// keyed per option.
    #[derive(
        Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, Default, TypeInfo, MaxEncodedLen,
    )]
    pub struct OptionTally {
        /// Number of accounts currently choosing this option.
        pub count: u32,
    }

    /// The FROZEN weighted result of a closed poll (spec 205 / storage v6). Written once by the
    /// permissionless `close_poll` at or after the poll's `close_at`: the exact per-option weight
    /// (summed from `VotingPower` over the staker set at the execution block) and count. Present in
    /// [`PollResults`] ⇒ the poll is finalized and reads return THIS instead of a live join, so an
    /// unstake can no longer retroactively remove weight from a socially-concluded poll.
    #[derive(
        Encode,
        Decode,
        CloneNoBound,
        PartialEqNoBound,
        EqNoBound,
        DebugNoBound,
        TypeInfo,
        MaxEncodedLen,
    )]
    #[scale_info(skip_type_params(T))]
    pub struct PollResult<T: Config> {
        /// Frozen per-option weight (index-aligned with `Poll.options`).
        pub option_weights: BoundedVec<u128, T::MaxPollOptions>,
        /// Frozen per-option count (index-aligned with `Poll.options`).
        pub option_counts: BoundedVec<u32, T::MaxPollOptions>,
        /// The block at which `close_poll` executed and took this snapshot (`≥ close_at`).
        pub closed_at: BlockNumberFor<T>,
    }

    /// The lazy token-bucket state for one identity (see docs/ECONOMICS.md).
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

    /// The id that will be assigned to the next post.
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
    /// **never deleted** on unlock (the relock-farm guard).
    #[pallet::storage]
    pub type Capacity<T: Config> = StorageMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        CapacityState<BlockNumberFor<T>>,
        OptionQuery,
    >;

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

    /// Denormalized vote COUNTS per post (`ValueQuery` ⇒ default all-zero). Storage item name unchanged
    /// (the on-chain prefix), only the value type dropped its weight fields in v6; the migration
    /// re-encodes each row in place. Weighted numbers are derived live at read time.
    #[pallet::storage]
    pub type VoteTally<T: Config> = StorageMap<_, Blake2_128Concat, u64, VoteCounts, ValueQuery>;

    /// Reverse "liked posts" index: `VotesByAccount[account][post] = ()` means `account` currently
    /// UP-votes `post` (drives the profile Likes tab without a reverse scan). Maintained in lockstep by
    /// `vote`/`clear_vote` (inserted on an Up vote, removed on a Down vote or a clear); backfilled from
    /// the Up rows of `Votes` by migration v2.
    #[pallet::storage]
    pub type VotesByAccount<T: Config> =
        StorageDoubleMap<_, Blake2_128Concat, T::AccountId, Blake2_128Concat, u64, (), OptionQuery>;

    // ── account reputation storage (stake-weighted up/down votes on ACCOUNTS — the community
    //    anti-Sybil / anti-impersonation signal). Mirrors the post-vote tally verbatim, re-keyed from
    //    a `post_id` to a target `AccountId`. ADDITIVE (empty at genesis), so no migration. ───────────

    /// Per-(target, voter) account-vote record. `None` ⇒ that voter has not voted on that account
    /// (one representation of "not voting" — `clear_account_vote` `take`s the row). The sole input to
    /// [`AccountVoteTally`]. Mirror of [`Votes`], target-keyed. NB: unlike the post side there is
    /// deliberately NO reverse "voted-for" index — no surface consumes one (`VotesByAccount` exists
    /// only for the Likes tab); it can be added additively later if an "endorsements given" view is specced.
    #[pallet::storage]
    pub type AccountVotes<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Blake2_128Concat,
        T::AccountId,
        VoteRecord,
        OptionQuery,
    >;

    /// Denormalized reputation COUNTS per target account (`ValueQuery` ⇒ default all-zero). Mirror of
    /// [`VoteTally`], target-keyed; the weighted net score is derived live at read time.
    #[pallet::storage]
    pub type AccountVoteTally<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, VoteCounts, ValueQuery>;

    // The retired repost storage (`Reposts`, `RepostCount`) lived HERE. Both were dropped in spec 204
    // together with the `repost` call; migration v5 clears their rows. Do not re-declare them — a
    // re-declared prefix would resurrect state the migration deleted.

    /// Per-parent reply count (`ValueQuery` ⇒ default 0): the number of direct replies a post has. The
    /// denormalized aggregate that lets a client read a post's reply count with one keyed lookup instead
    /// of scanning every post for `parent == id`. Maintained in lockstep with [`RepliesByParent`] on the
    /// reply-creation path. Content is append-only (`delete_post` was removed before launch; `@1` is
    /// permanently vacant), so it **only ever increments**; there is no decrement path. Backfilled from
    /// existing `Posts` by migration v3.
    #[pallet::storage]
    pub type ReplyCount<T: Config> = StorageMap<_, Blake2_128Concat, u64, u32, ValueQuery>;

    /// Reverse parent → replies index: `RepliesByParent[parent][reply_id] = ()` ⇒ `reply_id` is a
    /// direct reply of `parent`. The keyed reverse lookup that lets a thread read only ONE parent's
    /// children via `getEntries(parent)` (prefix iteration) instead of folding the whole post set. A
    /// `DoubleMap` (not a `BoundedVec<u64>`) deliberately: it imposes no per-post reply cap and supports
    /// prefix pagination. Maintained in lockstep with [`ReplyCount`] on the reply-creation path;
    /// append-only (no removal), backfilled from existing `Posts` by migration v3.
    #[pallet::storage]
    pub type RepliesByParent<T: Config> =
        StorageDoubleMap<_, Blake2_128Concat, u64, Blake2_128Concat, u64, (), OptionQuery>;

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
    pub type FollowerCount<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u32, ValueQuery>;

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

    /// Per-(poll, option) COUNT. `ValueQuery` ⇒ default-zero per option. Weighted per-option numbers are
    /// derived live at read time (or read frozen from [`PollResults`] once the poll is closed).
    #[pallet::storage]
    pub type PollTally<T: Config> =
        StorageDoubleMap<_, Blake2_128Concat, u64, Blake2_128Concat, u8, OptionTally, ValueQuery>;

    /// The FROZEN weighted result of each closed poll, keyed by host post id. `None` ⇒ the poll is not
    /// finalized (floats forever, or is past `close_at` but nobody has called `close_poll` yet). Written
    /// once by `close_poll`; reads short-circuit to it. Empty at genesis, so v6 needs no backfill.
    #[pallet::storage]
    pub type PollResults<T: Config> =
        StorageMap<_, Blake2_128Concat, u64, PollResult<T>, OptionQuery>;

    // ── Feature 3 (spec 121): the top-level-post index. A dense, reply-free sequence of top-level
    //    (`parent == None`) post ids so `feed_page` reads EXACTLY N (no reply over-scan), plus a
    //    per-author top-level index for exact-N profile paging and a correct top-level `postCount`
    //    (fixing the count-counts-replies tradeoff at the source). Maintained O(1) on every top-level
    //    creation site (`post_message`/`quote_post`/`create_poll`); backfilled by migration v4. ──

    /// The next top-level sequence number — and, since top-level posts are append-only, the running
    /// COUNT of all top-level posts ever created (the global top-level `postCount`).
    #[pallet::storage]
    pub type NextTopLevelSeq<T> = StorageValue<_, u64, ValueQuery>;

    /// `TopLevelPosts[seq] = post_id` for each top-level post, in creation order (higher seq = newer =
    /// higher id). The dense, reply-free spine `feed_page` pages over, so a page costs exactly one read
    /// per returned post — never scanning past interleaved replies.
    #[pallet::storage]
    pub type TopLevelPosts<T: Config> = StorageMap<_, Blake2_128Concat, u64, u64, OptionQuery>;

    /// Per-author top-level post ids (reply-free), bounded like [`ByAuthor`]. Drives exact-N profile
    /// paging and a correct top-level post count (`decode_len`) without folding in the author's replies.
    #[pallet::storage]
    pub type TopLevelByAuthor<T: Config> = StorageMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        BoundedVec<u64, T::MaxPostsPerAuthor>,
        ValueQuery,
    >;

    // Variant indices are PINNED with `#[codec(index)]`, never implied by declaration order. `Reposted`
    // (6) was retired in spec 204 and its index is permanently VACANT; without the pins, deleting it
    // would have shifted `Followed`/`Unfollowed`/`PollCreated`/`PollVoted` down one and silently
    // mis-decoded them in every client. Never renumber; a new variant takes the next free index (11).
    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        /// A post was created (a plain post, a reply, or a quote — the shape is read from storage).
        #[codec(index = 0)]
        PostCreated { id: u64, author: T::AccountId },
        /// A capacity bucket was force-set by the `ForceOrigin` (operator/migration/dev).
        #[codec(index = 1)]
        CapacityForced { who: T::AccountId, cap_last: u128 },
        /// `who` cast or changed a `dir` vote on post `id`. The `weight` field was DROPPED in spec 205:
        /// weight is no longer stored (it is derived live from current stake), so the event carries only
        /// the direction. Counts still fold from these events; the weighted score does not.
        #[codec(index = 2)]
        Voted {
            id: u64,
            who: T::AccountId,
            dir: VoteDir,
        },
        /// `who` cleared their vote on post `id` (its count was decremented).
        #[codec(index = 3)]
        VoteCleared { id: u64, who: T::AccountId },
        /// `who` cast or changed a `dir` reputation vote on account `target`. `weight` DROPPED in spec 205
        /// (weight is derived live) — same as `Voted`.
        #[codec(index = 4)]
        AccountVoted {
            target: T::AccountId,
            who: T::AccountId,
            dir: VoteDir,
        },
        /// `who` cleared their reputation vote on account `target` (its count was decremented).
        #[codec(index = 5)]
        AccountVoteCleared {
            target: T::AccountId,
            who: T::AccountId,
        },
        // index 6 is PERMANENTLY VACANT: `Reposted` (retired in spec 204).
        /// `follower` started following `followee`.
        #[codec(index = 7)]
        Followed {
            follower: T::AccountId,
            followee: T::AccountId,
        },
        /// `follower` stopped following `followee`.
        #[codec(index = 8)]
        Unfollowed {
            follower: T::AccountId,
            followee: T::AccountId,
        },
        /// A poll was created (its question is the host post `id`'s text; options are in storage).
        #[codec(index = 9)]
        PollCreated { id: u64, author: T::AccountId },
        /// `who` cast or changed their vote on poll `id` to `option`. `weight` DROPPED in spec 205
        /// (weight is derived live) — same as `Voted`.
        #[codec(index = 10)]
        PollVoted {
            id: u64,
            who: T::AccountId,
            option: u8,
        },
        /// Poll `host_id` was FINALIZED by `close_poll` — its weighted result is now frozen in
        /// [`PollResults`] and no longer re-prices. Added in spec 205 at the next free index (11).
        #[codec(index = 11)]
        PollClosed { host_id: u64 },
    }

    // Variant indices are PINNED with `#[codec(index)]`, never implied by declaration order — the index
    // IS the wire format of a `DispatchError::Module`. `AlreadyReposted` (5) was retired in spec 204 and
    // its index is permanently VACANT; without the pins, deleting it would have shifted the ten variants
    // below it down one, so a client would report `SelfFollow` for an `AlreadyFollowing` failure. Never
    // renumber; a new variant takes the next free index (spec 205 appended 16 and 17).
    #[pallet::error]
    pub enum Error<T> {
        /// The post text exceeded `MaxLength`.
        #[codec(index = 0)]
        TooLong,
        /// No post exists with the given id (a vote / quote target that does not exist).
        #[codec(index = 1)]
        NotFound,
        /// The author has reached `MaxPostsPerAuthor` and cannot be indexed for another post.
        #[codec(index = 2)]
        TooManyPosts,
        /// The caller has not bound a Cardano identity via the gate (`IdentityGate::is_allowed`
        /// returned `false`) — the anti-Sybil gate.
        #[codec(index = 3)]
        NotAllowed,
        /// `clear_vote` was called but the caller has no vote on that post.
        #[codec(index = 4)]
        NotVoted,
        // index 5 is PERMANENTLY VACANT: `AlreadyReposted` (retired in spec 204).
        /// `follow` was called with the caller as the target.
        #[codec(index = 6)]
        SelfFollow,
        /// `follow` was called but the caller already follows that target.
        #[codec(index = 7)]
        AlreadyFollowing,
        /// `unfollow` was called but the caller does not follow that target.
        #[codec(index = 8)]
        NotFollowing,
        /// `create_poll` was called with fewer than 2 options.
        #[codec(index = 9)]
        NotEnoughOptions,
        /// `create_poll` was called with more than `MaxPollOptions` options.
        #[codec(index = 10)]
        TooManyOptions,
        /// A poll option label exceeded `MaxPollOptionLen`.
        #[codec(index = 11)]
        OptionTooLong,
        /// `cast_poll_vote` referenced a post that is not a poll.
        #[codec(index = 12)]
        PollNotFound,
        /// `cast_poll_vote` referenced an option index outside the poll's options.
        #[codec(index = 13)]
        InvalidOption,
        /// `vote_account` was called with the caller as the target (you cannot vote your own account).
        #[codec(index = 14)]
        SelfAccountVote,
        /// `vote_account` target is not identity-bound (`is_allowed` false) — reputation votes only
        /// apply to real, 1:1 Cardano-bound identities.
        #[codec(index = 15)]
        TargetNotAllowed,
        /// `cast_poll_vote` was called on a poll whose `close_at` deadline has passed (`now ≥ close_at`).
        /// Added in spec 205 at the next free index (16).
        #[codec(index = 16)]
        PollClosed,
        /// `close_poll` was called but the poll cannot be finalized now: it has no `close_at` (it floats
        /// forever) or its `close_at` deadline has not yet been reached (`now < close_at`). Added in
        /// spec 205 (17). (An ALREADY-finalized poll is not an error — `close_poll` is idempotent.)
        #[codec(index = 17)]
        PollNotClosable,
    }

    impl<T: Config> Pallet<T> {
        /// The stake-backed capacity ceiling for a stake `weight`: `min(weight·CapRatio, Ceiling)`
        /// (capped-linear). The SINGLE source of truth for the ceiling — both the live meter
        /// ([`Pallet::current_capacity`]) and the `force_set_capacity` clamp call this, so the
        /// "voice == locked ADA" invariant can never drift between the two.
        pub fn capacity_ceiling(weight: u128) -> u128 {
            core::cmp::min(weight.saturating_mul(T::CapRatio::get()), T::Ceiling::get())
        }

        /// Lazy regenerate-on-read. **Pure** — no writes — so it is safe
        /// to call repeatedly inside `validate()`.
        ///
        /// ⚑ `None ⇒ 0` (first-touch is empty, not full) and all arithmetic is `saturating_*`,
        /// so an identity idle for years saturates into the `min(cap, …)` clamp, never wraps.
        pub fn current_capacity(who: &T::AccountId, now: BlockNumberFor<T>) -> u128 {
            let weight = pallet_talk_stake::AllowedStake::<T>::get(who); // 0 if unbound/unlocked
            let cap = Self::capacity_ceiling(weight); // capped-linear — the stake-backed ceiling
            match Capacity::<T>::get(who) {
                None => 0, // first-touch = ZERO (charges up); closes the cheap-identity burst farm
                Some(s) => {
                    let elapsed: u128 = now.saturating_sub(s.last_block).saturated_into();
                    let regen = weight
                        .saturating_mul(T::RegenPerBlock::get())
                        .saturating_mul(elapsed);
                    core::cmp::min(cap, s.cap_last.saturating_add(regen))
                }
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
                Capacity::<T>::insert(
                    who,
                    CapacityState {
                        cap_last: 0,
                        last_block: now,
                    },
                );
            }
        }

        /// **The one and only way weight may enter the chain.** The runtime's observer `WeightSink` is a
        /// one-line delegation to this, and `pallet-talk-stake::apply_weight` must never be called from
        /// anywhere else — the going-forward-only rule lives HERE, not in the caller.
        ///
        /// Three things in one, and the ORDER is the invariant:
        ///
        /// 1. **The `previous != weight` guard.** The observer re-derives the FULL Cardano vault set every
        ///    block and calls this for every credited account, so an unchanged account must cost nothing: no
        ///    `AllowedStake` write, no `StakeSet` event, no capacity write. Without it, every credited
        ///    account's row is rewritten every block — an O(MaxObserved) write storm inside a Mandatory
        ///    inherent that cannot `ExhaustsResources` and would simply run the block past its Aura slot.
        /// 2. **[`Pallet::settle_capacity_at`] BEFORE `apply_weight`, with the PREVIOUS weight.** The bucket
        ///    regenerates lazily from `(now - last_block)` priced at the account's CURRENT weight, and only
        ///    `consume` / `on_revoke` / `force_set_capacity` restamp `last_block`. So without this settle a
        ///    weight change re-prices the whole idle window at the NEW weight: an account first observed
        ///    ~100 blocks after its bind is handed a FULL bucket instead of charging up from empty, and a
        ///    relock after an observer unlock springs the old bucket back. Settling at the old weight closes
        ///    that window (`previous == 0` settles to 0 — a zero-weight period banks nothing), which is what
        ///    makes the relock guard hold on the observer's unlock path, not just on `on_revoke`. Reversed,
        ///    it would settle at the NEW weight and bank the retro-credit into `cap_last`, making the bug
        ///    permanent rather than merely visible on read.
        /// 3. **[`Pallet::on_first_bind`] OUTSIDE the guard**, because a first observation must prime the
        ///    (relock-safe) row even when the account's weight happens to be unchanged. Idempotent — one
        ///    `contains_key` read once primed.
        pub fn apply_observed_weight(who: &T::AccountId, weight: u128) {
            let previous = pallet_talk_stake::AllowedStake::<T>::get(who);
            if previous != weight {
                Self::settle_capacity_at(who, previous);
                pallet_talk_stake::Pallet::<T>::apply_weight(who, weight);
            }
            Self::on_first_bind(who);
        }

        /// Settle the bucket at the OLD weight and restamp it to `now`. MUST be called while `old_weight`
        /// is still the account's `AllowedStake` — i.e. BEFORE `apply_weight` overwrites it — so regen can
        /// never accrue across a window the account spent at a different weight. `old_weight == 0` settles
        /// to 0: a zero-weight period earns nothing and banks nothing. That is the relock guard.
        ///
        /// ⚑ Reached from the observer path only through [`Pallet::apply_observed_weight`], which calls it ONLY when
        /// the weight actually changes. Calling it unconditionally would rewrite every credited account's
        /// row on every block (the observer re-derives the full set each block) — an O(MaxObserved) write
        /// storm in a Mandatory inherent. Migration v5 calls it directly, once, to retire the last stale
        /// `last_block` left over from before the settle existed.
        ///
        /// Observably neutral at the moment of the call: it stores exactly what [`Pallet::current_capacity`]
        /// already returns for `old_weight` at `now`, so settling changes no read — it only closes the
        /// window so the NEXT one is priced at the weight actually held during it.
        pub fn settle_capacity_at(who: &T::AccountId, old_weight: u128) {
            let now = frame_system::Pallet::<T>::block_number();
            if let Some(s) = Capacity::<T>::get(who) {
                // Already settled this block — nothing accrued since, and re-settling would only
                // re-clamp `cap_last` against the ceiling for no reason.
                if s.last_block == now {
                    return;
                }
                let cap = Self::capacity_ceiling(old_weight);
                let elapsed: u128 = now.saturating_sub(s.last_block).saturated_into();
                let regen = old_weight
                    .saturating_mul(T::RegenPerBlock::get())
                    .saturating_mul(elapsed);
                let settled = core::cmp::min(cap, s.cap_last.saturating_add(regen));
                Capacity::<T>::insert(
                    who,
                    CapacityState {
                        cap_last: settled,
                        last_block: now,
                    },
                );
            }
        }

        /// The capacity cost of a post of `len` bytes.
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
            Capacity::<T>::insert(
                who,
                CapacityState {
                    cap_last: remaining,
                    last_block: now,
                },
            );
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
                }
                // Votes (and clearing a vote) are a flat signal cost.
                Call::vote { .. } | Call::clear_vote { .. } => Some(T::VoteCost::get()),
                // Account reputation votes are the same flat signal cost (reuse `VoteCost`).
                Call::vote_account { .. } | Call::clear_account_vote { .. } => {
                    Some(T::VoteCost::get())
                }
                // Follow / unfollow are a flat relationship cost (symmetric, no free-churn).
                Call::follow { .. } | Call::unfollow { .. } => Some(T::FollowCost::get()),
                // A poll is content priced by its question length; a poll vote is a flat signal cost.
                Call::create_poll { question, .. } => Some(Self::post_cost(question.len() as u32)),
                Call::cast_poll_vote { .. } => Some(T::VoteCost::get()),
                // Finalizing a poll is bounded public-good work; price it at the flat signal cost so it is
                // pool-gated (a keeper needs capacity) rather than free-spammable. Idempotent after the
                // first close, so the expensive path runs at most once per poll.
                Call::close_poll { .. } => Some(T::VoteCost::get()),
                // Everything else (force_set_capacity, the codec phantom) is unmetered.
                _ => None,
            }
        }

        /// Index a newly-created TOP-LEVEL post (`parent == None`) into the Feature 3 spine — the global
        /// `TopLevelPosts` sequence and the per-author `TopLevelByAuthor` list. Called from every
        /// top-level creation site (`post_message`/`quote_post`/`create_poll`). Returns `TooManyPosts` if
        /// the author's top-level index is full — which cannot actually happen once `ByAuthor` (a
        /// superset, pushed first) has succeeded, but the bound is honoured so the whole dispatch rolls
        /// back cleanly even on the impossible case.
        pub fn index_top_level(id: u64, author: &T::AccountId) -> DispatchResult {
            TopLevelByAuthor::<T>::try_mutate(author, |ids| ids.try_push(id))
                .map_err(|_| Error::<T>::TooManyPosts)?;
            let seq = NextTopLevelSeq::<T>::get();
            TopLevelPosts::<T>::insert(seq, id);
            NextTopLevelSeq::<T>::put(seq.saturating_add(1));
            Ok(())
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
            // Release the provider reference taken at `on_bind`. Best-effort: an outstanding
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
                Capacity::<T>::insert(
                    who,
                    CapacityState {
                        cap_last: 0,
                        last_block: now,
                    },
                );
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
        // backstop. spec 121 (Feature 3) additionally indexes a top-level post into the `TopLevelPosts`
        // spine (`index_top_level`: 2 reads + 3 writes), which weights.rs has not yet re-benchmarked, so
        // charge the per-post WORST case of the two paths — 2 reads + 3 writes — on top.
        #[pallet::weight(<T as Config>::WeightInfo::post_message(text.len() as u32)
			.saturating_add(T::DbWeight::get().reads_writes(2, 3)))]
        #[pallet::feeless_if(|_origin: &OriginFor<T>, _text: &Vec<u8>, _parent: &Option<u64>| -> bool { true })]
        pub fn post_message(
            origin: OriginFor<T>,
            text: Vec<u8>,
            parent: Option<u64>,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;
            // Identity gate (belt-and-suspenders): a weighted-but-unbound account is rejected here
            // even though the capacity extension already rejects the unbound-because-unweighted case at
            // the pool. Identity ≠ rate limit. No event is emitted on rejection (the call reverts), so
            // log it for the operator's audit trail.
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
            Posts::<T>::insert(
                id,
                Post {
                    author: who.clone(),
                    text: bounded,
                    parent,
                    quote: None,
                    at,
                },
            );
            // Maintain the denormalized reply aggregates when this post is a reply — the count and the
            // reverse index in lockstep. `parent: Option<u64>` is `Copy`, so it is still readable after
            // being moved into the `Post` above. Append-only content ⇒ increment only (there is no
            // `delete`/decrement path).
            if let Some(parent_id) = parent {
                ReplyCount::<T>::mutate(parent_id, |c| *c = c.saturating_add(1));
                RepliesByParent::<T>::insert(parent_id, id, ());
            } else {
                // Top-level post — index it into the Feature 3 spine for exact-N feed/profile paging.
                Self::index_top_level(id, &who)?;
            }
            NextPostId::<T>::put(id.saturating_add(1));

            Self::deposit_event(Event::PostCreated { id, author: who });
            Ok(())
        }

        // call_index 1 is PERMANENTLY VACANT: `delete_post` was removed before launch — content is
        // append-only (no edit, no delete). The chain is a neutral permanent ledger; what a
        // frontend shows is the frontend's policy. Never reuse index 1 (on-wire contract).

        /// Force a capacity bucket for `who` to `cap_last` (dated at the current block), gated by
        /// `ForceOrigin` (the 3-of-5 committee). An operator override: it primes the capacity row (via
        /// [`Pallet::on_first_bind`]) and pre-charges a battery. (The provider reference is taken at
        /// identity bind, not here — an unbound account can't post anyway.)
        ///
        /// `cap_last` is **clamped to the stake-backed ceiling** `min(weight·CapRatio, Ceiling)`
        /// — the force can prime up to what the account's locked stake backs, but can never mint
        /// capacity above it, preserving the "voice == locked ADA" invariant even against a
        /// compromised authority origin. An account with no observed weight cannot be primed at all.
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
            // Shares the single ceiling helper with `current_capacity` so the two can't drift.
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
            Capacity::<T>::insert(
                &who,
                CapacityState {
                    cap_last,
                    last_block: now,
                },
            );
            Self::deposit_event(Event::CapacityForced { who, cap_last });
            Ok(())
        }

        // ── social engagement calls (all FEELESS + capacity-metered through the SAME single battery
        //    as `post_message`; the [`CheckCapacity`] extension prices each via `metered_cost` and
        //    consumes on inclusion). Each is identity-gated in its body (belt-and-suspenders, like
        //    `post_message`). Content (quote) is permanent; the signal/relationship calls (vote,
        //    follow) toggle. Quote is the sole amplification primitive. ─────────────────────────────

        /// Quote-post: create a post whose body is `text` and which references `quoted_id` via the
        /// `Post.quote` field (distinct from a reply's `parent`). Feeless + capacity-metered.
        #[pallet::call_index(3)]
        // spec 121 (Feature 3): a quote is top-level, so it also runs `index_top_level` (2 reads +
        // 3 writes), not yet re-benchmarked — charge it manually.
        #[pallet::weight(<T as Config>::WeightInfo::quote_post(text.len() as u32)
			.saturating_add(T::DbWeight::get().reads_writes(2, 3)))]
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
                Post {
                    author: who.clone(),
                    text: bounded,
                    parent: None,
                    quote: Some(quoted_id),
                    at,
                },
            );
            // A quote is a top-level post — index it for exact-N feed/profile paging (Feature 3).
            Self::index_top_level(id, &who)?;
            NextPostId::<T>::put(id.saturating_add(1));

            Self::deposit_event(Event::PostCreated { id, author: who });
            Ok(())
        }

        /// Cast or change a **stake-weighted** vote on post `post_id`. The vote's weight is NO LONGER
        /// stored (spec 205): only its direction and the exact up/down COUNTS are recorded here, and the
        /// weighted score is derived LIVE at read time from the voter's CURRENT `VotingPower` (total
        /// Cardano stake). So a vote automatically re-prices as the voter's stake moves — a gain lifts it,
        /// a full unstake drops it to `0` — with no re-vote and no per-block work. Re-voting only flips the
        /// O(1) count from one side to the other. Feeless.
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
            VoteTally::<T>::mutate(post_id, |t| {
                // 1. Remove the previous direction's count (if this account already voted).
                if let Some(prev) = Votes::<T>::get(post_id, &who) {
                    match prev.dir {
                        VoteDir::Up => t.up_count = t.up_count.saturating_sub(1),
                        VoteDir::Down => t.down_count = t.down_count.saturating_sub(1),
                    }
                }
                // 2. Add the new direction's count.
                match dir {
                    VoteDir::Up => t.up_count = t.up_count.saturating_add(1),
                    VoteDir::Down => t.down_count = t.down_count.saturating_add(1),
                }
            });
            Votes::<T>::insert(post_id, &who, VoteRecord { dir });
            // Reverse liked-posts index (Up = liked); switching to Down clears the like.
            match dir {
                VoteDir::Up => VotesByAccount::<T>::insert(&who, post_id, ()),
                VoteDir::Down => {
                    VotesByAccount::<T>::remove(&who, post_id);
                }
            }
            Self::deposit_event(Event::Voted {
                id: post_id,
                who,
                dir,
            });
            Ok(())
        }

        /// Clear the caller's vote on post `post_id`, decrementing its stored direction's count. Fails
        /// `NotVoted` if there is no vote. Feeless.
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
                VoteDir::Up => t.up_count = t.up_count.saturating_sub(1),
                VoteDir::Down => t.down_count = t.down_count.saturating_sub(1),
            });
            Self::deposit_event(Event::VoteCleared { id: post_id, who });
            Ok(())
        }

        /// Cast or change a **stake-weighted** reputation vote on account `target` — the community
        /// anti-Sybil / anti-impersonation signal. As with a post vote (spec 205), only the direction and
        /// the exact up/down COUNTS are stored; the weighted reputation score is derived LIVE at read time
        /// from each voter's CURRENT `VotingPower`, so it re-prices automatically as stake moves. The
        /// target must itself be identity-bound and cannot be the caller. Feeless + capacity-metered.
        #[pallet::call_index(11)]
        #[pallet::weight(<T as Config>::WeightInfo::vote_account())]
        #[pallet::feeless_if(|_origin: &OriginFor<T>, _target: &T::AccountId, _dir: &VoteDir| -> bool { true })]
        pub fn vote_account(
            origin: OriginFor<T>,
            target: T::AccountId,
            dir: VoteDir,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;
            if !T::IdentityGate::is_allowed(&who) {
                log::debug!(target: LOG_TARGET, "vote_account rejected: identity not allowed for {who:?}");
                return Err(Error::<T>::NotAllowed.into());
            }
            ensure!(who != target, Error::<T>::SelfAccountVote);
            ensure!(
                T::IdentityGate::is_allowed(&target),
                Error::<T>::TargetNotAllowed
            );
            AccountVoteTally::<T>::mutate(&target, |t| {
                // 1. Remove the previous direction's count (if this account already voted on `target`).
                if let Some(prev) = AccountVotes::<T>::get(&target, &who) {
                    match prev.dir {
                        VoteDir::Up => t.up_count = t.up_count.saturating_sub(1),
                        VoteDir::Down => t.down_count = t.down_count.saturating_sub(1),
                    }
                }
                // 2. Add the new direction's count.
                match dir {
                    VoteDir::Up => t.up_count = t.up_count.saturating_add(1),
                    VoteDir::Down => t.down_count = t.down_count.saturating_add(1),
                }
            });
            AccountVotes::<T>::insert(&target, &who, VoteRecord { dir });
            Self::deposit_event(Event::AccountVoted { target, who, dir });
            Ok(())
        }

        /// Clear the caller's reputation vote on account `target`, decrementing its stored direction's
        /// count. Fails `NotVoted` if there is no vote. Feeless.
        #[pallet::call_index(12)]
        #[pallet::weight(<T as Config>::WeightInfo::clear_account_vote())]
        #[pallet::feeless_if(|_origin: &OriginFor<T>, _target: &T::AccountId| -> bool { true })]
        pub fn clear_account_vote(origin: OriginFor<T>, target: T::AccountId) -> DispatchResult {
            let who = ensure_signed(origin)?;
            if !T::IdentityGate::is_allowed(&who) {
                log::debug!(target: LOG_TARGET, "clear_account_vote rejected: identity not allowed for {who:?}");
                return Err(Error::<T>::NotAllowed.into());
            }
            let prev = AccountVotes::<T>::take(&target, &who).ok_or(Error::<T>::NotVoted)?;
            AccountVoteTally::<T>::mutate(&target, |t| match prev.dir {
                VoteDir::Up => t.up_count = t.up_count.saturating_sub(1),
                VoteDir::Down => t.down_count = t.down_count.saturating_sub(1),
            });
            Self::deposit_event(Event::AccountVoteCleared { target, who });
            Ok(())
        }

        // call_index 6 is PERMANENTLY VACANT: `repost` was retired in spec 204. A bare repost surfaced
        // nothing in any feed and, unlike a quote or a stake-weighted vote, carried no weight — quote is
        // the sole amplification primitive. Its storage (`Reposts`/`RepostCount`) went with it (migration
        // v5). Never reuse index 6 (on-wire contract).

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
            ensure!(
                !Following::<T>::contains_key(&who, &target),
                Error::<T>::AlreadyFollowing
            );
            Following::<T>::insert(&who, &target, ());
            Followers::<T>::insert(&target, &who, ()); // reverse index, in lockstep
            FollowingCount::<T>::mutate(&who, |c| *c = c.saturating_add(1));
            FollowerCount::<T>::mutate(&target, |c| *c = c.saturating_add(1));
            Self::deposit_event(Event::Followed {
                follower: who,
                followee: target,
            });
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
            ensure!(
                Following::<T>::take(&who, &target).is_some(),
                Error::<T>::NotFollowing
            );
            Followers::<T>::remove(&target, &who); // reverse index, in lockstep
            FollowingCount::<T>::mutate(&who, |c| *c = c.saturating_sub(1));
            FollowerCount::<T>::mutate(&target, |c| *c = c.saturating_sub(1));
            Self::deposit_event(Event::Unfollowed {
                follower: who,
                followee: target,
            });
            Ok(())
        }

        /// Create a stake-weighted poll. The `question` becomes a normal post (so the poll threads /
        /// quotes and shows in the feed); `options` (2..=`MaxPollOptions`, each ≤`MaxPollOptionLen`)
        /// are stored alongside. `close_at` is an optional block-number deadline: `None` ⇒ the poll floats
        /// forever (its weighted result re-prices with stake on every read); `Some(b)` ⇒ voting is
        /// rejected once `now ≥ b` and the weighted result can be FROZEN by `close_poll`. Feeless +
        /// capacity-metered like a post.
        ///
        /// ⚠ The `close_at` argument (added spec 205) is the ONLY call-arg change in this upgrade, so it
        /// is what moves `transaction_version` 3 → 4.
        #[pallet::call_index(9)]
        // spec 121 (Feature 3): a poll host is top-level, so it also runs `index_top_level` (2 reads +
        // 3 writes), not yet re-benchmarked — charge it manually.
        #[pallet::weight(<T as Config>::WeightInfo::create_poll(question.len() as u32)
			.saturating_add(T::DbWeight::get().reads_writes(2, 3)))]
        #[pallet::feeless_if(|_origin: &OriginFor<T>, _question: &Vec<u8>, _options: &Vec<Vec<u8>>, _close_at: &Option<BlockNumberFor<T>>| -> bool { true })]
        pub fn create_poll(
            origin: OriginFor<T>,
            question: Vec<u8>,
            options: Vec<Vec<u8>>,
            close_at: Option<BlockNumberFor<T>>,
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
            let mut bounded_options: BoundedVec<
                BoundedVec<u8, T::MaxPollOptionLen>,
                T::MaxPollOptions,
            > = Default::default();
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
            Posts::<T>::insert(
                id,
                Post {
                    author: who.clone(),
                    text,
                    parent: None,
                    quote: None,
                    at,
                },
            );
            Polls::<T>::insert(
                id,
                Poll {
                    options: bounded_options,
                    close_at,
                },
            );
            // A poll's host post is top-level — index it for exact-N feed/profile paging (Feature 3).
            Self::index_top_level(id, &who)?;
            NextPostId::<T>::put(id.saturating_add(1));

            // PostCreated keeps poll-unaware indexers/feeds folding it as a post; PollCreated flags
            // that this post carries options.
            Self::deposit_event(Event::PostCreated {
                id,
                author: who.clone(),
            });
            Self::deposit_event(Event::PollCreated { id, author: who });
            Ok(())
        }

        /// Cast or change a **stake-weighted** vote in poll `post_id` for `option`. As with a post vote
        /// (spec 205), only the chosen option and per-option COUNTS are stored; the weighted per-option
        /// result is derived LIVE at read time from each voter's CURRENT `VotingPower`, re-pricing as stake
        /// moves — until the poll is closed, when the weighted result is FROZEN. Rejected `PollClosed` once
        /// the poll's `close_at` deadline has passed (`now ≥ close_at`). Feeless.
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
            ensure!(
                (option as usize) < poll.options.len(),
                Error::<T>::InvalidOption
            );
            // Reject a vote once the poll's deadline has passed — a closed poll's result is (or will be)
            // frozen, so it must accept no further votes. `None` close_at ⇒ the poll floats open forever.
            if let Some(close_at) = poll.close_at {
                let now = frame_system::Pallet::<T>::block_number();
                ensure!(now < close_at, Error::<T>::PollClosed);
            }
            // 1. Remove the previous choice's count (if this account already voted in the poll).
            if let Some(prev) = PollVotes::<T>::get(post_id, &who) {
                PollTally::<T>::mutate(post_id, prev.option, |t| {
                    t.count = t.count.saturating_sub(1);
                });
            }
            // 2. Add the new choice's count.
            PollTally::<T>::mutate(post_id, option, |t| {
                t.count = t.count.saturating_add(1);
            });
            PollVotes::<T>::insert(post_id, &who, PollVoteRecord { option });
            Self::deposit_event(Event::PollVoted {
                id: post_id,
                who,
                option,
            });
            Ok(())
        }

        /// **Finalize** poll `host_id`: freeze its weighted per-option result. Permissionless (any
        /// identity-bound account may trigger it — typically the frontend on first view past the
        /// deadline, or any keeper). Callable once the poll's `close_at` deadline has passed
        /// (`now ≥ close_at`) and not before; a poll with no `close_at` can never be finalized. Idempotent:
        /// a call on an already-finalized poll is a no-op `Ok`.
        ///
        /// It computes the EXACT per-option weighted tally from the staker set's CURRENT `VotingPower`
        /// (§2.1 — O(`MaxObserved` × `MaxPollOptions`) bounded consensus work) and writes it to
        /// [`PollResults`], after which reads return the frozen result instead of a live join — so an
        /// unstake can no longer retroactively remove weight from a socially-concluded poll. Feeless +
        /// capacity-metered (priced at `VoteCost`).
        #[pallet::call_index(13)]
        #[pallet::weight(<T as Config>::WeightInfo::close_poll())]
        #[pallet::feeless_if(|_origin: &OriginFor<T>, _host_id: &u64| -> bool { true })]
        pub fn close_poll(origin: OriginFor<T>, host_id: u64) -> DispatchResult {
            let who = ensure_signed(origin)?;
            if !T::IdentityGate::is_allowed(&who) {
                log::debug!(target: LOG_TARGET, "close_poll rejected: identity not allowed for {who:?}");
                return Err(Error::<T>::NotAllowed.into());
            }
            let poll = Polls::<T>::get(host_id).ok_or(Error::<T>::PollNotFound)?;
            // Already finalized — idempotent no-op (a keeper may race here).
            if PollResults::<T>::contains_key(host_id) {
                log::debug!(target: LOG_TARGET, "close_poll: poll {host_id} already finalized (no-op)");
                return Ok(());
            }
            // Only closable at/after a set deadline (`None` ⇒ floats forever, never closable).
            let close_at = poll.close_at.ok_or(Error::<T>::PollNotClosable)?;
            let now = frame_system::Pallet::<T>::block_number();
            ensure!(now >= close_at, Error::<T>::PollNotClosable);

            // The frozen weighted result: per-option weight summed from the staker set's CURRENT
            // VotingPower (exact, single-valued, MaxObserved-bounded), plus the stored per-option count.
            let num_options = poll.options.len();
            let counts: Vec<u32> = (0..num_options)
                .map(|i| PollTally::<T>::get(host_id, i as u8).count)
                .collect();
            let total: u32 = counts.iter().copied().fold(0, |a, c| a.saturating_add(c));
            // No votes ⇒ freeze an all-zero weighted result without the O(`|staker_set|`) staker-set join.
            let weights = if total == 0 {
                alloc::vec![0u128; num_options]
            } else {
                Self::poll_option_weights(host_id, num_options, &Self::staker_weights())
            };
            let mut option_weights: BoundedVec<u128, T::MaxPollOptions> = Default::default();
            let mut option_counts: BoundedVec<u32, T::MaxPollOptions> = Default::default();
            for (i, w) in weights.into_iter().enumerate() {
                // `poll.options.len() ≤ MaxPollOptions`, so both pushes are within bound.
                option_weights
                    .try_push(w)
                    .map_err(|_| Error::<T>::TooManyOptions)?;
                option_counts
                    .try_push(counts[i])
                    .map_err(|_| Error::<T>::TooManyOptions)?;
            }
            PollResults::<T>::insert(
                host_id,
                PollResult {
                    option_weights,
                    option_counts,
                    closed_at: now,
                },
            );
            Self::deposit_event(Event::PollClosed { host_id });
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

    /// The extension's weight is **real**, NOT zero: it covers the
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
            return Ok((
                ValidTransaction::default(),
                Pre { who: None, cost: 0 },
                origin,
            ));
        };
        // Price the call against the ONE per-account battery. A call from THIS pallet is priced by
        // `metered_cost`; any OTHER feeless call (e.g. `pallet-profile`'s writes) is priced by the
        // runtime-supplied `ForeignCost`. Both draw on the same battery and are gated here at the pool,
        // so the whole app stays feeless without a second capacity extension. A `None` from the relevant
        // source ⇒ not metered (e.g. `force_set_capacity`, or a foreign call the runtime does not price)
        // ⇒ pass through and consume nothing.
        let need = if let Some(inner) = call.is_sub_type() {
            // O(1) over-length reject at the POOL for the text-bearing calls: a body
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
            return Ok((
                ValidTransaction::default(),
                Pre { who: None, cost: 0 },
                origin,
            ));
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
            return Err(TransactionValidityError::Invalid(
                InvalidTransaction::ExhaustsResources,
            ));
        }
        // Priority tied to remaining headroom + short longevity so over-budget bursts age
        // out. u128 → u64 saturates (whale-scale headroom pins to u64::MAX; harmless).
        let vt = ValidTransaction {
            priority: have.saturating_sub(need).saturated_into::<u64>(),
            longevity: 8,
            propagate: true,
            ..Default::default()
        };
        Ok((
            vt,
            Pre {
                who: Some(who),
                cost: need,
            },
            origin,
        ))
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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// spec-120 node-served reads — the `MicroblogApi` runtime read API (docs/SCALE-NODE-READS.md).
//
// A keyed-read feed page costs the client several JSON-RPC reads PER POST (tally + reply count +
// poll + author profile + the viewer's own vote) — ~150 round-trips for a 30-post page. The helpers
// below fold that whole loop into the runtime so ONE `state_call`
// returns a fully enriched, viewer-aware page, atomic at a single block. The DTOs are transport
// only: codec + `TypeInfo`, NOT `MaxEncodedLen` (they carry unbounded post text); they are generic
// over `AccountId` alone, so the API trait + impl live free of `T`. Author profile fields
// (`display_name`/`avatar`) are filled by the RUNTIME from pallet-profile — pallet-microblog stays
// free of a profile dependency, the same no-Cargo-cycle posture as `IsAllowed`/`ForeignCapacityCost`.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/// Hard cap on a page `limit` — clamped, never errored (the client may ask for fewer).
pub const MAX_PAGE: u32 = 100;
/// Per-call id-scan cap for the global / following feed: examine at most `limit · MAX_SCAN_FACTOR`
/// post ids before handing back a `next_cursor` to continue from, so a reply-dense id range can
/// never trigger an unbounded walk. (Feature 3's top-level index removes the over-scan at the source.)
const MAX_SCAN_FACTOR: u32 = 8;
/// Ancestor-chain depth cap for `thread` — matches the client's `MAX_ANCESTOR_DEPTH` so the
/// node-served thread and the keyed-read fallback reconstruct the same breadcrumb. A visited-set
/// (in `thread`) additionally breaks any cyclic `parent` chain (`parent` is unvalidated at creation).
const MAX_THREAD_DEPTH: u32 = 64;
/// Cap on how many direct replies `thread` ENRICHES in one call. The per-reply enrichment (~5-8 storage
/// reads each) is the expensive part of a `thread` state_call, so a viral post with tens of thousands of
/// replies is bounded here (the oldest `MAX_THREAD_REPLIES`, chronological) rather than enriching every
/// one. Consistent with the other capped node reads (`MAX_EDGES`/`MAX_VIEWER_IDS`); a whale thread
/// graduates to a paged replies read (`docs/SCALE-NODE-READS.md`).
const MAX_THREAD_REPLIES: usize = 512;
/// Cap on the follow-edge id lists `follow_edges` returns. The exact `follower_count`/`following_count`
/// are ALWAYS accurate (read from the O(1) aggregates); only the returned id lists truncate past this —
/// a whale's full edge set graduates to a paged/indexed read.
const MAX_EDGES: usize = 1_000;
/// Cap on the number of post ids `viewer_states` stamps in one call (about a page's worth; excess ids
/// beyond this are dropped — the client asks per visible page).
const MAX_VIEWER_IDS: usize = 256;

/// ASCII-case-insensitive substring test — is `needle` a substring of `haystack` (an empty `needle`
/// matches). The Option-1 in-runtime search primitive, shared by the linear-scan `search_posts` (post
/// text) and the runtime's `search_people` (display name); a node-side inverted index + custom
/// RPC is the documented graduation once corpus size demands it (`docs/SCALE-NODE-READS.md`).
pub fn contains_ci(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.len() > haystack.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|w| w.iter().zip(needle).all(|(a, b)| a.eq_ignore_ascii_case(b)))
}

/// A one-level quoted-post summary embedded in an [`EnrichedPost`]. The author display fields are
/// filled by the runtime from pallet-profile (empty otherwise).
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct QuotedSummary<AccountId> {
    /// The quoted post's id.
    pub id: u64,
    /// The quoted post's author.
    pub author: AccountId,
    /// The quoted post's body bytes.
    pub text: Vec<u8>,
    /// The quoted author's display name (runtime-filled from pallet-profile; empty if unset).
    pub author_display_name: Vec<u8>,
    /// The quoted author's avatar reference (runtime-filled; empty if unset).
    pub author_avatar: Vec<u8>,
}

/// One enriched, viewer-aware post — everything a feed card renders, in a single shot.
///
/// ⚑ `repost_count` / `reposted` are VESTIGIAL (always `0` / `false` since spec 204, when reposting was
/// retired). They are RETAINED, not removed: the deployed frontend bundle decodes this struct field-by-
/// field, so dropping them would change the return encoding and break the live feed for every client
/// that has not reloaded. Keeping them costs 5 bytes a post and keeps `MicroblogApi` at version 1.
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct EnrichedPost<AccountId> {
    /// The post id.
    pub id: u64,
    /// The author account.
    pub author: AccountId,
    /// The post body bytes.
    pub text: Vec<u8>,
    /// The reply parent, if this is a reply.
    pub parent: Option<u64>,
    /// The quoted post id, if this is a quote.
    pub quote: Option<u64>,
    /// The block number the post was created at (`u32` — the chain's `BlockNumber`).
    pub at: u32,
    /// Sum of up-voters' stake-weight snapshots.
    pub up_weight: u128,
    /// Sum of down-voters' stake-weight snapshots.
    pub down_weight: u128,
    /// Up-vote count.
    pub up_count: u32,
    /// Down-vote count.
    pub down_count: u32,
    /// Vestigial — always `0` (reposting was retired in spec 204). Kept for wire compatibility.
    pub repost_count: u32,
    /// Direct-reply count.
    pub reply_count: u32,
    /// Whether this post hosts a poll.
    pub is_poll: bool,
    /// Viewer overlay: the viewer's own vote (`None` if not voted / no viewer supplied).
    pub my_vote: Option<VoteDir>,
    /// Vestigial — always `false` (reposting was retired in spec 204). Kept for wire compatibility.
    pub reposted: bool,
    /// Author display name (runtime-filled from pallet-profile; empty if unset).
    pub author_display_name: Vec<u8>,
    /// Author avatar reference (runtime-filled; empty if unset).
    pub author_avatar: Vec<u8>,
    /// One-level resolved quoted-post summary (when `quote` is `Some` and the target exists).
    pub quoted: Option<QuotedSummary<AccountId>>,
}

/// One page of enriched posts plus the cursor to continue below. `next_cursor == None` ⇒ the scan
/// reached the end of the (examined) id space; otherwise pass it back as the next `before_id`.
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct FeedPage<AccountId> {
    /// The page of enriched posts, newest-first.
    pub posts: Vec<EnrichedPost<AccountId>>,
    /// The `before_id` to pass for the next page, or `None` at the end of the feed.
    pub next_cursor: Option<u64>,
}

/// A reconstructed thread: the focal post, its ancestor chain (root-first, depth-capped) and its
/// direct replies (chronological) — all enriched and viewer-aware.
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct Thread<AccountId> {
    /// The ancestor chain from the root down to the focal post's parent (root-first).
    pub ancestors: Vec<EnrichedPost<AccountId>>,
    /// The focal post, or `None` if it does not exist.
    pub focal: Option<EnrichedPost<AccountId>>,
    /// The focal post's direct replies, chronological (ascending id).
    pub replies: Vec<EnrichedPost<AccountId>>,
}

/// A compact person row for the search / who-to-follow lists. The runtime fills `display_name`/`avatar`
/// from pallet-profile and `weight`/`follower_count` from talk-stake / microblog (the pallet leaves them
/// so it carries no profile/talk-stake dependency).
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct PersonSummary<AccountId> {
    /// The account.
    pub account: AccountId,
    /// Display name (runtime-filled from pallet-profile; empty if unset).
    pub display_name: Vec<u8>,
    /// Avatar reference (runtime-filled; empty if unset).
    pub avatar: Vec<u8>,
    /// Posting-power weight (`pallet_talk_stake::AllowedStake`, buried lovelace) — the ranking scalar.
    pub weight: u128,
    /// Number of accounts following this person (the `FOLLOWER_COUNT_DESC` rank key).
    pub follower_count: u32,
    /// The person's community reputation tally (stake-weighted up/down votes ON this account); the
    /// net score = `up_weight − down_weight`. Lets discovery rows show a reputation chip.
    pub account_tally: Tally,
}

/// A full profile view — the header a profile page renders, assembled by the RUNTIME across pallet-profile
/// (display/bio/avatar/banner/location/website + pinned post), talk-stake (`weight`/`voting_power`),
/// cogno-gate (`identity_hash` + the `is_allowed` post gate) and microblog (top-level post + follow counts).
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct ProfileView<AccountId> {
    /// The account.
    pub account: AccountId,
    /// The bound 32-byte Cardano identity hash (cogno-gate `PkhOf`), or `None` if unbound.
    pub identity_hash: Option<[u8; 32]>,
    /// The live post gate: `true` iff a 1:1 Cardano identity is currently bound (`is_allowed`). `false`
    /// covers both never-bound and revoked (the frontend's `banned` flag is `!is_allowed`).
    pub is_allowed: bool,
    /// Posting-power weight (`AllowedStake`, buried lovelace).
    pub weight: u128,
    /// Stake-vote weight (`VotingPower`, total Cardano stake of the bound stake credential).
    pub voting_power: u128,
    /// The account's community reputation tally: stake-weighted up/down votes cast ON this account
    /// (net score = `up_weight − down_weight`). The anti-Sybil / anti-impersonation signal.
    pub account_tally: Tally,
    /// Display name (empty if no profile set).
    pub display_name: Vec<u8>,
    /// Bio (empty if unset).
    pub bio: Vec<u8>,
    /// Avatar reference (empty if unset).
    pub avatar: Vec<u8>,
    /// Banner reference (empty if unset).
    pub banner: Vec<u8>,
    /// Location (empty if unset).
    pub location: Vec<u8>,
    /// Website reference (empty if unset).
    pub website: Vec<u8>,
    /// The pinned post id (`pallet_profile::PinnedPost`), or `None`.
    pub pinned_post_id: Option<u64>,
    /// TOP-LEVEL post count (replies excluded) — the profile `postCount`.
    pub post_count: u32,
    /// Accounts following this account.
    pub follower_count: u32,
    /// Accounts this account follows.
    pub following_count: u32,
}

/// One poll option with its stake-weighted tally, for [`PollView`].
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct PollOptionView {
    /// The 0-based option index (matches the on-chain option index).
    pub index: u8,
    /// The option label bytes.
    pub label: Vec<u8>,
    /// Sum of the weight snapshots of accounts currently choosing this option.
    pub weight: u128,
    /// Number of accounts currently choosing this option.
    pub count: u32,
}

/// A poll's options + per-option tally + total current voters, for the poll card (`poll(host_id)`).
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct PollView {
    /// The host post id (the poll's question is that post).
    pub host_id: u64,
    /// The options with their tallies, in on-chain index order.
    pub options: Vec<PollOptionView>,
    /// Total current voters (the sum of the per-option counts — each account has exactly one choice).
    pub total_votes: u32,
}

/// One post's viewer overlay, for the `viewer_states` batch read (the filled-heart state).
///
/// ⚑ `reposted` is VESTIGIAL (always `false` since spec 204) and RETAINED for the same wire-compatibility
/// reason as [`EnrichedPost`]'s — the deployed frontend decodes this struct field-by-field.
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct ViewerState {
    /// The queried post id.
    pub post_id: u64,
    /// The viewer's own vote on it (`None` if not voted).
    pub my_vote: Option<VoteDir>,
    /// Vestigial — always `false` (reposting was retired in spec 204). Kept for wire compatibility.
    pub reposted: bool,
}

/// The follow edges + counts for one account (`follow_edges(who)`). The counts are exact; the id lists
/// are truncated at [`MAX_EDGES`] (documented, not silently wrong — a whale graduates to a paged read).
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct FollowEdges<AccountId> {
    /// Exact number of accounts following `who`.
    pub follower_count: u32,
    /// Exact number of accounts `who` follows.
    pub following_count: u32,
    /// Accounts `who` follows (the followee ids), truncated at [`MAX_EDGES`].
    pub following: Vec<AccountId>,
    /// Accounts following `who` (the follower ids), truncated at [`MAX_EDGES`].
    pub followers: Vec<AccountId>,
}

impl<T: Config> Pallet<T> {
    /// Clamp a requested page `limit` to `[1, MAX_PAGE]`.
    fn clamp_limit(limit: u32) -> u32 {
        limit.clamp(1, MAX_PAGE)
    }

    /// Storage-consistency invariant: every denormalized COUNTER equals the number of records it counts,
    /// and every reverse index mirrors its forward edge. This is LOAD-BEARING, not cosmetic — the live
    /// weighted tally short-circuits on a zero count (`post_weighted` / `account_weighted` / `poll` skip
    /// the staker join when the count is 0), so a counter that under-reports its records would silently
    /// read as ZERO weight while the vote records still exist. Always compiled (behind `test` OR
    /// `try-runtime`) so a unit test drives the exact assertions the `try_state` hook runs at upgrade
    /// time — CI does not execute try-runtime — and so the checker can never drift from the hook.
    #[cfg(any(test, feature = "try-runtime"))]
    pub(crate) fn check_tally_consistency() -> Result<(), &'static str> {
        use alloc::collections::BTreeMap;

        // 1. post votes: VoteTally counts == Votes rows, split by direction.
        let mut post: BTreeMap<u64, (u32, u32)> = BTreeMap::new();
        for (id, _voter, rec) in Votes::<T>::iter() {
            let e = post.entry(id).or_default();
            match rec.dir {
                VoteDir::Up => e.0 = e.0.saturating_add(1),
                VoteDir::Down => e.1 = e.1.saturating_add(1),
            }
        }
        for (id, counts) in VoteTally::<T>::iter() {
            let (up, down) = post.remove(&id).unwrap_or((0, 0));
            if counts.up_count != up || counts.down_count != down {
                return Err("VoteTally disagrees with the Votes records for a post");
            }
        }
        if !post.is_empty() {
            return Err("Votes records exist for a post with no VoteTally row");
        }

        // 2. account (reputation) votes: mirror of the post side, target-keyed.
        let mut acct: BTreeMap<T::AccountId, (u32, u32)> = BTreeMap::new();
        for (target, _voter, rec) in AccountVotes::<T>::iter() {
            let e = acct.entry(target).or_default();
            match rec.dir {
                VoteDir::Up => e.0 = e.0.saturating_add(1),
                VoteDir::Down => e.1 = e.1.saturating_add(1),
            }
        }
        for (target, counts) in AccountVoteTally::<T>::iter() {
            let (up, down) = acct.remove(&target).unwrap_or((0, 0));
            if counts.up_count != up || counts.down_count != down {
                return Err(
                    "AccountVoteTally disagrees with the AccountVotes records for a target",
                );
            }
        }
        if !acct.is_empty() {
            return Err("AccountVotes records exist for a target with no AccountVoteTally row");
        }

        // 3. poll options: PollTally[poll][option].count == the PollVotes choosing that option.
        let mut poll: BTreeMap<(u64, u8), u32> = BTreeMap::new();
        for (host, _voter, rec) in PollVotes::<T>::iter() {
            let e = poll.entry((host, rec.option)).or_default();
            *e = e.saturating_add(1);
        }
        for (host, option, tally) in PollTally::<T>::iter() {
            let n = poll.remove(&(host, option)).unwrap_or(0);
            if tally.count != n {
                return Err("PollTally disagrees with the PollVotes records for an option");
            }
        }
        if !poll.is_empty() {
            return Err("PollVotes records exist for a (poll, option) with no PollTally row");
        }

        // 4. follow graph: FollowerCount / FollowingCount == rows, and every forward edge is mirrored.
        let mut followers: BTreeMap<T::AccountId, u32> = BTreeMap::new();
        for (target, _follower) in Followers::<T>::iter_keys() {
            let e = followers.entry(target).or_default();
            *e = e.saturating_add(1);
        }
        for (target, count) in FollowerCount::<T>::iter() {
            if count != followers.remove(&target).unwrap_or(0) {
                return Err("FollowerCount disagrees with the Followers rows");
            }
        }
        if !followers.is_empty() {
            return Err("Followers rows exist for a target with no FollowerCount row");
        }
        let mut following: BTreeMap<T::AccountId, u32> = BTreeMap::new();
        for (who, _followee) in Following::<T>::iter_keys() {
            let e = following.entry(who).or_default();
            *e = e.saturating_add(1);
        }
        for (who, count) in FollowingCount::<T>::iter() {
            if count != following.remove(&who).unwrap_or(0) {
                return Err("FollowingCount disagrees with the Following rows");
            }
        }
        if !following.is_empty() {
            return Err("Following rows exist for a who with no FollowingCount row");
        }
        // Reverse-index lockstep: `Following[follower][followee]` ⇔ `Followers[followee][follower]`.
        for (follower, followee) in Following::<T>::iter_keys() {
            if !Followers::<T>::contains_key(&followee, &follower) {
                return Err("a Following edge is missing its Followers mirror");
            }
        }
        for (followee, follower) in Followers::<T>::iter_keys() {
            if !Following::<T>::contains_key(&follower, &followee) {
                return Err("a Followers edge is missing its Following mirror");
            }
        }

        // 5. reply aggregate: ReplyCount == RepliesByParent rows (append-only, increment-only).
        let mut replies: BTreeMap<u64, u32> = BTreeMap::new();
        for (parent, _child) in RepliesByParent::<T>::iter_keys() {
            let e = replies.entry(parent).or_default();
            *e = e.saturating_add(1);
        }
        for (parent, count) in ReplyCount::<T>::iter() {
            if count != replies.remove(&parent).unwrap_or(0) {
                return Err("ReplyCount disagrees with the RepliesByParent rows");
            }
        }
        if !replies.is_empty() {
            return Err("RepliesByParent rows exist for a parent with no ReplyCount row");
        }

        // 6. the "liked posts" reverse index: `VotesByAccount[account][post]` ⇔ an Up vote on `post`.
        for (account, post) in VotesByAccount::<T>::iter_keys() {
            match Votes::<T>::get(post, &account) {
                Some(rec) if rec.dir == VoteDir::Up => {}
                _ => return Err("VotesByAccount has an entry with no matching Up vote"),
            }
        }
        for (post, account, rec) in Votes::<T>::iter() {
            if rec.dir == VoteDir::Up && !VotesByAccount::<T>::contains_key(&account, post) {
                return Err("an Up vote is missing its VotesByAccount entry");
            }
        }

        Ok(())
    }

    /// The current staker→weight list: every account with observed Cardano stake paired with its LIVE
    /// `pallet_talk_stake::VotingPower`. This is the exact, `MaxObserved`-bounded basis of every weighted
    /// tally (post votes, account reputation, live polls). Build it ONCE per read `state_call` and reuse
    /// it across every post / account / poll on the page — a feed page then costs `|staker_set|` weight
    /// reads + `|staker_set| × page_size` O(1) membership probes, independent of how viral a post is.
    ///
    /// De-duplicated by account (a single account can never be double-counted even if the injected set
    /// somehow lists it twice), so the join is provably single-valued. See `docs/DYNAMIC-STAKE-VOTING-PLAN.md`.
    pub fn staker_weights() -> Vec<(T::AccountId, u128)> {
        let mut seen = alloc::collections::BTreeSet::new();
        let mut out = Vec::new();
        for who in T::StakerSet::stakers() {
            if seen.insert(who.clone()) {
                let w = pallet_talk_stake::VotingPower::<T>::get(&who);
                out.push((who, w));
            }
        }
        out
    }

    /// Live weighted vote tally for a post: iterate the staker set, probe each staker's vote on `post_id`,
    /// sum their CURRENT weight per direction. Exact + single-valued (it iterates stakers, never a
    /// hash-ordered voter prefix). Returns `(up_weight, down_weight)`.
    ///
    /// Short-circuits to `(0, 0)` when the already-read `counts` show the post has no votes at all — the
    /// overwhelmingly common case in a feed. A zero count means no account holds a `Votes` record, so the
    /// scan would sum nothing; skipping it keeps an unvoted post off the O(`|staker_set|`) path.
    fn post_weighted(
        post_id: u64,
        counts: &VoteCounts,
        stakers: &[(T::AccountId, u128)],
    ) -> (u128, u128) {
        if counts.up_count == 0 && counts.down_count == 0 {
            return (0, 0);
        }
        let mut up = 0u128;
        let mut down = 0u128;
        for (who, w) in stakers {
            if let Some(rec) = Votes::<T>::get(post_id, who) {
                match rec.dir {
                    VoteDir::Up => up = up.saturating_add(*w),
                    VoteDir::Down => down = down.saturating_add(*w),
                }
            }
        }
        (up, down)
    }

    /// Live weighted reputation tally for account `target` (the account-vote mirror of
    /// [`Self::post_weighted`]). Same zero-count short-circuit. Returns `(up_weight, down_weight)`.
    fn account_weighted(
        target: &T::AccountId,
        counts: &VoteCounts,
        stakers: &[(T::AccountId, u128)],
    ) -> (u128, u128) {
        if counts.up_count == 0 && counts.down_count == 0 {
            return (0, 0);
        }
        let mut up = 0u128;
        let mut down = 0u128;
        for (who, w) in stakers {
            if let Some(rec) = AccountVotes::<T>::get(target, who) {
                match rec.dir {
                    VoteDir::Up => up = up.saturating_add(*w),
                    VoteDir::Down => down = down.saturating_add(*w),
                }
            }
        }
        (up, down)
    }

    /// The full reputation [`Tally`] (the WIRE type) for account `target`: exact up/down COUNTS from
    /// storage + LIVE up/down weight from the staker-set join. Used by the runtime's `person_summary` /
    /// `profile` reads (which build `stakers` once via [`Self::staker_weights`] and reuse it per row).
    pub fn account_tally(target: &T::AccountId, stakers: &[(T::AccountId, u128)]) -> Tally {
        let counts = AccountVoteTally::<T>::get(target);
        let (up_weight, down_weight) = Self::account_weighted(target, &counts, stakers);
        Tally {
            up_weight,
            down_weight,
            up_count: counts.up_count,
            down_count: counts.down_count,
        }
    }

    /// Live per-option weight for a poll: one pass over the staker set, adding each staker's CURRENT
    /// weight to whichever option they currently choose. Returns a `num_options`-length vec, index-aligned
    /// with `Poll.options`. O(`|staker_set|`), not O(`|staker_set| × options`).
    fn poll_option_weights(
        host_id: u64,
        num_options: usize,
        stakers: &[(T::AccountId, u128)],
    ) -> Vec<u128> {
        let mut weights = alloc::vec![0u128; num_options];
        for (who, w) in stakers {
            if let Some(rec) = PollVotes::<T>::get(host_id, who) {
                let idx = rec.option as usize;
                if idx < num_options {
                    weights[idx] = weights[idx].saturating_add(*w);
                }
            }
        }
        weights
    }

    /// Build the enriched, viewer-aware view of an already-fetched `post`. Author-profile fields are
    /// left empty — the runtime fills them from pallet-profile (no profile dependency here). `stakers`
    /// is the shared staker→weight list ([`Self::staker_weights`]) used to derive the LIVE weighted score.
    fn enrich(
        id: u64,
        post: Post<T>,
        viewer: Option<&T::AccountId>,
        stakers: &[(T::AccountId, u128)],
    ) -> EnrichedPost<T::AccountId> {
        let Post {
            author,
            text,
            parent,
            at,
            quote,
        } = post;
        let counts = VoteTally::<T>::get(id);
        let (up_weight, down_weight) = Self::post_weighted(id, &counts, stakers);
        let my_vote = viewer.and_then(|who| Votes::<T>::get(id, who).map(|r| r.dir));
        // One-level quote resolution (the quoted author's profile is runtime-filled later).
        let quoted = quote.and_then(|qid| {
            Posts::<T>::get(qid).map(|qp| QuotedSummary {
                id: qid,
                author: qp.author,
                text: qp.text.into_inner(),
                author_display_name: Vec::new(),
                author_avatar: Vec::new(),
            })
        });
        EnrichedPost {
            id,
            author,
            text: text.into_inner(),
            parent,
            quote,
            at: at.saturated_into::<u32>(),
            // Weighted score derived LIVE from current stake; counts are exact from storage.
            up_weight,
            down_weight,
            up_count: counts.up_count,
            down_count: counts.down_count,
            // Vestigial since spec 204 (reposting retired) — the FIELDS stay on the wire so the deployed
            // frontend keeps decoding, but there is no storage behind them any more.
            repost_count: 0,
            reply_count: ReplyCount::<T>::get(id),
            is_poll: Polls::<T>::contains_key(id),
            my_vote,
            reposted: false,
            author_display_name: Vec::new(),
            author_avatar: Vec::new(),
            quoted,
        }
    }

    /// Fetch + enrich a post by id (`None` if it does not exist).
    fn enriched_post(
        id: u64,
        viewer: Option<&T::AccountId>,
        stakers: &[(T::AccountId, u128)],
    ) -> Option<EnrichedPost<T::AccountId>> {
        Posts::<T>::get(id).map(|post| Self::enrich(id, post, viewer, stakers))
    }

    /// Scan the global id space newest-first for TOP-LEVEL posts (`parent == None`) that also pass
    /// `keep`, paged strictly below `before_id` (`None` ⇒ from the head). Bounds the scan at
    /// `limit · MAX_SCAN_FACTOR` ids and returns `next_cursor` (the last id examined) so the client
    /// continues without an unbounded walk. Shared by `feed_page` (keep-all) and `following_feed_page`
    /// (keep authors the viewer follows).
    fn scan_top_level_by_seq<F>(
        before: Option<u64>,
        limit: u32,
        viewer: Option<&T::AccountId>,
        stakers: &[(T::AccountId, u128)],
        mut keep: F,
    ) -> FeedPage<T::AccountId>
    where
        F: FnMut(&Post<T>) -> bool,
    {
        let limit = Self::clamp_limit(limit);
        let next_seq = NextTopLevelSeq::<T>::get();
        // Highest candidate seq strictly below the `before` cursor (or the head when `None`).
        let mut seq = match before {
            Some(0) => {
                return FeedPage {
                    posts: Vec::new(),
                    next_cursor: None,
                }
            }
            Some(b) => core::cmp::min(b, next_seq).saturating_sub(1),
            None => match next_seq.checked_sub(1) {
                Some(top) => top,
                None => {
                    return FeedPage {
                        posts: Vec::new(),
                        next_cursor: None,
                    }
                }
            },
        };
        // Feature 3: every seq maps to a top-level post, so the keep-all feed fills `limit` in exactly
        // `limit` iterations (no reply over-scan). A filtered scan (Following) may skip non-matching
        // seqs, so it is still bounded with `MAX_SCAN_FACTOR` + a cursor to continue.
        let max_scan = limit.saturating_mul(MAX_SCAN_FACTOR);
        let mut posts = Vec::new();
        let mut examined: u32 = 0;
        loop {
            // Stopped before the head of the spine — hand back a cursor (the next seq to continue below).
            if posts.len() as u32 >= limit || examined >= max_scan {
                return FeedPage {
                    posts,
                    next_cursor: Some(seq.saturating_add(1)),
                };
            }
            examined = examined.saturating_add(1);
            // Resolve seq → post id → body (a dangling seq, which should not occur, is simply skipped).
            if let Some(id) = TopLevelPosts::<T>::get(seq) {
                if let Some(post) = Posts::<T>::get(id) {
                    if keep(&post) {
                        posts.push(Self::enrich(id, post, viewer, stakers));
                    }
                }
            }
            if seq == 0 {
                // Reached the bottom of the spine — no more pages.
                return FeedPage {
                    posts,
                    next_cursor: None,
                };
            }
            seq = seq.saturating_sub(1);
        }
    }

    /// Global "For-you" feed: top-level posts, newest-first, paged below the `before` cursor (a
    /// `TopLevelPosts` seq). Reads EXACTLY `limit` posts off the top-level spine — no reply over-scan.
    /// `viewer` (when `Some`) stamps `my_vote` per post. (Author profiles are runtime-filled.)
    pub fn feed_page(
        before: Option<u64>,
        limit: u32,
        viewer: Option<T::AccountId>,
    ) -> FeedPage<T::AccountId> {
        let stakers = Self::staker_weights();
        Self::scan_top_level_by_seq(before, limit, viewer.as_ref(), &stakers, |_| true)
    }

    /// One author's top-level posts (the profile Posts tab), newest-first, paged below `before_id` (a
    /// post id). Iterates the author's own reply-free `TopLevelByAuthor` index — exact-N, no over-scan.
    pub fn author_feed_page(
        author: T::AccountId,
        before_id: Option<u64>,
        limit: u32,
        viewer: Option<T::AccountId>,
    ) -> FeedPage<T::AccountId> {
        let limit = Self::clamp_limit(limit);
        let ids = TopLevelByAuthor::<T>::get(&author);
        let viewer_ref = viewer.as_ref();
        let stakers = Self::staker_weights();
        let mut posts = Vec::new();
        let mut next_cursor = None;
        // `TopLevelByAuthor` is append-ordered (ascending id) and reply-free; iterate it newest-first.
        for &id in ids.iter().rev() {
            if let Some(b) = before_id {
                if id >= b {
                    continue;
                }
            }
            if posts.len() as u32 >= limit {
                next_cursor = Some(id.saturating_add(1));
                break;
            }
            if let Some(post) = Posts::<T>::get(id) {
                posts.push(Self::enrich(id, post, viewer_ref, &stakers));
            }
        }
        FeedPage { posts, next_cursor }
    }

    /// The Following timeline: top-level posts authored by accounts the `viewer` follows, newest-first,
    /// paged below the `before` cursor (a `TopLevelPosts` seq). Reads the FULL followee set (parity with
    /// the keyed-read fallback, which reads the whole follow graph — so no followee is ever silently
    /// dropped), then scans the top-level spine filtered to that set (never past replies), bounded with
    /// a cursor to continue.
    pub fn following_feed_page(
        viewer: T::AccountId,
        before: Option<u64>,
        limit: u32,
    ) -> FeedPage<T::AccountId> {
        // The full followee set (bounded by the viewer's own following count, exactly as the
        // fallback's `readFollowees` is) — no cap, so no followee's posts are silently dropped.
        let followees: alloc::collections::BTreeSet<T::AccountId> =
            Following::<T>::iter_key_prefix(&viewer).collect();
        // A viewer who follows nobody has an empty timeline — short-circuit instead of scanning the
        // whole spine to no effect (and handing back a misleading non-None cursor).
        if followees.is_empty() {
            return FeedPage {
                posts: Vec::new(),
                next_cursor: None,
            };
        }
        let stakers = Self::staker_weights();
        Self::scan_top_level_by_seq(before, limit, Some(&viewer), &stakers, |p| {
            followees.contains(&p.author)
        })
    }

    /// A reconstructed thread for `focal`: its ancestor chain (root-first, depth-capped), the focal
    /// post itself, and its direct replies (chronological) — all enriched and viewer-aware.
    pub fn thread(focal: u64, viewer: Option<T::AccountId>) -> Thread<T::AccountId> {
        let viewer_ref = viewer.as_ref();
        let stakers = Self::staker_weights();
        let focal_post = Self::enriched_post(focal, viewer_ref, &stakers);
        // Walk `parent` up from the focal post, then reverse to root-first. `parent` is unvalidated at
        // post creation, so guard against a cyclic / self-referential chain with a visited-set (seeded
        // with the focal id) AND a depth cap — mirroring the client's `getThread` so the two agree.
        let mut ancestors = Vec::new();
        if let Some(fp) = focal_post.as_ref() {
            let mut seen = alloc::collections::BTreeSet::new();
            seen.insert(focal);
            let mut parent = fp.parent;
            let mut depth: u32 = 0;
            while let Some(pid) = parent {
                // Depth cap reached, or `pid` already visited (a cycle) — stop. `insert` returns false
                // when `pid` is already present, which is exactly the revisit case.
                if depth >= MAX_THREAD_DEPTH || !seen.insert(pid) {
                    break;
                }
                depth = depth.saturating_add(1);
                match Self::enriched_post(pid, viewer_ref, &stakers) {
                    Some(ap) => {
                        parent = ap.parent;
                        ancestors.push(ap);
                    }
                    // A dangling parent (target never existed / was a phantom id) — stop the walk.
                    None => break,
                }
            }
            ancestors.reverse();
        }
        // Direct replies via the reverse index, id-sorted (chronological). Collect the ids (cheap), sort,
        // then ENRICH only the oldest `MAX_THREAD_REPLIES` — the per-reply enrichment (~5-8 storage reads
        // each) is the expensive part, so a viral post can't run one `thread` state_call away. The exact
        // `reply_count` on the focal post stays accurate; a whale thread graduates to a paged replies read.
        let mut reply_ids: Vec<u64> = RepliesByParent::<T>::iter_key_prefix(focal).collect();
        reply_ids.sort_unstable();
        let replies: Vec<_> = reply_ids
            .into_iter()
            .take(MAX_THREAD_REPLIES)
            .filter_map(|reply_id| Self::enriched_post(reply_id, viewer_ref, &stakers))
            .collect();
        Thread {
            ancestors,
            focal: focal_post,
            replies,
        }
    }

    /// The author's TOP-LEVEL post count (`TopLevelByAuthor` length) — the correct profile `postCount`
    /// that excludes replies (fixes the count-counts-replies tradeoff). O(1) via `decode_len`.
    pub fn top_level_post_count(author: &T::AccountId) -> u32 {
        TopLevelByAuthor::<T>::decode_len(author).unwrap_or(0) as u32
    }

    /// One author's REPLIES (the profile Replies tab): their posts with `parent != None`, newest-first,
    /// paged below `before_id` (a post id). Scans the author's own `ByAuthor` index (append-ordered,
    /// ascending) in reverse — bounded by the author's own post count, no global scan. Top-level posts in
    /// the index are skipped; the cursor advances only past returned replies.
    pub fn author_replies_page(
        author: T::AccountId,
        before_id: Option<u64>,
        limit: u32,
        viewer: Option<T::AccountId>,
    ) -> FeedPage<T::AccountId> {
        let limit = Self::clamp_limit(limit);
        let ids = ByAuthor::<T>::get(&author);
        let viewer_ref = viewer.as_ref();
        let stakers = Self::staker_weights();
        let mut posts = Vec::new();
        let mut next_cursor = None;
        for &id in ids.iter().rev() {
            if let Some(b) = before_id {
                if id >= b {
                    continue;
                }
            }
            let post = match Posts::<T>::get(id) {
                Some(p) => p,
                None => continue,
            };
            // Replies only — a top-level post is skipped without consuming the page or the cursor.
            if post.parent.is_none() {
                continue;
            }
            if posts.len() as u32 >= limit {
                next_cursor = Some(id.saturating_add(1));
                break;
            }
            posts.push(Self::enrich(id, post, viewer_ref, &stakers));
        }
        FeedPage { posts, next_cursor }
    }

    /// The posts an account has UP-voted (the profile Likes tab), newest-liked-first (descending post id),
    /// paged below `before_id`. Reads the `VotesByAccount` reverse "liked posts" index (down-votes / cleared
    /// votes are not present), materializing the liked-id set to order it newest-first. `O(#likes)` — fine
    /// at POC scale; a large liker graduates to a dedicated index (`docs/SCALE-NODE-READS.md`).
    pub fn likes_page(
        who: T::AccountId,
        before_id: Option<u64>,
        limit: u32,
        viewer: Option<T::AccountId>,
    ) -> FeedPage<T::AccountId> {
        let limit = Self::clamp_limit(limit);
        let mut liked: Vec<u64> = VotesByAccount::<T>::iter_key_prefix(&who).collect();
        liked.sort_unstable_by(|a, b| b.cmp(a)); // newest (highest id) first
        let viewer_ref = viewer.as_ref();
        let stakers = Self::staker_weights();
        let mut posts = Vec::new();
        let mut next_cursor = None;
        for id in liked {
            if let Some(b) = before_id {
                if id >= b {
                    continue;
                }
            }
            if posts.len() as u32 >= limit {
                next_cursor = Some(id.saturating_add(1));
                break;
            }
            if let Some(post) = Posts::<T>::get(id) {
                posts.push(Self::enrich(id, post, viewer_ref, &stakers));
            }
        }
        FeedPage { posts, next_cursor }
    }

    /// Full-text search over post bodies: an ASCII-case-insensitive substring match on `term`, newest-first,
    /// paged below `before_id` (a post id). An in-runtime linear scan — bounded at
    /// `limit · MAX_SCAN_FACTOR` ids per call with a `next_cursor` to continue (no unbounded walk), so a
    /// no-match dense range never runs away. The scan is the known ceiling here; see docs/SCALE-NODE-READS.md.
    pub fn search_posts(
        term: Vec<u8>,
        before_id: Option<u64>,
        limit: u32,
        viewer: Option<T::AccountId>,
    ) -> FeedPage<T::AccountId> {
        let limit = Self::clamp_limit(limit);
        let next_id = NextPostId::<T>::get();
        let mut id = match before_id {
            Some(0) => {
                return FeedPage {
                    posts: Vec::new(),
                    next_cursor: None,
                }
            }
            Some(b) => core::cmp::min(b, next_id).saturating_sub(1),
            None => match next_id.checked_sub(1) {
                Some(top) => top,
                None => {
                    return FeedPage {
                        posts: Vec::new(),
                        next_cursor: None,
                    }
                }
            },
        };
        let max_scan = limit.saturating_mul(MAX_SCAN_FACTOR);
        let viewer_ref = viewer.as_ref();
        let stakers = Self::staker_weights();
        let mut posts = Vec::new();
        let mut examined: u32 = 0;
        loop {
            // Stopped mid-scan (page full or scan cap hit) — hand back a cursor to continue below `id`.
            if posts.len() as u32 >= limit || examined >= max_scan {
                return FeedPage {
                    posts,
                    next_cursor: Some(id.saturating_add(1)),
                };
            }
            examined = examined.saturating_add(1);
            if let Some(post) = Posts::<T>::get(id) {
                if contains_ci(&post.text, &term) {
                    posts.push(Self::enrich(id, post, viewer_ref, &stakers));
                }
            }
            if id == 0 {
                return FeedPage {
                    posts,
                    next_cursor: None,
                };
            }
            id = id.saturating_sub(1);
        }
    }

    /// A poll's options + per-option stake-weighted tally + total current voters, keyed by the host post
    /// id. `None` if `host_id` is not a poll. `total_votes` is the sum of the per-option counts (each
    /// account has exactly one live choice, so this equals the distinct-voter count).
    ///
    /// If the poll is FINALIZED ([`PollResults`] present) the FROZEN per-option weight is returned;
    /// otherwise the weight is derived LIVE from the staker set's current `VotingPower` (a poll past its
    /// `close_at` but not yet finalized reads live — the frontend auto-triggers `close_poll` to freeze it).
    /// The per-option COUNTS are always the exact stored values; the wire shape is unchanged.
    pub fn poll(host_id: u64) -> Option<PollView> {
        let poll = Polls::<T>::get(host_id)?;
        let mut options = Vec::with_capacity(poll.options.len());
        let mut total_votes: u32 = 0;
        // Finalized — return the frozen snapshot (no live join, no staker-set read).
        if let Some(result) = PollResults::<T>::get(host_id) {
            for (i, opt) in poll.options.iter().enumerate() {
                let count = result.option_counts.get(i).copied().unwrap_or(0);
                let weight = result.option_weights.get(i).copied().unwrap_or(0);
                total_votes = total_votes.saturating_add(count);
                options.push(PollOptionView {
                    index: i as u8,
                    label: opt.to_vec(),
                    weight,
                    count,
                });
            }
            return Some(PollView {
                host_id,
                options,
                total_votes,
            });
        }
        // Open (or past-deadline-but-unfinalized) — derive per-option weight live from current stake.
        let num_options = poll.options.len();
        let counts: Vec<u32> = (0..num_options)
            .map(|i| PollTally::<T>::get(host_id, i as u8).count)
            .collect();
        let total: u32 = counts.iter().copied().fold(0, |a, c| a.saturating_add(c));
        total_votes = total;
        // No live votes ⇒ every option weighs 0; skip the O(`|staker_set|`) staker-set join entirely.
        let weights = if total == 0 {
            alloc::vec![0u128; num_options]
        } else {
            Self::poll_option_weights(host_id, num_options, &Self::staker_weights())
        };
        for (i, opt) in poll.options.iter().enumerate() {
            options.push(PollOptionView {
                index: i as u8,
                label: opt.to_vec(),
                weight: weights.get(i).copied().unwrap_or(0),
                count: counts[i],
            });
        }
        Some(PollView {
            host_id,
            options,
            total_votes,
        })
    }

    /// The viewer's own current choice in poll `host_id` (`None` if they have not voted / it is no poll).
    pub fn poll_choice(who: T::AccountId, host_id: u64) -> Option<u8> {
        PollVotes::<T>::get(host_id, &who).map(|r| r.option)
    }

    /// The viewer's own vote over a batch of post ids — the node-side replacement for the client's
    /// per-card `Votes.get`. Bounded at [`MAX_VIEWER_IDS`] ids.
    pub fn viewer_states(who: T::AccountId, ids: Vec<u64>) -> Vec<ViewerState> {
        ids.into_iter()
            .take(MAX_VIEWER_IDS)
            .map(|post_id| ViewerState {
                post_id,
                my_vote: Votes::<T>::get(post_id, &who).map(|r| r.dir),
                // Vestigial since spec 204 — see [`ViewerState`].
                reposted: false,
            })
            .collect()
    }

    /// The follow edges + exact counts for `who`: the O(1) `FollowerCount`/`FollowingCount` aggregates
    /// plus the (truncated at [`MAX_EDGES`]) followee / follower id lists via the reverse indexes.
    pub fn follow_edges(who: T::AccountId) -> FollowEdges<T::AccountId> {
        let following: Vec<T::AccountId> = Following::<T>::iter_key_prefix(&who)
            .take(MAX_EDGES)
            .collect();
        let followers: Vec<T::AccountId> = Followers::<T>::iter_key_prefix(&who)
            .take(MAX_EDGES)
            .collect();
        FollowEdges {
            follower_count: FollowerCount::<T>::get(&who),
            following_count: FollowingCount::<T>::get(&who),
            following,
            followers,
        }
    }
}

sp_api::decl_runtime_apis! {
    /// Node-served reads (the read API landed in spec-120; the top-level index + `author_post_count`
    /// in spec-121): one enriched, viewer-aware feed / thread / profile page per `state_call`, atomic
    /// at a single block. Implemented in `runtime/src/apis.rs`, which also fills each post's author
    /// profile from pallet-profile. See `docs/SCALE-NODE-READS.md`.
    ///
    /// Paging cursors are OPAQUE continuation tokens and ENDPOINT-SCOPED: a `next_cursor` from one
    /// method is only valid passed back to the SAME method. `feed_page` / `following_feed_page` page a
    /// `TopLevelPosts` seq; `author_feed_page` pages a post id — never cross-wire them.
    pub trait MicroblogApi<AccountId>
    where
        AccountId: codec::Codec,
    {
        /// Global "For-you" feed: top-level posts, newest-first, paged below the `before` cursor
        /// (`None` ⇒ from the head). `viewer` (when `Some`) stamps `my_vote` per post.
        fn feed_page(before: Option<u64>, limit: u32, viewer: Option<AccountId>) -> FeedPage<AccountId>;
        /// One author's top-level posts (the profile Posts tab), paged below `before_id` (a post id),
        /// same viewer semantics.
        fn author_feed_page(
            author: AccountId,
            before_id: Option<u64>,
            limit: u32,
            viewer: Option<AccountId>,
        ) -> FeedPage<AccountId>;
        /// The Following timeline: top-level posts by the accounts `viewer` follows, newest-first,
        /// paged below the `before` cursor.
        fn following_feed_page(viewer: AccountId, before: Option<u64>, limit: u32) -> FeedPage<AccountId>;
        /// A reconstructed thread: focal + ancestor chain (depth-capped) + direct replies, enriched.
        fn thread(focal: u64, viewer: Option<AccountId>) -> Thread<AccountId>;
        /// The author's TOP-LEVEL post count (replies excluded) — the correct profile `postCount`.
        fn author_post_count(author: AccountId) -> u32;

        // ── The read paths a separate indexer used to serve, folded into the node ──
        /// One author's REPLIES (the profile Replies tab): `parent != None`, newest-first, paged below
        /// `before_id` (a post id).
        fn author_replies_page(
            author: AccountId,
            before_id: Option<u64>,
            limit: u32,
            viewer: Option<AccountId>,
        ) -> FeedPage<AccountId>;
        /// The posts `who` has UP-voted (the profile Likes tab), newest-liked-first, paged below `before_id`.
        fn likes_page(
            who: AccountId,
            before_id: Option<u64>,
            limit: u32,
            viewer: Option<AccountId>,
        ) -> FeedPage<AccountId>;
        /// Full-text search over post bodies (ASCII-case-insensitive substring on `term`), newest-first,
        /// paged below `before_id` — the Option-1 in-runtime linear scan.
        fn search_posts(
            term: Vec<u8>,
            before_id: Option<u64>,
            limit: u32,
            viewer: Option<AccountId>,
        ) -> FeedPage<AccountId>;
        /// A poll's options + per-option tally + total voters, by host post id (`None` if not a poll).
        fn poll(host_id: u64) -> Option<PollView>;
        /// The viewer's own current choice in a poll (`None` if not voted / no poll).
        fn poll_choice(who: AccountId, host_id: u64) -> Option<u8>;
        /// The viewer's own vote over a batch of post ids.
        fn viewer_states(who: AccountId, ids: Vec<u64>) -> Vec<ViewerState>;
        /// The follow edges + exact counts for one account.
        fn follow_edges(who: AccountId) -> FollowEdges<AccountId>;
        /// A full profile view (cross-pallet: profile + talk-stake + cogno-gate + microblog counters).
        fn profile(who: AccountId) -> ProfileView<AccountId>;
        /// Resolve a 32-byte Cardano identity hash to the account it is bound to (cogno-gate `AccountOf`).
        fn resolve_identity(identity_hash: [u8; 32]) -> Option<AccountId>;
        /// Search people by display-name substring (case-insensitive), ranked by follower count.
        fn search_people(term: Vec<u8>, limit: u32) -> Vec<PersonSummary<AccountId>>;
        /// Ranked who-to-follow suggestions: bound authors with ≥1 top-level post, by follower count.
        fn who_to_follow(limit: u32) -> Vec<PersonSummary<AccountId>>;
    }
}
