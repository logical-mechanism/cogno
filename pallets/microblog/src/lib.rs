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
///
/// `who` is the SIGNER the extension resolved (spec 211), so an impl may price a call per-account —
/// e.g. a tidy-up call (`clear_profile`) at 0 when the caller actually has state to clear, and at an
/// unpayable sentinel when it does not (rejecting the no-op at the pool instead of admitting it
/// free). An impl MAY read storage: `CheckCapacity::validate` already reads state, and it re-runs
/// deterministically at inclusion.
pub trait ForeignCapacityCost<AccountId, RuntimeCall> {
    /// The talk-capacity cost of `call` for signer `who`, or `None` if this source does not price it.
    fn cost(who: &AccountId, call: &RuntimeCall) -> Option<u128>;
}

/// The price of a call that can NEVER succeed for this signer, no matter how long they wait — a
/// tidy-up call with nothing to tidy (`clear_profile` with no profile row, `unpin_post` with no pin).
///
/// It is a distinct SENTINEL rather than "some number above the ceiling" because
/// [`CheckCapacity::validate`] branches on it: an unpayable call is rejected at the pool as
/// [`InvalidTransaction::Call`] — malformed, do not retry — exactly like the over-length post body,
/// and NOT as `ExhaustsResources`, which is the retriable "your battery is low" code. Getting that
/// wrong is user-visible: `ExhaustsResources` is what the client classifies as a rate limit, so a
/// permanently-doomed no-op would tell the user they are "posting too fast" and invite a retry that
/// can never work.
pub const UNPAYABLE: u128 = u128::MAX;

/// Default: meter nothing foreign. A runtime with no extra feeless pallets wires `type ForeignCost = ()`.
impl<AccountId, RuntimeCall> ForeignCapacityCost<AccountId, RuntimeCall> for () {
    fn cost(_who: &AccountId, _call: &RuntimeCall) -> Option<u128> {
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

/// The observed-role provider for GOVERNANCE-POLL chambers (spec 207). Given an account, returns its
/// observed roles as `(kind_index, display_id, chamber_weight)` — the same triples the cardano-observer
/// writes to pallet-cardano-roles' `ObservedRoles`. The runtime wires this to read that map; `()` yields
/// no roles (a dev/mock default with no observer). Carries no Cargo dependency on cardano-roles —
/// microblog is the depended-upon crate — the same no-cycle seam as [`StakerSet`] / [`IsAllowed`].
pub trait ChamberRoles<AccountId> {
    /// `who`'s observed roles: `(kind_index, display_id, chamber_weight)`. `kind_index` is 0 = SPO,
    /// 1 = dRep, 2 = CC (mirrors `RoleKind::index`); `chamber_weight` is the role's delegated Cardano
    /// stake (0 for an undelegated pool/dRep, or a CC). Empty if the account holds no live role. Read for a
    /// `PollKind::Governance` poll's chamber tally — both live (a node-served read) and, since spec 208,
    /// on-chain when `close_poll` FREEZES the chambers.
    fn roles_of(who: &AccountId) -> Vec<(u8, [u8; 28], u128)>;

    /// The set of accounts that currently hold ANY observed role (spec 208). Bounded by the observer's
    /// `MaxObserved`, exactly like [`StakerSet::stakers`] — so the chamber tally can iterate this bounded
    /// set (point-looking-up each holder's vote) instead of the UNBOUNDED voter set, making it safe to
    /// compute on-chain in `close_poll`. A holder who did not vote contributes nothing. `()` yields none.
    fn role_holders() -> Vec<AccountId>;
}

/// Default: no roles (a chain with no observer). Every chamber tally is then empty.
impl<AccountId> ChamberRoles<AccountId> for () {
    fn roles_of(_who: &AccountId) -> Vec<(u8, [u8; 28], u128)> {
        Vec::new()
    }
    fn role_holders() -> Vec<AccountId> {
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
    // v6 -> v7 (spec 207): add `Poll.kind` (Stake | Governance) — see `migrations::v7`.
    // v7 -> v8 (spec 208): append the frozen SPO/dRep CHAMBER snapshot to `PollResult`, so `close_poll`
    // freezes a governance poll's chambers instead of leaving them to re-price live — see `migrations::v8`.
    // v8 -> v9 (spec 209): append `Poll.action`, the optional governance-action tag — see `migrations::v9`.
    // v9 -> v10 (spec 212): REPAGE the two per-author indexes. `ByAuthor` / `TopLevelByAuthor` were
    // `BoundedVec<u64, MaxPostsPerAuthor>` blobs; they become seq-keyed double maps beside explicit
    // counters, so appending a post costs O(1) instead of decoding and re-encoding the author's whole
    // history — see `migrations::v10`.
    const STORAGE_VERSION: StorageVersion = StorageVersion::new(10);

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
        // `MaxPostsPerAuthor` lived HERE. It was REMOVED in spec 212 together with the bounded-vec
        // shape of `ByAuthor` / `TopLevelByAuthor`. It bounded a per-author BLOB, so it was doing two
        // jobs badly: at the cap an author was BRICKED (`post_message`, `quote_post` and `create_poll`
        // all reverted `TooManyPosts` forever, with no `delete_post` and no pruning to recover), and
        // below the cap every append decoded and re-encoded the whole vector — a cost the benchmarked
        // `post_message` weight, measured against an EMPTY index, never charged for. The seq-keyed
        // double maps need no bound: the per-post cost is O(1) at any history length, so there is
        // nothing left for a cap to protect.

        // ── talk-capacity constants (see docs/ECONOMICS.md; all runtime-tunable, read from metadata
        //    by the client capacity battery — never hardcode there) ─────────────────────────
        /// Capacity ceiling per unit weight: `cap = min(weight · CapRatio, Ceiling)`
        /// (micro-capacity units per lovelace).
        #[pallet::constant]
        type CapRatio: Get<u128>;
        /// Regeneration per unit weight per block, BELOW the ceiling knee. Above it the rate flattens
        /// with the bucket: the real rate is `capacity_ceiling(weight) · RegenPerBlock / CapRatio`
        /// (see [`Pallet::regen_per_block`]), which equals `weight · RegenPerBlock` exactly while
        /// `weight · CapRatio < Ceiling`. Together with `CapRatio` this sets the one thing every
        /// account shares regardless of stake: the empty→full refill window, `CapRatio /
        /// RegenPerBlock` blocks.
        #[pallet::constant]
        type RegenPerBlock: Get<u128>;
        /// Hard capacity ceiling (the capped-linear curve) — a single mega-whale cannot
        /// dominate the mempool regardless of stake. It caps BOTH axes since spec 212: the bucket
        /// directly, and the refill rate through [`Pallet::regen_per_block`], which derives from it.
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
        /// Maximum length, in bytes, of a governance poll's anchor URL — the link to the off-chain
        /// proposal document (spec 209). (`create_poll` rejects a longer or empty anchor.)
        #[pallet::constant]
        type MaxAnchorUrlLen: Get<u32>;
        /// Minimum poll duration in blocks (spec 211): `create_poll` requires
        /// `close_at >= now + MinPollDuration`, so a poll can neither be born closed nor close
        /// before anyone can vote.
        #[pallet::constant]
        type MinPollDuration: Get<BlockNumberFor<Self>>;
        /// Maximum poll duration in blocks (spec 211): `create_poll` requires
        /// `close_at <= now + MaxPollDuration`. Together with the rejected-`None` rule this bounds
        /// how long any poll's weighted result can keep re-pricing before it is freezable.
        #[pallet::constant]
        type MaxPollDuration: Get<BlockNumberFor<Self>>;

        /// Origin allowed to force a capacity row (operator/migration). Wired to the 3-of-5
        /// committee in the runtime; there is no sudo. `cogno-gate`'s bind calls
        /// [`Pallet::on_first_bind`] directly, so this is only an operator override.
        type ForceOrigin: EnsureOrigin<Self::RuntimeOrigin>;

        /// Prices feeless calls from OTHER pallets (e.g. `pallet-profile`) against this pallet's one
        /// per-account capacity battery, so the whole app can be feeless while every write is still
        /// pool-gated by [`CheckCapacity`]. The runtime supplies it (it can see every pallet's `Call`);
        /// `()` meters nothing foreign. See [`ForeignCapacityCost`].
        type ForeignCost: ForeignCapacityCost<
            Self::AccountId,
            <Self as frame_system::Config>::RuntimeCall,
        >;

        /// The bounded set of accounts with observed Cardano stake — the basis of the LIVE weighted-tally
        /// join (post votes, account reputation, polls). The runtime wires it to
        /// `pallet_cardano_observer::LastObservedStake`; `()` is the empty dev/mock default. See
        /// [`StakerSet`] and `docs/DYNAMIC-STAKE-VOTING-PLAN.md`.
        type StakerSet: StakerSet<Self::AccountId>;

        /// The observed-role provider for GOVERNANCE-POLL chambers (spec 207): `who → (kind, id, weight)`.
        /// The runtime wires it to pallet-cardano-roles' `ObservedRoles`; `()` is the empty dev/mock
        /// default (no chambers). Read off-chain for a `PollKind::Governance` poll, and on-chain when
        /// `close_poll` freezes the chambers (spec 208). See [`ChamberRoles`] and
        /// `docs/VERIFIABLE-ROLE-TAGS.md`.
        type ChamberRoles: ChamberRoles<Self::AccountId>;

        /// Upper bound on the observed STAKER set ([`StakerSet::stakers`]) AND the observed ROLE-HOLDER set
        /// ([`ChamberRoles::role_holders`]) — both bounded by the observer's `MaxObserved` (the runtime
        /// wires this to it; a mock supplies a small constant). ONLY used to size `close_poll`'s worst-case
        /// weight for its two O(observed-set) joins; the call then REFUNDS down to the rows it actually
        /// processed, so a real close is priced at its true cost. Not `#[pallet::constant]` (weight-only,
        /// no metadata).
        type MaxObservedAccounts: Get<u32>;

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

    /// The direction of a stake-weighted vote on a post. `#[codec(index)]` PINS the on-wire
    /// discriminant (this enum rides in call args, two pinned events, the `VoteRecord` storage value
    /// and the `my_vote` read DTOs) — pinned at its pre-pin ordinals, so the encoding is
    /// byte-identical. Never renumber; append only.
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
        #[codec(index = 0)]
        Up,
        /// A down-vote.
        #[codec(index = 1)]
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

    /// What lenses a poll is tallied through (spec 207 / storage v7). `#[codec(index)]` PINS the on-wire
    /// discriminant (it rides in `Poll` storage + the `create_poll` arg) — append only.
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
    pub enum PollKind {
        /// A regular stake poll: everyone votes, weighted by their own Cardano `VotingPower` (the existing
        /// behaviour). This is the default, and the shape every pre-v7 poll migrates to.
        #[codec(index = 0)]
        Stake,
        /// A governance poll (a Cardano-community "temperature check"): the same single vote is ALSO tallied
        /// through the SPO chamber (weighted by each voting owner's pool's delegated stake) and the dRep
        /// chamber (weighted by each voting dRep's delegated voting stake). The three lenses are reported
        /// separately (never summed), so there is no double-counting. DISPLAY-ONLY — a chamber tally decides
        /// nothing on-chain; it is a verifiable, non-binding signal.
        #[codec(index = 1)]
        Governance,
        /// SPO chamber ONLY (spec 209): the same single vote is tallied only through the SPO chamber
        /// (delegated pool stake), with no dRep lens. For SPO-specific signals. DISPLAY-ONLY, like
        /// `Governance`.
        #[codec(index = 2)]
        Spo,
        /// dRep chamber ONLY (spec 209): the same single vote is tallied only through the dRep chamber
        /// (delegated voting stake), with no SPO lens. Maps to the dRep-decided Cardano actions (treasury
        /// withdrawal, new constitution, non-security parameter changes). DISPLAY-ONLY, like `Governance`.
        #[codec(index = 3)]
        Drep,
    }

    impl PollKind {
        /// Whether this poll surfaces the SPO chamber (delegated pool stake).
        pub fn has_spo(&self) -> bool {
            matches!(self, PollKind::Governance | PollKind::Spo)
        }
        /// Whether this poll surfaces the dRep chamber (delegated voting stake).
        pub fn has_drep(&self) -> bool {
            matches!(self, PollKind::Governance | PollKind::Drep)
        }
        /// Whether this poll surfaces ANY governance chamber (⇒ the bounded role-holder join runs at read
        /// time and `close_poll` freezes a chamber snapshot). A `Stake` poll has none.
        pub fn has_chambers(&self) -> bool {
            self.has_spo() || self.has_drep()
        }
    }

    /// The seven CIP-1694 on-chain governance ACTION TYPES (spec 209). Tagging a chamber poll with one marks
    /// it as a pre-submission "temperature check" on that kind of Cardano governance action — a cheap,
    /// editable, off-chain signal from the SPO + dRep bodies that will later vote on-chain, taken BEFORE
    /// anyone locks the 100_000-ADA (refundable) deposit into an immutable on-chain action. DISPLAY/context
    /// only: WHICH chambers actually tally is the poll's [`PollKind`], not this. `#[codec(index)]` PINS the
    /// on-wire discriminant (it rides in `Poll` storage + the `create_poll` arg) — append only.
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
    pub enum GovActionType {
        /// Info action — records an opinion on-chain, never enacts. The closest on-chain analogue to this
        /// whole feature (a non-binding tripartite temperature check).
        #[codec(index = 0)]
        Info,
        /// Motion of no-confidence in the Constitutional Committee.
        #[codec(index = 1)]
        NoConfidence,
        /// Update/replace the Constitutional Committee or change its threshold/terms.
        #[codec(index = 2)]
        UpdateCommittee,
        /// Amend the Constitution text or its guardrails script.
        #[codec(index = 3)]
        NewConstitution,
        /// Hard-fork initiation (a non-backwards-compatible major protocol-version bump).
        #[codec(index = 4)]
        HardFork,
        /// Protocol-parameter change. (Whether it is security-relevant — and so whether SPOs also vote on
        /// Cardano — is authoring guidance reflected in the chosen [`PollKind`], not stored here.)
        #[codec(index = 5)]
        ParamChange,
        /// Treasury withdrawal (moves ADA out of the on-chain treasury).
        #[codec(index = 6)]
        TreasuryWithdrawal,
    }

    /// A chamber poll's optional governance-action tag (spec 209): the CIP-1694 action TYPE plus an ANCHOR —
    /// a link to the OFF-CHAIN proposal document (its home stays GitHub/IPFS, exactly like a real Cardano
    /// action's anchor) and an optional blake2b-256 hash of that document for integrity. Present only on a
    /// chamber poll (`PollKind` ∈ {Governance, Spo, Drep}); a `Stake` poll never carries one. Cogno stores
    /// the LINK, never the proposal body.
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
    pub struct GovAction<T: Config> {
        /// Which CIP-1694 action type this poll pre-checks.
        pub action_type: GovActionType,
        /// A link to the off-chain proposal document (≤ [`Config::MaxAnchorUrlLen`] bytes).
        pub anchor_url: BoundedVec<u8, T::MaxAnchorUrlLen>,
        /// Optional blake2b-256 hash of the document at `anchor_url` (integrity; mirrors a real Cardano
        /// anchor's `dataHash`).
        pub anchor_hash: Option<[u8; 32]>,
    }

    /// The `create_poll` call-argument form of [`GovAction`]: an UNBOUNDED `anchor_url` (bounded on store,
    /// mirroring how `question` / `options` arrive unbounded). `None` ⇒ a plain stake/chamber poll with no
    /// governance-action tag.
    #[derive(Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo)]
    pub struct GovActionInput {
        /// Which CIP-1694 action type this poll pre-checks.
        pub action_type: GovActionType,
        /// A link to the off-chain proposal document; bounded to [`Config::MaxAnchorUrlLen`] on store.
        pub anchor_url: Vec<u8>,
        /// Optional blake2b-256 hash of the document at `anchor_url`.
        pub anchor_hash: Option<[u8; 32]>,
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
        /// The poll's lens (spec 207 / storage v7, extended spec 209): `Stake` (regular), `Governance`
        /// (both SPO + dRep chambers), `Spo` (SPO chamber only) or `Drep` (dRep chamber only). Chambers are
        /// derived at read time. Pre-v7 polls migrate to `Stake`.
        pub kind: PollKind,
        /// Optional governance-action tag (spec 209 / storage v9): marks a chamber poll as a pre-submission
        /// temperature check on a specific CIP-1694 action, carrying its type + a link to the off-chain
        /// proposal. `None` for a plain poll (and always `None` for a `Stake` poll). Pre-v9 polls migrate to
        /// `None`.
        pub action: Option<GovAction<T>>,
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

    /// The FROZEN weighted result of a closed poll (spec 205 / storage v6, extended spec 208 / v8).
    /// Written once by the permissionless `close_poll` at or after the poll's `close_at`: the exact
    /// per-option HOLDER weight (summed from `VotingPower` over the staker set at the execution block) and
    /// count, plus (spec 208, governance polls only) the frozen SPO + dRep CHAMBER snapshot. Present in
    /// [`PollResults`] ⇒ the poll is finalized and reads return THIS instead of a live join, so neither an
    /// unstake (holder lens) nor a later delegation move (chambers) can retroactively re-price a
    /// socially-concluded poll.
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
        /// Frozen HOLDER-lens per-option weight (index-aligned with `Poll.options`).
        pub option_weights: BoundedVec<u128, T::MaxPollOptions>,
        /// Frozen per-option count (index-aligned with `Poll.options`).
        pub option_counts: BoundedVec<u32, T::MaxPollOptions>,
        /// Frozen SPO-chamber per-option weight (spec 208). EMPTY for a `PollKind::Stake` poll ⇒ read as 0.
        pub option_spo_weights: BoundedVec<u128, T::MaxPollOptions>,
        /// Frozen SPO-chamber per-option distinct-pool count (spec 208). Empty for a stake poll.
        pub option_spo_counts: BoundedVec<u32, T::MaxPollOptions>,
        /// Frozen dRep-chamber per-option weight (spec 208). Empty for a stake poll.
        pub option_drep_weights: BoundedVec<u128, T::MaxPollOptions>,
        /// Frozen dRep-chamber per-option distinct-dRep count (spec 208). Empty for a stake poll.
        pub option_drep_counts: BoundedVec<u32, T::MaxPollOptions>,
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

    /// Per-author index of post ids (ALL of them — plain posts, replies, quotes and poll hosts):
    /// `ByAuthor[author][seq] = post_id`, with `seq` dense over `0 .. ByAuthorCount[author]`.
    ///
    /// Repaged from a `BoundedVec<u64, MaxPostsPerAuthor>` in spec 212 (storage v10). The blob shape
    /// made every append O(history): `try_push` decoded the author's entire vector, pushed, and
    /// re-encoded it — up to ~80 KB, which is exactly what the `post_message` benchmark's
    /// `max_size: Some(80050)` proof term describes and exactly what its measured `ref_time` did NOT,
    /// because the benchmark ran against an empty index. Keyed by `(author, seq)` the append is one
    /// counter read plus two writes at ANY history length, which is what makes the existing weight
    /// true rather than optimistic.
    ///
    /// ⚑ Read it by SEQ, never by prefix iteration. `seq` is assigned in append order and post ids are
    /// strictly ascending, so walking `seq` down from `ByAuthorCount - 1` yields ids newest-first with
    /// no sort — whereas a double map's prefix iteration is HASH-ordered and would need the whole
    /// author's history materialized and sorted (what `thread` has to do for `RepliesByParent`).
    #[pallet::storage]
    pub type ByAuthor<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Blake2_128Concat,
        u64,
        u64,
        OptionQuery,
    >;

    /// The number of ids in [`ByAuthor`] for an author — and, since the index is append-only, the next
    /// free `seq`. `ValueQuery` ⇒ 0 for an author who has never posted, so a row exists if and only if
    /// the author has at least one post (the membership predicate `who_to_follow` ranks over).
    ///
    /// REQUIRED, not a convenience: the bounded-vec shape gave `decode_len` an O(1) length for free,
    /// and the double map has no equivalent.
    #[pallet::storage]
    pub type ByAuthorCount<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u64, ValueQuery>;

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

    /// Per-author TOP-LEVEL post ids (reply-free): `TopLevelByAuthor[author][seq] = post_id`, seq dense
    /// over `0 .. TopLevelByAuthorCount[author]`. Drives exact-N profile paging without folding in the
    /// author's replies. Same shape, same reason and same seq-descending read rule as [`ByAuthor`]
    /// (repaged in spec 212 / storage v10).
    #[pallet::storage]
    pub type TopLevelByAuthor<T: Config> = StorageDoubleMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        Blake2_128Concat,
        u64,
        u64,
        OptionQuery,
    >;

    /// The author's TOP-LEVEL post count — the correct profile `postCount` (replies excluded), read
    /// O(1) by [`Pallet::top_level_post_count`]. Replaces the `decode_len` the bounded vec gave for
    /// free. `ValueQuery` ⇒ 0 for an author with no top-level posts.
    #[pallet::storage]
    pub type TopLevelByAuthorCount<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, u64, ValueQuery>;

    // Variant indices are PINNED with `#[codec(index)]`, never implied by declaration order. `Reposted`
    // (6) was retired in spec 204 and its index is permanently VACANT; without the pins, deleting it
    // would have shifted `Followed`/`Unfollowed`/`PollCreated`/`PollVoted` down one and silently
    // mis-decoded them in every client. Never renumber; a new variant takes the next free index (12 —
    // `PollClosed` took 11 in spec 205).
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
        // index 2 is PERMANENTLY VACANT: `TooManyPosts` (retired in spec 212 with `MaxPostsPerAuthor`
        // and the bounded-vec per-author index — the seq-keyed double maps have no cap, so nothing
        // can raise it any more). Never reuse it.
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
        /// `create_poll` attached a governance action to a non-chamber (`Stake`) poll — a gov-action tag
        /// only makes sense on a chamber poll (`Governance` / `Spo` / `Drep`). Added spec 209 (18).
        #[codec(index = 18)]
        GovActionRequiresChamber,
        /// `create_poll`'s governance-action `anchor_url` was empty or exceeded `MaxAnchorUrlLen`. Added
        /// spec 209 (19).
        #[codec(index = 19)]
        InvalidAnchor,
        /// `create_poll` was called without a close deadline. Every new poll needs one, or its
        /// weighted result re-prices forever and can never be frozen. Added spec 211 (20).
        #[codec(index = 20)]
        PollCloseRequired,
        /// `create_poll`'s `close_at` is sooner than `MinPollDuration` from now (or already in the
        /// past). Added spec 211 (21).
        #[codec(index = 21)]
        PollDurationTooShort,
        /// `create_poll`'s `close_at` is further than `MaxPollDuration` from now. Added spec 211 (22).
        #[codec(index = 22)]
        PollDurationTooLong,
    }

    impl<T: Config> Pallet<T> {
        /// The stake-backed capacity ceiling for a stake `weight`: `min(weight·CapRatio, Ceiling)`
        /// (capped-linear). The SINGLE source of truth for the ceiling — both the live meter
        /// ([`Pallet::current_capacity`]) and the `force_set_capacity` clamp call this, so the
        /// "voice == locked ADA" invariant can never drift between the two.
        pub fn capacity_ceiling(weight: u128) -> u128 {
            core::cmp::min(weight.saturating_mul(T::CapRatio::get()), T::Ceiling::get())
        }

        /// The per-block refill rate for a stake `weight`: the account's own bucket ceiling divided by
        /// the fixed refill window `CapRatio / RegenPerBlock`. **The single source of truth for the
        /// rate**, the way [`Pallet::capacity_ceiling`] is for the bucket.
        ///
        /// DERIVING IT FROM THE CEILING IS THE POINT (spec 212). Before this, the rate was a bare
        /// `weight · RegenPerBlock` — clamped nowhere. Only the BUCKET was capped-linear, so above the
        /// bucket knee (`Ceiling / CapRatio`) the burst flattened while the sustained rate kept growing
        /// linearly forever, with its own knee `Ceiling / RegenPerBlock` sitting a whole refill window
        /// further out. Sustained throughput is the thing that actually competes for block space, so
        /// the "capped-linear, flattened at the top so no single whale can dominate the mempool"
        /// property held only on the axis that mattered less. Now both axes share ONE knee.
        ///
        /// The invariant this buys, and the one to preserve: **stake sets how BIG your bucket is, never
        /// how FAST it fills.** Every account, at every weight, refills empty→full in exactly
        /// `CapRatio / RegenPerBlock` blocks.
        ///
        /// EXACT below the knee: `capacity_ceiling` is `weight · CapRatio` there, so the division by
        /// `CapRatio` cancels and this is `weight · RegenPerBlock` to the unit — no rounding, and no
        /// behaviour change for any account under the ceiling. `checked_div` guards a `CapRatio` of 0
        /// (which also makes the ceiling 0, so 0 is the right answer).
        pub fn regen_per_block(weight: u128) -> u128 {
            Self::capacity_ceiling(weight)
                .saturating_mul(T::RegenPerBlock::get())
                .checked_div(T::CapRatio::get())
                .unwrap_or(0)
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
                    let regen = Self::regen_per_block(weight).saturating_mul(elapsed);
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
                let regen = Self::regen_per_block(old_weight).saturating_mul(elapsed);
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

        /// Append `id` to `author`'s full post index ([`ByAuthor`] + [`ByAuthorCount`]). Called from
        /// every creation site (`post_message`/`quote_post`/`create_poll`), replies included.
        ///
        /// INFALLIBLE and O(1) since spec 212 — one counter read, one row write, one counter write, at
        /// any history length. It used to be a `BoundedVec::try_push` that could return `TooManyPosts`
        /// forever once an author hit `MaxPostsPerAuthor`, permanently bricking that account's ability
        /// to post, quote or poll.
        pub fn index_by_author(id: u64, author: &T::AccountId) {
            let seq = ByAuthorCount::<T>::get(author);
            ByAuthor::<T>::insert(author, seq, id);
            ByAuthorCount::<T>::insert(author, seq.saturating_add(1));
        }

        /// Index a newly-created TOP-LEVEL post (`parent == None`) into the Feature 3 spine — the global
        /// `TopLevelPosts` sequence and the per-author `TopLevelByAuthor` index. Called from every
        /// top-level creation site (`post_message`/`quote_post`/`create_poll`).
        ///
        /// Infallible and O(1) since spec 212, for the same reason as [`Pallet::index_by_author`].
        pub fn index_top_level(id: u64, author: &T::AccountId) {
            let author_seq = TopLevelByAuthorCount::<T>::get(author);
            TopLevelByAuthor::<T>::insert(author, author_seq, id);
            TopLevelByAuthorCount::<T>::insert(author, author_seq.saturating_add(1));
            let seq = NextTopLevelSeq::<T>::get();
            TopLevelPosts::<T>::insert(seq, id);
            NextTopLevelSeq::<T>::put(seq.saturating_add(1));
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
        /// inclusion. Fails `TooLong` if `text` exceeds `MaxLength`. (It could also fail
        /// `TooManyPosts` until spec 212, when the per-author index stopped having a cap.)
        #[pallet::call_index(0)]
        // WEIGHT: the benchmark measures this call whole — no manual addend.
        //
        // It used to carry `+reads_writes(2, 5)`, because the weights were last measured before the
        // spec-212 repage and their storage list still described the old `ByAuthor` blob. Re-running
        // the benchmark against the repaged storage made that term a DOUBLE COUNT: the measured list
        // is now PkhOf (r), NextPostId (r+w), ByAuthorCount (r+w), TopLevelByAuthorCount (r+w),
        // NextTopLevelSeq (r+w), TopLevelByAuthor (w), TopLevelPosts (w), Posts (w), ByAuthor (w) =
        // 5 reads + 8 writes, i.e. `index_by_author` AND `index_top_level` are both already in it.
        //
        // The benchmark exercises the TOP-LEVEL branch, which is the worst case: a top-level post runs
        // `index_top_level` (2 reads + 4 writes) where a reply runs `ReplyCount` (r+w) +
        // `RepliesByParent` (w) (1 read + 2 writes). So a reply overpays slightly and nothing
        // under-declares — the safe direction, and now by measurement rather than by hand.
        #[pallet::weight(<T as Config>::WeightInfo::post_message(text.len() as u32))]
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
            Self::index_by_author(id, &who);

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
                Self::index_top_level(id, &who);
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
        // WEIGHT: measured whole, no manual addend — same story as `post_message` above. A quote is
        // always top-level, and the re-run benchmark's storage list already includes both
        // `index_by_author` and `index_top_level`: PkhOf (r), Posts (r+w, the quoted post read plus the
        // new one), NextPostId (r+w), ByAuthorCount (r+w), TopLevelByAuthorCount (r+w), NextTopLevelSeq
        // (r+w), TopLevelByAuthor (w), TopLevelPosts (w), ByAuthor (w) = 6 reads + 8 writes.
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
            Self::index_by_author(id, &who);

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
            Self::index_top_level(id, &who);
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
        /// are stored alongside. `close_at` is a block-number deadline, REQUIRED since spec 211 and
        /// validated into the `[now + MinPollDuration, now + MaxPollDuration]` window: voting is
        /// rejected once `now ≥ close_at` and the weighted result can then be FROZEN by `close_poll`.
        /// (The argument stays `Option` so this validation alone does not move `transaction_version`;
        /// `None` — which used to mean "floats forever, re-prices on every read, can never be
        /// finalized" — is now rejected with `PollCloseRequired`. A pre-211 `None` poll already in
        /// storage keeps its legacy behaviour.) Feeless + capacity-metered like a post.
        ///
        /// ⚠ The `close_at` argument (added spec 205) moved `transaction_version` 3 → 4; the `kind`
        /// argument (added spec 207, for governance polls) moved it 4 → 5; the `action` argument (added
        /// spec 209, the optional governance-action tag) moves it 5 → 6. Each is a `create_poll` call-arg
        /// change — the only one in its respective upgrade.
        #[pallet::call_index(9)]
        // WEIGHT: measured whole, no manual addend — same story as `post_message` above. A poll host is
        // always top-level, and the re-run benchmark's storage list already includes both
        // `index_by_author` and `index_top_level`, plus the `Polls` row: PkhOf (r), NextPostId (r+w),
        // ByAuthorCount (r+w), TopLevelByAuthorCount (r+w), NextTopLevelSeq (r+w), TopLevelByAuthor (w),
        // TopLevelPosts (w), Posts (w), Polls (w), ByAuthor (w) = 5 reads + 9 writes.
        #[pallet::weight(<T as Config>::WeightInfo::create_poll(question.len() as u32))]
        #[pallet::feeless_if(|_origin: &OriginFor<T>, _question: &Vec<u8>, _options: &Vec<Vec<u8>>, _close_at: &Option<BlockNumberFor<T>>, _kind: &PollKind, _action: &Option<GovActionInput>| -> bool { true })]
        pub fn create_poll(
            origin: OriginFor<T>,
            question: Vec<u8>,
            options: Vec<Vec<u8>>,
            close_at: Option<BlockNumberFor<T>>,
            kind: PollKind,
            action: Option<GovActionInput>,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;
            if !T::IdentityGate::is_allowed(&who) {
                log::debug!(target: LOG_TARGET, "create_poll rejected: identity not allowed for {who:?}");
                return Err(Error::<T>::NotAllowed.into());
            }
            // A deadline is REQUIRED and window-validated (spec 211). Without it the poll could
            // never be finalized, so its displayed outcome would keep re-pricing forever as stake
            // moves — and the shipped UI produced exactly that poll by default. The bounds also
            // reject a poll born closed (`close_at <= now`).
            let now = frame_system::Pallet::<T>::block_number();
            let deadline = close_at.ok_or(Error::<T>::PollCloseRequired)?;
            ensure!(
                deadline >= now.saturating_add(T::MinPollDuration::get()),
                Error::<T>::PollDurationTooShort
            );
            ensure!(
                deadline <= now.saturating_add(T::MaxPollDuration::get()),
                Error::<T>::PollDurationTooLong
            );
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

            // Governance-action tag (spec 209): only valid on a CHAMBER poll (a `Stake` poll has no body to
            // signal to), and its anchor URL must be present and within bound. Cogno stores the LINK to the
            // off-chain proposal, never the proposal body.
            let action = match action {
                None => None,
                Some(input) => {
                    ensure!(kind.has_chambers(), Error::<T>::GovActionRequiresChamber);
                    ensure!(!input.anchor_url.is_empty(), Error::<T>::InvalidAnchor);
                    let anchor_url: BoundedVec<u8, T::MaxAnchorUrlLen> = input
                        .anchor_url
                        .try_into()
                        .map_err(|_| Error::<T>::InvalidAnchor)?;
                    Some(GovAction {
                        action_type: input.action_type,
                        anchor_url,
                        anchor_hash: input.anchor_hash,
                    })
                }
            };

            let id = NextPostId::<T>::get();
            Self::index_by_author(id, &who);
            let at = now;
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
                    kind,
                    action,
                },
            );
            // A poll's host post is top-level — index it for exact-N feed/profile paging (Feature 3).
            Self::index_top_level(id, &who);
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
        /// It computes the EXACT per-option HOLDER tally from the staker set's CURRENT `VotingPower`, and
        /// (spec 208, governance polls) the SPO + dRep CHAMBER snapshot from the observed role-holder set,
        /// and writes them to [`PollResults`], after which reads return the frozen result instead of a live
        /// join — so neither an unstake (holder lens) nor a later delegation move (chambers) can
        /// retroactively re-price a socially-concluded poll. Feeless + capacity-metered (priced at
        /// `VoteCost`).
        ///
        /// WEIGHT (§2.1): the two joins are each O(observed-set) — bounded by
        /// [`Config::MaxObservedAccounts`] (the observer's `MaxObserved`). The `#[pallet::weight]` declares
        /// the WORST case (both sets full: `close_poll()` + `6 × MaxObservedAccounts` reads); the body then
        /// REFUNDS via `PostDispatchInfo` down to `≤3` reads per account it actually scanned, so a real
        /// close (a handful of stakers/role-holders) is priced at its true cost and a burst can't overrun a
        /// block on an under-declared weight.
        #[pallet::call_index(13)]
        #[pallet::weight(<T as Config>::WeightInfo::close_poll().saturating_add(
            T::DbWeight::get().reads((T::MaxObservedAccounts::get() as u64).saturating_mul(6))
        ))]
        #[pallet::feeless_if(|_origin: &OriginFor<T>, _host_id: &u64| -> bool { true })]
        pub fn close_poll(origin: OriginFor<T>, host_id: u64) -> DispatchResultWithPostInfo {
            let who = ensure_signed(origin)?;
            if !T::IdentityGate::is_allowed(&who) {
                log::debug!(target: LOG_TARGET, "close_poll rejected: identity not allowed for {who:?}");
                return Err(Error::<T>::NotAllowed.into());
            }
            let poll = Polls::<T>::get(host_id).ok_or(Error::<T>::PollNotFound)?;
            // Already finalized — idempotent no-op (a keeper may race here). Refund to the base weight: this
            // path did no observed-set scan, only a couple of reads.
            if PollResults::<T>::contains_key(host_id) {
                log::debug!(target: LOG_TARGET, "close_poll: poll {host_id} already finalized (no-op)");
                return Ok(Some(<T as Config>::WeightInfo::close_poll()).into());
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
            // `s_len` / `r_len` record how many accounts each join actually scanned, for the weight refund.
            let (weights, s_len) = if total == 0 {
                (alloc::vec![0u128; num_options], 0usize)
            } else {
                let stakers = Self::staker_weights();
                let s = stakers.len();
                (Self::poll_option_weights(host_id, num_options, &stakers), s)
            };
            // spec 208: FREEZE the SPO + dRep chambers for a chamber poll (a stake poll freezes none —
            // empty vecs read back as 0), so a concluded poll's chambers no longer re-price as delegation
            // later moves. spec 209: `poll_chamber_weights` freezes ONLY the chamber(s) this poll's kind
            // declares (`has_spo`/`has_drep`) — an `Spo`/`Drep`-only poll leaves the other EMPTY. The tally
            // iterates the bounded role-holder set (like the holder join above), so this stays
            // O(`MaxObserved`)-bounded on-chain. `total == 0` means NO votes at all (so no role-holder voted
            // either) ⇒ empty chambers, skipping the join exactly like the holder lens.
            let (cspo_w, cspo_c, cdrep_w, cdrep_c, r_len) = if total > 0 && poll.kind.has_chambers()
            {
                let holders = T::ChamberRoles::role_holders();
                let r = holders.len();
                let (a, b, c, d) = Self::poll_chamber_weights(
                    host_id,
                    num_options,
                    &holders,
                    poll.kind.has_spo(),
                    poll.kind.has_drep(),
                );
                (a, b, c, d, r)
            } else {
                (
                    alloc::vec![],
                    alloc::vec![],
                    alloc::vec![],
                    alloc::vec![],
                    0usize,
                )
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
            // Chamber snapshots: `num_options` entries for a governance poll, empty for a stake poll (the
            // loop below runs `num_options` times or 0 — every push is within `MaxPollOptions`).
            let mut option_spo_weights: BoundedVec<u128, T::MaxPollOptions> = Default::default();
            let mut option_spo_counts: BoundedVec<u32, T::MaxPollOptions> = Default::default();
            let mut option_drep_weights: BoundedVec<u128, T::MaxPollOptions> = Default::default();
            let mut option_drep_counts: BoundedVec<u32, T::MaxPollOptions> = Default::default();
            // SPO and dRep chambers push INDEPENDENTLY: an `Spo`/`Drep`-only poll has one chamber populated
            // (`num_options` entries) and the other empty, so a single shared-index loop would over-read the
            // empty one. Each empty chamber simply stays empty (reads back as 0).
            for i in 0..cspo_w.len() {
                option_spo_weights
                    .try_push(cspo_w[i])
                    .map_err(|_| Error::<T>::TooManyOptions)?;
                option_spo_counts
                    .try_push(cspo_c[i])
                    .map_err(|_| Error::<T>::TooManyOptions)?;
            }
            for i in 0..cdrep_w.len() {
                option_drep_weights
                    .try_push(cdrep_w[i])
                    .map_err(|_| Error::<T>::TooManyOptions)?;
                option_drep_counts
                    .try_push(cdrep_c[i])
                    .map_err(|_| Error::<T>::TooManyOptions)?;
            }
            PollResults::<T>::insert(
                host_id,
                PollResult {
                    option_weights,
                    option_counts,
                    option_spo_weights,
                    option_spo_counts,
                    option_drep_weights,
                    option_drep_counts,
                    closed_at: now,
                },
            );
            Self::deposit_event(Event::PollClosed { host_id });
            // Refund: the joins scanned `s_len` stakers + `r_len` role-holders; charge ≤3 reads/account
            // (holder ≤2, chamber ≤3) on top of the base. `≤ MaxObservedAccounts` each, so this is always
            // ≤ the declared worst case (`6 × MaxObservedAccounts`).
            let scanned = (s_len as u64).saturating_add(r_len as u64);
            let actual = <T as Config>::WeightInfo::close_poll()
                .saturating_add(T::DbWeight::get().reads(scanned.saturating_mul(3)));
            Ok(Some(actual).into())
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
            // on the profile crate (no Cargo cycle). The signer rides along (spec 211) so the runtime
            // can price a tidy-up call per-account (0 with state to clear, unpayable without).
            <T as Config>::ForeignCost::cost(&who, call)
        };
        let Some(need) = need else {
            return Ok((
                ValidTransaction::default(),
                Pre { who: None, cost: 0 },
                origin,
            ));
        };
        // The UNPAYABLE sentinel: a call that can never succeed for this signer (a tidy-up with
        // nothing to tidy). Same rule as the over-length body above — `Call` (malformed, not
        // retried), NOT `ExhaustsResources`, which the client reads as a rate limit and invites a
        // retry for. Checked BEFORE `have < need` so the "battery too low" arm only ever sees costs
        // that waiting could actually cover.
        if need == UNPAYABLE {
            log::debug!(
                target: crate::LOG_TARGET,
                "CheckCapacity: call from {:?} rejected at pool: priced UNPAYABLE (no-op, not retried)",
                who,
            );
            return Err(TransactionValidityError::Invalid(InvalidTransaction::Call));
        }
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
    /// The quoted author's live observed Cardano role badges as `(kind_index, id)` pairs (runtime-filled
    /// from pallet-cardano-roles; empty if none). Same primitive shape as `author_display_name`.
    pub author_roles: Vec<(u8, [u8; 28])>,
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
    /// The author's live observed Cardano role badges as `(kind_index, id)` pairs (kind: 0=SPO, 1=dRep,
    /// 2=CC; id: the 28-byte poolID / drepID / hot credential). Runtime-filled from pallet-cardano-roles
    /// (empty if none), so a feed card shows a ✓ SPO/dRep tag with no extra per-author read. Same
    /// primitive shape + no-Cargo-cycle rationale as `author_display_name`.
    pub author_roles: Vec<(u8, [u8; 28])>,
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
    /// The account's live observed Cardano role badges as primitive `(kind_index, id)` pairs (kind:
    /// 0=SPO, 1=dRep, 2=CC; id: the 28-byte poolID / drepID / hot credential). Runtime-filled from
    /// pallet-cardano-roles' observer-written `ObservedRoles` (empty if the account holds no live role).
    /// A primitive so this crate needs no cardano-roles dependency (which would be a Cargo cycle).
    pub observed_roles: Vec<(u8, [u8; 28])>,
}

/// One poll option with its per-lens tallies, for [`PollView`]. The `weight`/`count` are the HOLDER
/// (stake) lens (every voter × own `VotingPower`); the `spo_*`/`drep_*` fields (spec 207) are the SPO and
/// dRep CHAMBER lenses — populated only for a `PollKind::Governance` poll, `0` for a `Stake` poll. The
/// three lenses are index-aligned and reported SEPARATELY (never summed): no double-counting.
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct PollOptionView {
    /// The 0-based option index (matches the on-chain option index).
    pub index: u8,
    /// The option label bytes.
    pub label: Vec<u8>,
    /// HOLDER lens: sum of the `VotingPower` of accounts currently choosing this option.
    pub weight: u128,
    /// HOLDER lens: number of accounts currently choosing this option.
    pub count: u32,
    /// SPO CHAMBER lens (spec 207): total delegated pool stake of the pools whose owner(s) chose this
    /// option (deduped per pool). `0` for a `Stake` poll.
    pub spo_weight: u128,
    /// SPO CHAMBER lens: number of distinct pools choosing this option. `0` for a `Stake` poll.
    pub spo_count: u32,
    /// dRep CHAMBER lens (spec 207): total delegated voting stake of the dReps who chose this option. `0`
    /// for a `Stake` poll.
    pub drep_weight: u128,
    /// dRep CHAMBER lens: number of distinct dReps choosing this option. `0` for a `Stake` poll.
    pub drep_count: u32,
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
    /// The poll's lens (spec 207, extended 209): `0` = Stake, `1` = Governance (both chambers), `2` = Spo
    /// (SPO chamber only), `3` = Drep (dRep chamber only). Mirrors [`PollKind`]'s `#[codec(index)]`. On a
    /// non-`Governance` chamber poll, only the declared chamber's `spo_*`/`drep_*` fields are populated.
    pub kind: u8,
    /// The governance-action tag (spec 209) if this poll is a pre-submission temperature check on a
    /// specific CIP-1694 action; `None` for a plain poll.
    pub action: Option<GovActionView>,
}

/// A poll's optional governance-action tag for [`PollView`] (spec 209): the CIP-1694 action type as a
/// pinned `u8` (mirroring [`GovActionType`]'s `#[codec(index)]`), the anchor link to the off-chain
/// proposal document, and an optional blake2b-256 document hash. `None` on a plain poll.
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct GovActionView {
    /// CIP-1694 action type: 0 Info · 1 NoConfidence · 2 UpdateCommittee · 3 NewConstitution ·
    /// 4 HardFork · 5 ParamChange · 6 TreasuryWithdrawal.
    pub action_type: u8,
    /// Link to the off-chain proposal document (its home stays GitHub/IPFS, like a real Cardano anchor).
    pub anchor_url: Vec<u8>,
    /// Optional blake2b-256 hash of the document at `anchor_url`.
    pub anchor_hash: Option<[u8; 32]>,
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
        // Anchor RepliesByParent to its TRUE forward edge — a `Post` with `parent == Some(par)` — not
        // just to `ReplyCount` (its own derived counter). Without this, a reply-path edit that dropped
        // BOTH aggregate writes would keep RepliesByParent and ReplyCount mutually consistent while
        // silently diverging from the posts themselves. Mirror check, both directions (as for the vote /
        // follow indexes above): the `id` side is always a real post; `par` is deliberately unvalidated
        // (a reply may dangle under a not-yet-existing parent), so only the child is required to exist.
        for (id, post) in Posts::<T>::iter() {
            if let Some(par) = post.parent {
                if !RepliesByParent::<T>::contains_key(par, id) {
                    return Err("a reply post is missing its RepliesByParent entry");
                }
            }
        }
        for (par, child) in RepliesByParent::<T>::iter_keys() {
            match Posts::<T>::get(child) {
                Some(p) if p.parent == Some(par) => {}
                _ => return Err("a RepliesByParent entry has no matching reply post"),
            }
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

        // 7. the per-author indexes (spec 212). The counters are DERIVED aggregates now — the bounded
        // vec carried its own length, the double maps do not — so they can drift, and drift is silent:
        // an over-count makes the seq walk read a hole (a page silently short), an under-count hides
        // the author's newest posts entirely. Anchor them the same way the reply aggregate is anchored:
        // to the row counts, to seq DENSITY (the walk assumes `0..count` with no gap, which is also what
        // makes seq order == id order), and to the TRUE forward edge, a `Posts` row's own `author`.
        //
        // ONE pass per index, accumulating `(row count, max seq)` per author, then ONE pass over the
        // counters. Deliberately NOT a `Count::get(&author)` per ROW: that is a storage read per POST,
        // and this runs inside the pre-enactment `try-runtime` dry-run — the safety net that has
        // already caught a real bug on this branch, and the one thing that must not become too slow to
        // run. The per-author accumulator is the same information: rows are map KEYS, so each seq
        // appears at most once; `count == rows` plus `max_seq < count` then forces the seq set to be
        // exactly `0..count`, which is the density the readers walk.
        let mut by_author: BTreeMap<T::AccountId, (u64, u64)> = BTreeMap::new();
        for (author, seq, _id) in ByAuthor::<T>::iter() {
            let e = by_author.entry(author).or_insert((0, 0));
            e.0 = e.0.saturating_add(1);
            e.1 = e.1.max(seq);
        }
        // The total ByAuthor row count, carried out of the pass above so the cardinality check at the
        // end does not walk the whole index a second time.
        let by_author_rows: u64 = by_author.values().map(|(rows, _)| rows).sum();
        for (author, count) in ByAuthorCount::<T>::iter() {
            // `unwrap_or` keeps a (degenerate but harmless) zero counter with no rows passing, as
            // before; the density check is skipped there because there is no seq to check.
            let (rows, max_seq) = by_author.remove(&author).unwrap_or((0, 0));
            if count != rows {
                return Err("ByAuthorCount disagrees with the ByAuthor rows");
            }
            if rows > 0 && max_seq >= count {
                return Err("a ByAuthor seq is at or past its ByAuthorCount (index not dense)");
            }
        }
        if !by_author.is_empty() {
            return Err("ByAuthor rows exist for an author with no ByAuthorCount row");
        }
        let mut top_level: BTreeMap<T::AccountId, (u64, u64)> = BTreeMap::new();
        for (author, seq, id) in TopLevelByAuthor::<T>::iter() {
            let e = top_level.entry(author).or_insert((0, 0));
            e.0 = e.0.saturating_add(1);
            e.1 = e.1.max(seq);
            match Posts::<T>::get(id) {
                Some(p) if p.parent.is_none() => {}
                _ => return Err("a TopLevelByAuthor entry is missing or is not top-level"),
            }
        }
        for (author, count) in TopLevelByAuthorCount::<T>::iter() {
            let (rows, max_seq) = top_level.remove(&author).unwrap_or((0, 0));
            if count != rows {
                return Err("TopLevelByAuthorCount disagrees with the TopLevelByAuthor rows");
            }
            if rows > 0 && max_seq >= count {
                return Err("a TopLevelByAuthor seq is at or past its count (index not dense)");
            }
        }
        if !top_level.is_empty() {
            return Err("TopLevelByAuthor rows exist for an author with no count row");
        }
        // Every post is indexed exactly once — the check that catches a creation path that forgot to
        // call `index_by_author` (the counters above would stay mutually consistent through that).
        //
        // Deliberately a CARDINALITY check, not a set membership one. Materializing every post id per
        // author would be O(total posts) on the wasm HEAP, and this runs inside `try_state` — i.e.
        // inside the pre-enactment `try-runtime` dry-run that docs/UPGRADES.md makes the safety net for
        // every future migration. Blowing that up at scale would disable the one gate that has already
        // caught a real bug on this branch. The counts are equal iff nothing is missing, because
        // `index_by_author` is the single writer, appends exactly once per created post, and `Posts` is
        // append-only (`delete_post` was removed before launch). Per-author attribution is covered by
        // construction: all three creation sites pass the SAME `who` to `Posts::insert` and to
        // `index_by_author`.
        //
        // `by_author_rows` is carried out of the pass above rather than re-walking `ByAuthor` here, for
        // the same reason: one trie walk per index, not two.
        if by_author_rows != Posts::<T>::iter().count() as u64 {
            return Err("the ByAuthor index and Posts disagree on how many posts exist");
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

    /// SPO + dRep CHAMBER tallies for a `PollKind::Governance` poll: the per-option delegated-stake weight
    /// and distinct-role count for the SPO chamber and the dRep chamber. These are the "vote as if it were
    /// a Cardano governance action" lenses — reported SEPARATELY from the holder (stake) tally and from each
    /// other, so nothing is double-counted. DISPLAY-ONLY (a temperature check, binding nothing on-chain).
    /// Derived LIVE for an open poll and FROZEN at `close_poll` (spec 208), so a concluded poll's chambers
    /// stop re-pricing as delegation later moves.
    ///
    /// It iterates the BOUNDED observed role-holder set (`holders`, from
    /// [`Config::ChamberRoles::role_holders`], ≤ the observer's `MaxObserved`) and point-looks-up each
    /// holder's poll vote — NOT the unbounded voter set — so it is O(`MaxObserved`)-bounded and safe to
    /// compute on-chain in `close_poll`, exactly like the holder-lens join in [`Self::poll_option_weights`].
    /// The set is passed in (not fetched here) so `close_poll` can meter its actual size. A role-holder who
    /// did not vote contributes nothing; a voter with no role contributes nothing — the same result either
    /// way. The SPO chamber is DEDUPED by pool id — a pool's delegated stake counts ONCE even if several
    /// declared owners of it voted; if those owners SPLIT across options the pool ABSTAINS (its weight is
    /// dropped) rather than being assigned arbitrarily. The dRep chamber needs no dedup (the claim ledger is
    /// 1:1 drep↔account). Undelegated pools/dReps carry weight 0 and are skipped, so the SPO chamber
    /// reflects the real delegated stake of every live pool a voter operates — via ownership OR a
    /// claim-backed Calidus key. That weight can never be fabricated (it is always on-chain delegation of a
    /// cold-key-signed pool), so both SPO sources tally honestly; an mSPO's per-pool weights SUM here (each
    /// pool a distinct dedup key), matching the aggregate the operator would vote with on Cardano. The
    /// result is independent of holder-iteration order.
    ///
    /// `want_spo` / `want_drep` (spec 209) select which chamber(s) this poll's [`PollKind`] surfaces:
    /// `Governance` passes both, an `Spo`/`Drep`-only poll passes a single `true`, and a `Stake` poll never
    /// calls this. An unrequested chamber is neither accumulated nor materialized — it is returned as an
    /// EMPTY vec, which every reader treats as 0 (`.get(i).unwrap_or(0)`) and which `close_poll` freezes as
    /// the empty snapshot. Centralizing the lens here keeps the suppression rule in ONE place (no
    /// caller-side zeroing) and skips the discarded chamber's whole aggregation.
    ///
    /// Returns `(spo_weights, spo_counts, drep_weights, drep_counts)`: each REQUESTED chamber is a
    /// `num_options`-length vec index-aligned with `Poll.options`; each unrequested chamber is empty.
    fn poll_chamber_weights(
        host_id: u64,
        num_options: usize,
        holders: &[T::AccountId],
        want_spo: bool,
        want_drep: bool,
    ) -> (Vec<u128>, Vec<u32>, Vec<u128>, Vec<u32>) {
        use alloc::collections::BTreeMap;
        // pool id → (chosen option, delegated stake, conflicted?) — collapse a co-owned pool to ONE vote.
        let mut pool_choice: BTreeMap<[u8; 28], (u8, u128, bool)> = BTreeMap::new();
        // drep id → (chosen option, delegated voting stake). 1:1 drep↔account, so no conflict handling.
        let mut drep_choice: BTreeMap<[u8; 28], (u8, u128)> = BTreeMap::new();
        for holder in holders {
            // Only role-holders who actually voted this poll contribute (a point read, not a prefix scan).
            let Some(rec) = PollVotes::<T>::get(host_id, holder) else {
                continue;
            };
            let opt = rec.option;
            if (opt as usize) >= num_options {
                continue;
            }
            for (kind, id, weight) in T::ChamberRoles::roles_of(holder) {
                if weight == 0 {
                    continue; // an undelegated pool or dRep (weight 0) contributes nothing
                }
                match kind {
                    0 if want_spo => {
                        // SPO chamber: dedup by pool; owners split across options ⇒ the pool abstains.
                        pool_choice
                            .entry(id)
                            .and_modify(|e| {
                                if e.0 != opt {
                                    e.2 = true;
                                }
                            })
                            .or_insert((opt, weight, false));
                    }
                    1 if want_drep => {
                        // dRep chamber: an id appears for a single voter (1:1) — just record it.
                        drep_choice.entry(id).or_insert((opt, weight));
                    }
                    // CC (2), or a chamber this poll's kind does not surface — ignore.
                    _ => {}
                }
            }
        }
        // A requested chamber materializes a `num_options`-length vec; an unrequested one stays empty.
        let (spo_weights, spo_counts) = if want_spo {
            let mut weights = alloc::vec![0u128; num_options];
            let mut counts = alloc::vec![0u32; num_options];
            for (_pool, (opt, weight, conflict)) in pool_choice {
                if conflict {
                    continue; // declared owners disagreed → the pool casts no chamber vote
                }
                let i = opt as usize;
                weights[i] = weights[i].saturating_add(weight);
                counts[i] = counts[i].saturating_add(1);
            }
            (weights, counts)
        } else {
            (alloc::vec![], alloc::vec![])
        };
        let (drep_weights, drep_counts) = if want_drep {
            let mut weights = alloc::vec![0u128; num_options];
            let mut counts = alloc::vec![0u32; num_options];
            for (_drep, (opt, weight)) in drep_choice {
                let i = opt as usize;
                weights[i] = weights[i].saturating_add(weight);
                counts[i] = counts[i].saturating_add(1);
            }
            (weights, counts)
        } else {
            (alloc::vec![], alloc::vec![])
        };
        (spo_weights, spo_counts, drep_weights, drep_counts)
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
                author_roles: Vec::new(),
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
            author_roles: Vec::new(),
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
        let viewer_ref = viewer.as_ref();
        let stakers = Self::staker_weights();
        let mut posts = Vec::new();
        let mut next_cursor = None;
        // `TopLevelByAuthor` is seq-keyed in append order (ascending id) and reply-free, so walking
        // `seq` DOWN yields ids newest-first — the same order the pre-v10 bounded vec gave via
        // `.iter().rev()`, and the order this cursor arithmetic depends on. Deliberately a keyed `get`
        // per step, NOT prefix iteration: a double map iterates in HASH order.
        //
        // The `before_id` cursor is resolved by BINARY SEARCH rather than by skipping. Under the old
        // blob shape a skip was free (one read of the whole vector, then an in-memory scan); keyed by
        // seq it would be one trie read per skipped entry, so page N of a profile would cost N·limit
        // reads and the total scroll would be quadratic — on a public, unmetered runtime API, over an
        // index that no longer has a `MaxPostsPerAuthor` bound. Every entry here IS returned (the index
        // is reply-free), so with the start point resolved the page then costs exactly `limit` reads
        // and needs no scan budget. `author_replies_page` filters, so it needs one; see there.
        let count = TopLevelByAuthorCount::<T>::get(&author);
        let mut seq = Self::author_index_seq_below(count, before_id, |s| {
            TopLevelByAuthor::<T>::get(&author, s)
        });
        while seq > 0 {
            seq = seq.saturating_sub(1);
            let id = match TopLevelByAuthor::<T>::get(&author, seq) {
                Some(id) => id,
                None => continue,
            };
            // Kept as a guard, not as the paging mechanism: the binary search above assumes ids ascend
            // with seq, and this makes a violation of that assumption return FEWER posts rather than
            // wrong ones.
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

    /// The exclusive upper `seq` bound for a `before_id` cursor over a per-author index: the number of
    /// entries whose post id is strictly below `before_id` (or `count` when there is no cursor, i.e.
    /// start at the newest). Walk `seq` DOWN from the returned value.
    ///
    /// A binary search, not a scan. Post ids are strictly ascending in `seq` by construction —
    /// `NextPostId` is monotonic and the index is append-only — so the index is sorted and resolving a
    /// cursor costs `O(log n)` reads instead of one read per skipped entry. That is what keeps a deep
    /// profile page, and the whole scroll, bounded now that the per-author index has no cap.
    ///
    /// A missing entry (a hole, which the `try_state` density invariant says cannot exist) is treated
    /// as "at or above the cursor", so the search moves left. That can only under-return, never
    /// mis-order.
    fn author_index_seq_below<G>(count: u64, before_id: Option<u64>, get: G) -> u64
    where
        G: Fn(u64) -> Option<u64>,
    {
        let before = match before_id {
            None => return count,
            Some(b) => b,
        };
        let (mut lo, mut hi) = (0u64, count);
        while lo < hi {
            let mid = lo.saturating_add((hi - lo) / 2);
            match get(mid) {
                Some(id) if id < before => lo = mid.saturating_add(1),
                _ => hi = mid,
            }
        }
        lo
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

    /// The author's TOP-LEVEL post count — the correct profile `postCount` that excludes replies
    /// (fixes the count-counts-replies tradeoff). O(1) via the explicit counter; before spec 212 this
    /// was `TopLevelByAuthor::decode_len`, which the double-map shape no longer offers. Saturates into
    /// the on-wire `u32` (`ProfileView.post_count`); the counter itself is `u64` and uncapped.
    pub fn top_level_post_count(author: &T::AccountId) -> u32 {
        TopLevelByAuthorCount::<T>::get(author)
            .try_into()
            .unwrap_or(u32::MAX)
    }

    /// One author's REPLIES (the profile Replies tab): their posts with `parent != None`, newest-first,
    /// paged below `before_id` (a post id). Walks the author's own `ByAuthor` index by `seq`, newest
    /// first, resolving the cursor by binary search exactly as [`Pallet::author_feed_page`] does.
    ///
    /// Unlike the author feed, this one FILTERS: `ByAuthor` holds every post, and only replies are
    /// returned, so an author with no replies (or a long top-level run) would examine their whole index
    /// to fill nothing. That is the over-scan `MAX_SCAN_FACTOR` exists for elsewhere in this pallet, and
    /// it matters more since spec 212 because the index has no `MaxPostsPerAuthor` bound any more. So
    /// the walk is capped at `limit · MAX_SCAN_FACTOR` examined entries and hands back a cursor to
    /// continue from — the same short-page-plus-cursor contract `feed_page` already has, which the
    /// client's `chasePage` already chases. (`author_feed_page` deliberately does NOT do this: its index
    /// is reply-free so it never over-scans, and the Lists fan-out merges its pages by post id and
    /// relies on a short page meaning "exhausted".)
    pub fn author_replies_page(
        author: T::AccountId,
        before_id: Option<u64>,
        limit: u32,
        viewer: Option<T::AccountId>,
    ) -> FeedPage<T::AccountId> {
        let limit = Self::clamp_limit(limit);
        let viewer_ref = viewer.as_ref();
        let stakers = Self::staker_weights();
        let mut posts = Vec::new();
        let mut next_cursor = None;
        let max_scan = limit.saturating_mul(MAX_SCAN_FACTOR);
        let mut examined: u32 = 0;
        let count = ByAuthorCount::<T>::get(&author);
        let mut seq =
            Self::author_index_seq_below(count, before_id, |s| ByAuthor::<T>::get(&author, s));
        while seq > 0 {
            seq = seq.saturating_sub(1);
            let id = match ByAuthor::<T>::get(&author, seq) {
                Some(id) => id,
                None => continue,
            };
            // Guard, not the paging mechanism — see `author_feed_page`.
            if let Some(b) = before_id {
                if id >= b {
                    continue;
                }
            }
            // Scan budget spent: stop and resume from this id. Counted BEFORE the reply filter, since
            // skipping top-level posts is exactly the work being bounded.
            if examined >= max_scan {
                next_cursor = Some(id.saturating_add(1));
                break;
            }
            examined = examined.saturating_add(1);
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
    /// If the poll is FINALIZED ([`PollResults`] present) the FROZEN per-option holder weight AND (spec 208)
    /// the frozen SPO/dRep chamber snapshot are returned; otherwise both are derived LIVE (the holder weight
    /// from the staker set's current `VotingPower`, the chambers from the observed role-holders — a poll
    /// past its `close_at` but not yet finalized reads live, and the frontend auto-triggers `close_poll` to
    /// freeze it). The per-option COUNTS are always the exact stored values; the wire shape is unchanged.
    pub fn poll(host_id: u64) -> Option<PollView> {
        let poll = Polls::<T>::get(host_id)?;
        let num_options = poll.options.len();
        let kind_ix = match poll.kind {
            PollKind::Stake => 0u8,
            PollKind::Governance => 1u8,
            PollKind::Spo => 2u8,
            PollKind::Drep => 3u8,
        };
        // The governance-action tag (spec 209), if any, mirrored to the wire view: action type as a pinned
        // u8 (matching `GovActionType`'s `#[codec(index)]`) + the anchor link + optional document hash. It is
        // static creation-time data, identical whether the poll is live or finalized.
        let action = poll.action.as_ref().map(|a| GovActionView {
            action_type: match a.action_type {
                GovActionType::Info => 0u8,
                GovActionType::NoConfidence => 1u8,
                GovActionType::UpdateCommittee => 2u8,
                GovActionType::NewConstitution => 3u8,
                GovActionType::HardFork => 4u8,
                GovActionType::ParamChange => 5u8,
                GovActionType::TreasuryWithdrawal => 6u8,
            },
            anchor_url: a.anchor_url.to_vec(),
            anchor_hash: a.anchor_hash,
        });
        let mut options = Vec::with_capacity(num_options);
        let mut total_votes: u32 = 0;
        // Finalized — return the FROZEN snapshot: both the HOLDER lens and (spec 208) the SPO/dRep CHAMBERS
        // are read from `PollResult`, so a concluded governance poll's chambers no longer re-price as
        // delegation later moves. A stake poll's chamber vecs are empty ⇒ read back as 0.
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
                    spo_weight: result.option_spo_weights.get(i).copied().unwrap_or(0),
                    spo_count: result.option_spo_counts.get(i).copied().unwrap_or(0),
                    drep_weight: result.option_drep_weights.get(i).copied().unwrap_or(0),
                    drep_count: result.option_drep_counts.get(i).copied().unwrap_or(0),
                });
            }
            return Some(PollView {
                host_id,
                options,
                total_votes,
                kind: kind_ix,
                // Moved, not cloned: this branch returns, so the open branch below still owns `action`.
                action,
            });
        }
        // Open (or past-deadline-but-unfinalized) — derive the holder per-option weight live from stake, and
        // the SPO/dRep chambers live for a chamber poll (a stake poll gets all-zero chambers). The kind's
        // `has_spo`/`has_drep` select the surfaced chamber(s): an `Spo`/`Drep`-only poll gets the other back
        // as an EMPTY vec (read as 0 below via `.get(i).unwrap_or(0)`).
        let (spo_w, spo_c, drep_w, drep_c) = if poll.kind.has_chambers() {
            let holders = T::ChamberRoles::role_holders();
            Self::poll_chamber_weights(
                host_id,
                num_options,
                &holders,
                poll.kind.has_spo(),
                poll.kind.has_drep(),
            )
        } else {
            (
                alloc::vec![0u128; num_options],
                alloc::vec![0u32; num_options],
                alloc::vec![0u128; num_options],
                alloc::vec![0u32; num_options],
            )
        };
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
                spo_weight: spo_w.get(i).copied().unwrap_or(0),
                spo_count: spo_c.get(i).copied().unwrap_or(0),
                drep_weight: drep_w.get(i).copied().unwrap_or(0),
                drep_count: drep_c.get(i).copied().unwrap_or(0),
            });
        }
        Some(PollView {
            host_id,
            options,
            total_votes,
            kind: kind_ix,
            action,
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
