// This is free and unencumbered software released into the public domain.
//
// Anyone is free to copy, modify, publish, use, compile, sell, or
// distribute this software, either in source code form or as a compiled
// binary, for any purpose, commercial or non-commercial, and by any
// means.
//
// In jurisdictions that recognize copyright laws, the author or authors
// of this software dedicate any and all copyright interest in the
// software to the public domain. We make this dedication for the benefit
// of the public at large and to the detriment of our heirs and
// successors. We intend this dedication to be an overt act of
// relinquishment in perpetuity of all present and future rights to this
// software under copyright law.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
// IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
// OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
// ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
// OTHER DEALINGS IN THE SOFTWARE.
//
// For more information, please refer to <http://unlicense.org>

// Substrate and Polkadot dependencies
use frame_support::{
	derive_impl,
	dispatch::DispatchClass,
	parameter_types,
	traits::{ConstBool, ConstU128, ConstU32, ConstU64, ConstU8, EitherOfDiverse, VariantCountOf},
	weights::{
		constants::{RocksDbWeight, WEIGHT_REF_TIME_PER_SECOND},
		IdentityFee, Weight,
	},
};
// DR-07: the mutable k-of-t committee origin combinator + its default instance.
use pallet_collective::{EnsureProportionAtLeast, Instance1};
use frame_system::{
	limits::{BlockLength, BlockWeights},
	EnsureRoot,
};
use pallet_transaction_payment::{ConstFeeMultiplier, FungibleAdapter, Multiplier};
use sp_consensus_aura::sr25519::AuthorityId as AuraId;
use sp_runtime::{
	traits::{One, OpaqueKeys},
	Perbill,
};
use sp_version::RuntimeVersion;

// Local module imports
use super::{
	AccountId, Aura, Balance, Balances, Block, BlockNumber, CognoGate, Hash, Microblog, Nonce,
	PalletInfo, Runtime, RuntimeCall, RuntimeEvent, RuntimeFreezeReason, RuntimeHoldReason,
	RuntimeOrigin, RuntimeTask, SessionKeys, System, Timestamp, ValidatorSet, DAYS,
	EXISTENTIAL_DEPOSIT, SLOT_DURATION, VERSION,
};

const NORMAL_DISPATCH_RATIO: Perbill = Perbill::from_percent(75);

parameter_types! {
	pub const BlockHashCount: BlockNumber = 2400;
	pub const Version: RuntimeVersion = VERSION;

	/// We allow for 2 seconds of compute with a 6 second average block time.
	pub RuntimeBlockWeights: BlockWeights = BlockWeights::with_sensible_defaults(
		Weight::from_parts(2u64 * WEIGHT_REF_TIME_PER_SECOND, u64::MAX),
		NORMAL_DISPATCH_RATIO,
	);
	pub RuntimeBlockLength: BlockLength = BlockLength::builder()
		.max_length(5 * 1024 * 1024)
		.modify_max_length_for_class(DispatchClass::Normal, |m| *m = NORMAL_DISPATCH_RATIO * *m)
		.build();
	pub const SS58Prefix: u8 = 42;
}

/// All migrations of the runtime, aside from the ones declared in the pallets. A tuple of types,
/// each implementing `OnRuntimeUpgrade`. Run by the Executive (via `AllPalletsWithSystem`) BEFORE
/// the per-pallet `on_runtime_upgrade` hooks, in the first block after a `setCode`.
///
/// The project's FIRST migration: microblog `Post` v0 → v1 (adds the `quote` field), guarded by
/// `VersionedMigration` so it runs once (on-chain storage version 0 → 1) and self-skips thereafter.
/// Leave it registered across the next few spec bumps (it's a no-op once applied), then drop it.
#[allow(unused_parens)]
type SingleBlockMigrations = (
	// v1 is idempotent (self-skips once microblog is at storage version 1) — kept for fresh syncs.
	pallet_microblog::migrations::v1::MigrateV0ToV1<Runtime>,
	// spec 118: backfill the reverse Followers + VotesByAccount indexes.
	pallet_microblog::migrations::v2::MigrateV1ToV2<Runtime>,
	// spec 118: add banner / location / website to every Profile (defaulted empty).
	pallet_profile::migrations::v1::MigrateV0ToV1<Runtime>,
	// spec 119: backfill the ReplyCount + RepliesByParent reply aggregates from existing Posts.
	pallet_microblog::migrations::v3::MigrateV2ToV3<Runtime>,
);

/// The default types are being injected by [`derive_impl`](`frame_support::derive_impl`) from
/// [`SoloChainDefaultConfig`](`struct@frame_system::config_preludes::SolochainDefaultConfig`),
/// but overridden as needed.
#[derive_impl(frame_system::config_preludes::SolochainDefaultConfig)]
impl frame_system::Config for Runtime {
	/// The block type for the runtime.
	type Block = Block;
	/// Block & extrinsics weights: base values and limits.
	type BlockWeights = RuntimeBlockWeights;
	/// The maximum length of a block (in bytes).
	type BlockLength = RuntimeBlockLength;
	/// The identifier used to distinguish between accounts.
	type AccountId = AccountId;
	/// The type for storing how many extrinsics an account has signed.
	type Nonce = Nonce;
	/// The type for hashing blocks and tries.
	type Hash = Hash;
	/// Maximum number of block number to block hash mappings to keep (oldest pruned first).
	type BlockHashCount = BlockHashCount;
	/// The weight of database operations that the runtime can invoke.
	type DbWeight = RocksDbWeight;
	/// Version of the runtime.
	type Version = Version;
	/// The data to be stored in an account.
	type AccountData = pallet_balances::AccountData<Balance>;
	/// This is used as an identifier of the chain. 42 is the generic substrate prefix.
	type SS58Prefix = SS58Prefix;
	type MaxConsumers = frame_support::traits::ConstU32<16>;
	type SingleBlockMigrations = SingleBlockMigrations;
}

impl pallet_aura::Config for Runtime {
	type AuthorityId = AuraId;
	type DisabledValidators = ();
	type MaxAuthorities = ConstU32<32>;
	type AllowMultipleBlocksPerSlot = ConstBool<false>;
	type SlotDuration = pallet_aura::MinimumPeriodTimesTwo<Runtime>;
}

/// GRANDPA finality gadget.
///
/// ⚠ Equivocation reporting is a deliberate NO-OP on this permissioned testnet (`runtime-5`):
/// `KeyOwnerProof = Void` + `EquivocationReportSystem = ()` (and the `grandpa` runtime API returns
/// `None`) mean a double-signing validator has no on-chain consequence — no slashing/disabling. This
/// is acceptable while the authority set is the small operator-run committee with off-chain
/// accountability (M6's mutable set is gated by the 3-of-5 `AuthorityOrigin`).
///
/// ⚠ MAINNET PREREQUISITE: before a public multi-validator network, wire a real
/// `KeyOwnerProofSystem` / `EquivocationReportSystem` (via `pallet-session` historical + an offences
/// pallet) so a double-sign is provable and punishable on-chain — in lockstep with raising
/// `MinAuthorities` to a BFT floor (`validators-1`).
impl pallet_grandpa::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;

	type WeightInfo = ();
	type MaxAuthorities = ConstU32<32>;
	type MaxNominators = ConstU32<0>;
	type MaxSetIdSessionEntries = ConstU64<0>;

	type KeyOwnerProof = sp_core::Void;
	type EquivocationReportSystem = ();
}

impl pallet_timestamp::Config for Runtime {
	/// A timestamp: milliseconds since the unix epoch.
	type Moment = u64;
	type OnTimestampSet = Aura;
	type MinimumPeriod = ConstU64<{ SLOT_DURATION / 2 }>;
	type WeightInfo = ();
}

impl pallet_balances::Config for Runtime {
	type MaxLocks = ConstU32<50>;
	type MaxReserves = ();
	type ReserveIdentifier = [u8; 8];
	/// The type for recording an account's balance.
	type Balance = Balance;
	/// The ubiquitous event type.
	type RuntimeEvent = RuntimeEvent;
	type DustRemoval = ();
	type ExistentialDeposit = ConstU128<EXISTENTIAL_DEPOSIT>;
	type AccountStore = System;
	type WeightInfo = pallet_balances::weights::SubstrateWeight<Runtime>;
	type FreezeIdentifier = RuntimeFreezeReason;
	type MaxFreezes = VariantCountOf<RuntimeFreezeReason>;
	type RuntimeHoldReason = RuntimeHoldReason;
	type RuntimeFreezeReason = RuntimeFreezeReason;
	type DoneSlashHandler = ();
}

parameter_types! {
	pub FeeMultiplier: Multiplier = Multiplier::one();
}

impl pallet_transaction_payment::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type OnChargeTransaction = FungibleAdapter<Balances, ()>;
	type OperationalFeeMultiplier = ConstU8<5>;
	type WeightToFee = IdentityFee<Balance>;
	type LengthToFee = IdentityFee<Balance>;
	type FeeMultiplierUpdate = ConstFeeMultiplier<FeeMultiplier>;
	type WeightInfo = pallet_transaction_payment::weights::SubstrateWeight<Runtime>;
}

impl pallet_sudo::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type RuntimeCall = RuntimeCall;
	type WeightInfo = pallet_sudo::weights::SubstrateWeight<Runtime>;
}

// ── DR-07: the FollowerCommittee — the mutable k-of-t authority behind the crown jewels ──
//
// `pallet-collective` (one shared `Instance1`) holds a MUTABLE member set (rotation via
// `Collective::set_members`, gated by `SetMembersOrigin` = root/sudo in v1) and produces an
// `EnsureProportionAtLeast<3,5>` origin when a motion carries a 3-of-5 supermajority. That origin
// — OR `EnsureRoot`/sudo (the retained v1 dev escape hatch) — authorizes every privileged write.
// The proposal lifecycle (`Proposed`/`Voted`/`Closed`/`Approved`/`Executed`) IS the per-action
// audit log (DR-07's D0 requirement). Widening to k-of-t changed ZERO call signatures because the
// underlying origins were already `EnsureOrigin` (L2 §8.4). The D2 gate before any mainnet run is
// exactly this 3-of-5 across five independent custody domains (DR-26).
parameter_types! {
	/// Motion lifetime before it lapses. Members can `close` early once 3-of-5 is reached, so this
	/// is just the upper bound on an undecided motion (dev value).
	pub const FollowerMotionDuration: BlockNumber = 7 * DAYS;
	/// Max simultaneously-active motions.
	pub const FollowerMaxProposals: u32 = 100;
	/// Max committee members (≥ the 5 seats of the 3-of-5 D2 committee, with headroom).
	pub const FollowerMaxMembers: u32 = 7;
	/// Cap on the weight of a call a motion may execute (mirrors the council convention: 50% of a
	/// block). All four privileged calls are tiny single-map writes, well under this.
	pub MaxProposalWeight: Weight = Perbill::from_percent(50) * RuntimeBlockWeights::get().max_block;
}

impl pallet_collective::Config<Instance1> for Runtime {
	type RuntimeOrigin = RuntimeOrigin;
	type Proposal = RuntimeCall;
	type RuntimeEvent = RuntimeEvent;
	type MotionDuration = FollowerMotionDuration;
	type MaxProposals = FollowerMaxProposals;
	type MaxMembers = FollowerMaxMembers;
	// Prime-member fallback vote; the prime is the tie-breaker for absentees.
	type DefaultVote = pallet_collective::PrimeDefaultVote;
	type WeightInfo = pallet_collective::weights::SubstrateWeight<Runtime>;
	// v1: root/sudo rotates the committee. Move this to the committee itself (self-rotation) or an
	// Ariadne/SPO selection pallet at the D2/D3 graduation — a signature-free EnsureOrigin swap.
	type SetMembersOrigin = EnsureRoot<AccountId>;
	type MaxProposalWeight = MaxProposalWeight;
	type DisapproveOrigin = EnsureRoot<AccountId>;
	type KillOrigin = EnsureRoot<AccountId>;
	// No proposal deposit/consideration in v1 (the committee is permissioned, not open).
	type Consideration = ();
}

/// The crown-jewel authority origin (DR-07): EITHER `EnsureRoot`/sudo (the v1 dev fallback) OR a
/// **3-of-5 supermajority** of the [`FollowerCommittee`]. Shared by `cogno-gate::FollowerOrigin`,
/// `talk-stake::SetStakeOrigin`, `anchor::AnchorOrigin`, and `microblog::ForceOrigin` so identity,
/// weight, anchoring, and force-capacity all sit behind ONE trust boundary (L2 §8.4, L3 §4.5).
pub type AuthorityOrigin =
	EitherOfDiverse<EnsureRoot<AccountId>, EnsureProportionAtLeast<AccountId, Instance1, 3, 5>>;

// ── M6 (DR-26): MUTABLE Aura+GRANDPA authorities via pallet-session + pallet-validator-set ──
//
// `pallet-session` rotates the block-producing authority set; `pallet-validator-set` is its
// `SessionManager` (the mutable set, gated add/remove). Aura+GRANDPA derive their authorities from
// the session each rotation (their `OneSessionHandler` impls), NOT from static genesis — the two
// are mutually exclusive (the aura/grandpa genesis is left empty; authorities are seated through
// `SessionConfig`). A queued add/remove is applied at a session boundary (~2 sessions), never
// mid-session (`L3-chain.md` §8.2).
parameter_types! {
	/// Session length in blocks. DEV-TUNED short (10 blocks ≈ 1 min at 6s/block) so an add/remove
	/// becomes active quickly in the showcase; a queued change applies at the next-but-one boundary
	/// (~2 sessions ≈ 2 min). A constant change for a real testnet (longer sessions = less rotation
	/// churn). Aura↔GRANDPA stay in lockstep because BOTH follow this one session schedule.
	pub const SessionPeriod: BlockNumber = 10;
	pub const SessionOffset: BlockNumber = 0;
}

impl pallet_session::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type ValidatorId = AccountId;
	// Identity: an account is its own validator id (eligibility is gated by `add_validator`).
	type ValidatorIdOf = pallet_validator_set::ValidatorOf<Runtime>;
	type ShouldEndSession = pallet_session::PeriodicSessions<SessionPeriod, SessionOffset>;
	type NextSessionRotation = pallet_session::PeriodicSessions<SessionPeriod, SessionOffset>;
	// The mutable validator set IS the session manager.
	type SessionManager = ValidatorSet;
	// `(Aura, Grandpa)` — generated from the opaque `SessionKeys`; this is the wire that makes
	// the two authority sets follow the session in lockstep (update one ⇒ update both).
	type SessionHandler = <SessionKeys as OpaqueKeys>::KeyTypeIdProviders;
	type Keys = SessionKeys;
	type DisablingStrategy =
		pallet_session::disabling::UpToLimitWithReEnablingDisablingStrategy;
	type WeightInfo = pallet_session::weights::SubstrateWeight<Runtime>;
	type Currency = Balances;
	// Dev: no key deposit. A real testnet sets this above the ED so registering session keys
	// (`set_keys`) costs something — anti-spam on the validator-candidate registry.
	type KeyDeposit = ConstU128<0>;
}

/// Configure pallet-validator-set (M6, DR-26): the mutable Aura+GRANDPA validator set. `add_validator`
/// / `remove_validator` are gated by the SAME `AuthorityOrigin` as the M5 crown jewels (sudo OR the
/// 3-of-5 FollowerCommittee) — one operator committee governs identity, weight, anchoring, AND who
/// produces blocks (the split into a separate validator committee is a documented graduation step,
/// `L3-chain.md` §8.3).
///
/// ## `MinAuthorities` is a finality-safety parameter, not just an anti-zero guard
/// The floor stops `remove_validator` ever stranding the chain at zero authorities — but it ALSO
/// bounds how far the committee can shrink the BFT set. It is DELIBERATELY `1` for the small
/// single-/dual-operator preprod testnet (a higher floor would lock the operator out of removing a
/// validator on a set already at the floor). It does NOT make finality safe at low counts: GRANDPA
/// tolerates `f` faults only at `3f+1` authorities, so a 1–3 authority set can stall finality with one
/// offline node (`L3-chain.md` §8.1).
///
/// ⚠ MAINNET PREREQUISITE: a value-bearing / public multi-validator launch MUST raise this to at
/// least `3f+1` for the target fault tolerance (≥`4` to tolerate one Byzantine/offline authority), in
/// lockstep with the im-online auto-removal wiring. Do not ship `1` to a network meant to be BFT.
impl pallet_validator_set::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type AddRemoveOrigin = AuthorityOrigin;
	// Deliberate testnet floor — see the ⚠ MAINNET PREREQUISITE note above before raising/shipping.
	type MinAuthorities = ConstU32<1>;
	// validators-3: MUST equal (or be below) aura/grandpa `MaxAuthorities` (= 32) so a full set never
	// gets silently truncated at a session rotation. `add_validator` rejects growth past this.
	type MaxValidators = ConstU32<32>;
	type WeightInfo = pallet_validator_set::weights::SubstrateWeight<Runtime>;
}

/// Configure pallet-talk-stake (M2c): the per-account weight source for the talk-capacity
/// meter. v1 dev = the operator sets weight by sudo (`EnsureRoot`, the DR-07 escape hatch);
/// Cardano-sourced weight via the follower is M2d, and the widen to a k-of-t FollowerOrigin
/// is signature-free (it stays an `EnsureOrigin`).
impl pallet_talk_stake::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	// DR-07: root/sudo OR the 3-of-5 FollowerCommittee (was bare `EnsureRoot`).
	type SetStakeOrigin = AuthorityOrigin;
	// stake-1: the max lockable lovelace — total ADA supply is 45e9 ADA = 45e15 lovelace, so no
	// account can back more than 45_000_000_000_000_000. Bounds a follower/committee bug from
	// writing an absurd weight (the capacity meter already saturates; this is defence-in-depth).
	type MaxStakeWeight = ConstU128<45_000_000_000_000_000>;
	// Voting power = the total Cardano stake of a bound stake credential; its ceiling is also the
	// whole ADA supply (45e15 lovelace). Distinct constant from MaxStakeWeight (which bounds one
	// vault's lock) so the two weights can diverge without coupling.
	type MaxVotingPower = ConstU128<45_000_000_000_000_000>;
	type WeightInfo = pallet_talk_stake::weights::SubstrateWeight<Runtime>;
}

/// The feeless fee-waiver pallet: makes `#[pallet::feeless_if]` calls skip
/// `ChargeTransactionPayment` (wired via `SkipCheckIfFeeless` in `TxExtension`, see lib.rs).
impl pallet_skip_feeless_payment::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
}

parameter_types! {
	// ── Talk-capacity constants (M2c) — DEV-TUNED for a snappy, watchable showcase. All are
	//    runtime-tunable (ECONOMICS §4.4); the real v1 ~5h regen window (DR-10) is a constant
	//    change for mainnet. Units are "micro-capacity"; one post ≈ BaseCost.
	//
	//    With these values, a grant of weight 10_000_000 (≈10 ADA in lovelace) yields:
	//      cap  = min(weight·50, Ceiling) = 5·10^8  ≈ 10 posts (burst)
	//      rate = weight·2                = 2·10^7 / block ≈ 1 post / 2.5 blocks (~15s)
	//      empty→full = cap/rate ≈ 25 blocks (~2.5 min)
	//    A 512-byte post costs BaseCost + 512·PerByteCost ≈ 1.5 posts of capacity.
	pub const CapRatio: u128 = 50;
	pub const RegenPerBlock: u128 = 2;
	pub const Ceiling: u128 = 5_000_000_000_000; // ~100k posts — present but won't bite dev grants
	pub const BaseCost: u128 = 50_000_000;        // 1 post
	pub const PerByteCost: u128 = 50_000;
	// A profile write (set/clear/pin/unpin) is feeless but capacity-metered at this STEEP price —
	// ≈10 posts (10 × BaseCost). Profiles are a low-frequency mutable overwrite, so a high capacity
	// cost is the anti-spam: only the identity-bound owner can edit, and they cannot churn it. The
	// whole app stays feeless (a freshly-derived posting key never needs funding).
	pub const ProfileCost: u128 = 500_000_000;    // 10 × BaseCost
}

/// Prices `pallet-profile`'s feeless writes against microblog's ONE per-account capacity battery — the
/// [`pallet_microblog::ForeignCapacityCost`] seam that lets the profile pallet share the feeless+capacity
/// machinery without microblog ever naming the profile crate (no Cargo cycle). Every profile call costs
/// the flat `ProfileCost`; any other call is `None` (unpriced ⇒ untouched by the capacity gate).
pub struct ProfileCapacityCost;
impl pallet_microblog::ForeignCapacityCost<RuntimeCall> for ProfileCapacityCost {
	fn cost(call: &RuntimeCall) -> Option<u128> {
		match call {
			RuntimeCall::Profile(_) => Some(ProfileCost::get()),
			_ => None,
		}
	}
}

/// Configure pallet-microblog (M2c: feeless, capacity-metered posting; capacity folded in,
/// DR-24). MaxLength = 512 / MaxPostsPerAuthor = 10_000 are the decided v1 baselines (DR-10b);
/// post ids are u64 (DR-21). Real benchmarked WeightInfo is DR-05 (a later milestone). The
/// `ForceOrigin` (sudo in dev) lets the operator prime/pre-charge a battery before the Cardano
/// weight source (M2d) is wired; the future gate's `link_identity` will call `on_first_bind`.
impl pallet_microblog::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type MaxLength = ConstU32<512>;
	type MaxPostsPerAuthor = ConstU32<10_000>;
	type CapRatio = CapRatio;
	type RegenPerBlock = RegenPerBlock;
	type Ceiling = Ceiling;
	type BaseCost = BaseCost;
	type PerByteCost = PerByteCost;
	// Per-action costs for the social engagement calls, all drawn from the SAME single talk-capacity
	// battery as posting. DEV-tuned relative to BaseCost (= 50_000_000, one post): a vote/repost ≈
	// 0.4 of a post, a follow ≈ 0.2. (quote_post reuses `post_cost`, so it has no constant here.)
	type VoteCost = ConstU128<20_000_000>;
	type RepostCost = ConstU128<20_000_000>;
	type FollowCost = ConstU128<10_000_000>;
	// Poll bounds: up to 4 options, each up to 80 bytes (the question reuses MaxLength = 512).
	type MaxPollOptions = ConstU32<4>;
	type MaxPollOptionLen = ConstU32<80>;
	// DR-07: root/sudo OR the 3-of-5 FollowerCommittee (was bare `EnsureRoot`).
	type ForceOrigin = AuthorityOrigin;
	// M2: gate posting on a live Cardano-identity binding (the anti-Sybil anchor).
	type IdentityGate = CognoGate;
	// Profile pallet's feeless writes share this one battery, priced at `ProfileCost` and gated at the
	// pool by `CheckCapacity` — so the whole app is feeless with no second transaction-extension.
	type ForeignCost = ProfileCapacityCost;
	type WeightInfo = pallet_microblog::weights::SubstrateWeight<Runtime>;
}

/// Configure pallet-cogno-gate (M2): the 1:1 Cardano-owner-Address ↔ posting-account binding —
/// the anti-Sybil identity anchor. `link_identity`/`revoke` are written by the trusted
/// Cogno-Follower; in v1 dev that authority is sudo (`EnsureRoot`, the DR-07 escape hatch), so
/// the showcase is fully drivable on-chain before the Cardano follower is wired. The
/// `EnsureOrigin` shape means the widen to a k-of-t committee (D2) is signature-free. `OnBind`
/// is the first-bind hook into microblog (primes the capacity row + provider ref at link).
///
/// D1 (trustless identity): `link_identity_signed` is the PERMISSIONLESS self-proof bind — the runtime
/// verifies a CIP-8 wallet signature on-chain (`pallet_cogno_gate::cip8`), so no `FollowerOrigin` trust
/// is needed to create a binding. `FollowerOrigin` now only gates `revoke` (the moderation ban, which
/// tombstones permanently). `CardanoNetwork = 0` (testnet — the live preprod addresses). ⚠ MAINNET
/// PREREQUISITE: the verifier has NOT had a formal external audit (see `cip8` module docs).
impl pallet_cogno_gate::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	// DR-07: root/sudo OR the 3-of-5 FollowerCommittee (was bare `EnsureRoot`) — gates `revoke` only.
	type FollowerOrigin = AuthorityOrigin;
	type OnBind = Microblog;
	// The Cardano network the on-chain self-proof binds for: 0 = testnet (live preprod), 1 = mainnet.
	type CardanoNetwork = ConstU8<0>;
	type WeightInfo = pallet_cogno_gate::weights::SubstrateWeight<Runtime>;
}

/// Configure pallet-anchor (M3, Tier-A: the Cardano WRITE link). Records the Anchor Relayer's
/// confirmed checkpoints (finalized state-root → Cardano metadata txhash) via `anchor_ack`. The
/// `AnchorOrigin` is the trusted relayer; in v1 dev that authority is sudo (`EnsureRoot`, the
/// DR-07 escape hatch), so the relayer can ack via `Sudo.sudo(anchor_ack {..})` exactly as the
/// follower drives `set_stake`/`link_identity`. Evidence, not enforcement (DR-20); the
/// `EnsureOrigin` shape keeps the widen to a k-of-t committee signature-free.
impl pallet_anchor::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	// DR-07: root/sudo OR the 3-of-5 FollowerCommittee (was bare `EnsureRoot`).
	type AnchorOrigin = AuthorityOrigin;
	type WeightInfo = pallet_anchor::weights::SubstrateWeight<Runtime>;
}

/// Beacon → bound account adapter for pallet-cardano-observer: the beacon name IS the cogno-gate
/// `AccountOf` key (the 32-byte L1 beacon `token_name`), so the in-runtime lookup is a direct read.
pub struct BeaconLookup;
impl pallet_cardano_observer::BeaconResolver<AccountId> for BeaconLookup {
	fn resolve(beacon: &[u8; 32]) -> Option<AccountId> {
		pallet_cogno_gate::AccountOf::<Runtime>::get(beacon)
	}
}

/// Weight-application adapter for pallet-cardano-observer: set the talk-stake weight (writes ONLY
/// `AllowedStake`, going-forward-only) and ensure the relock-safe microblog capacity row exists. The
/// lazy capacity meter reads the live weight, so `cap`/`rate` follow it and `weight = 0` collapses
/// capacity on the next read — deliberately NO per-block refill (that would defeat the spam meter).
pub struct WeightApply;
impl pallet_cardano_observer::WeightSink<AccountId> for WeightApply {
	fn set_weight(who: &AccountId, weight: u128) {
		pallet_talk_stake::Pallet::<Runtime>::apply_weight(who, weight);
		pallet_microblog::Pallet::<Runtime>::on_first_bind(who);
	}
}

/// Stake credential → bound account adapter: the 28-byte stake credential IS the cogno-gate
/// `AccountOfStakeCred` key (the proven reward-address key hash), so the lookup is a direct read.
pub struct StakeLookup;
impl pallet_cardano_observer::StakeResolver<AccountId> for StakeLookup {
	fn resolve(stake_cred: &[u8; 28]) -> Option<AccountId> {
		pallet_cogno_gate::AccountOfStakeCred::<Runtime>::get(stake_cred)
	}
}

/// The set of bound stake credentials, for the node-side IDP (via the `CardanoObserverApi`): enumerate
/// the cogno-gate `AccountOfStakeCred` keys at the parent block's state.
pub struct BoundStakeCreds;
impl pallet_cardano_observer::BoundStakeCredentials for BoundStakeCreds {
	fn bound_stake_credentials() -> alloc::vec::Vec<[u8; 28]> {
		pallet_cogno_gate::AccountOfStakeCred::<Runtime>::iter_keys().collect()
	}
}

/// Voting-power-application adapter: write the talk-stake `VotingPower` (the total-stake VOTE weight).
/// Distinct from `WeightApply` (which sets the locked-ADA `AllowedStake` deposit weight + primes the
/// microblog capacity row) — voting power touches neither capacity nor `AllowedStake`.
pub struct VotingPowerApply;
impl pallet_cardano_observer::VotingPowerSink<AccountId> for VotingPowerApply {
	fn set_voting_power(who: &AccountId, weight: u128) {
		pallet_talk_stake::Pallet::<Runtime>::apply_voting_power(who, weight);
	}
}

/// The Cardano stability window (3k/f = the no-rollback horizon), as a deliberate **TESTNET vs MAINNET
/// split** — exactly like `MinAuthorities = 1` / the single-validator testnet set: run the relaxed value
/// while testing here, flip to the production value before mainnet. The flip is a one-line, ENCODING-NEUTRAL
/// change (it only widens the as-of reference lag — no Call/storage/event change, no spec bump), gated as a
/// ⚠ MAINNET PREREQUISITE, NOT a bug. Co-sequence it with the ≥3-producer cutover; at the mainnet depth
/// db-sync must retain history back to the reference (docs/IN-PROTOCOL-OBSERVATION.md §5.2/§15.3).
const STABILITY_SLOTS_TESTNET: u64 = 600; // ≈ 10 min — prompt PoC observability on this testnet
/// The production value: 3k/f = 129_600 slots ≈ 36 h (mainnet/preprod k=2160, f=0.05). Ready + named; the
/// mainnet cutover flips `ObsStabilitySlots` below from `_TESTNET` to `_MAINNET`. (Held unused until then.)
#[allow(dead_code)]
const STABILITY_SLOTS_MAINNET: u64 = 129_600;

parameter_types! {
	// ⚠ MAINNET PREREQUISITE: flip STABILITY_SLOTS_TESTNET -> STABILITY_SLOTS_MAINNET before any
	// mainnet/real-value deployment (a smaller window is permitted ONLY on a labeled dev/testnet; see the
	// split doc above + docs/IN-PROTOCOL-OBSERVATION.md §5.2). Selected = TESTNET while we test here.
	pub const ObsStabilitySlots: u64 = STABILITY_SLOTS_TESTNET;
	// ⚠ PREPROD Shelley anchor (we are live there) — NOT Byron `systemStart` (1654041600). The Shelley
	// era begins at slot 86400 / unix 1655769600 after a 20-day Byron prefix. Verify the MAINNET anchor
	// against its genesis before any mainnet cutover.
	pub const ObsShelleyStartUnix: u64 = 1_655_769_600;
	pub const ObsShelleyStartSlot: u64 = 86_400;
	// The L1 `min_lock` floor (lovelace); below it, observed lovelace maps to weight 0.
	pub const ObsMinLock: u128 = 100_000_000;
	// The live `talk_vault` policy id (== vault script hash, contracts/vault.json:
	// 168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7). Consensus-pinned; the node reads it via
	// the CardanoObserverApi so every node queries the SAME Cardano policy. ⚠ moving the live contract
	// hash orphans the M8 vault — if contracts change, update this to match the new applied vault hash.
	pub const ObsVaultPolicyId: [u8; 28] = [
		0x16, 0x8a, 0x97, 0x10, 0xe9, 0x91, 0xb7, 0x68, 0x42, 0x6b, 0x58, 0x01, 0x1f, 0xeb,
		0xec, 0x0f, 0xa3, 0xc5, 0xff, 0x6b, 0xeb, 0x49, 0x06, 0x5c, 0xc5, 0x24, 0x89, 0xc7,
	];
}

/// Configure pallet-cardano-observer (in-protocol-observation, the D4 weight rung). Sets talk-stake
/// weight from a consensus-verified Cardano observation INHERENT — every importing validator re-derives
/// the read and rejects the block on mismatch — instead of the trusted off-chain `set_stake` write.
///
/// ADDITIVE / SHADOW until cutover: the node-side `InherentDataProvider` is wired (every block carries +
/// `check_inherent`-verifies the Cardano read), but `EnforceWeight` defaults to `false` (shadow), so the
/// verified observation is only PROJECTED into `cardanoObserver::ShadowStake` — it does not write
/// `AllowedStake`. The committee `set_stake` path still drives weight; the off-chain shadow-diff
/// (`services/committee/shadow-diff.mjs`) proves the two agree on real preprod data. Flipping
/// `set_enforcement(true)` (the cutover) is gated on ≥3 independent producers (a later step).
///
/// ⚠ MAINNET PREREQUISITE: `check_inherent`'s "every producer re-derives" is load-bearing only with
/// MULTIPLE independent producers — on a single operator this is "D4-SHAPED, not D4-TRUST"; and every
/// validator must run cardano-node + Cardano db-sync. See docs/IN-PROTOCOL-OBSERVATION.md §2/§8/§11.
impl pallet_cardano_observer::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	// Max identities observed per block (bounds the inherent body + `LastObserved`).
	type MaxObserved = ConstU32<1024>;
	// The same `stake-1` ceiling as talk-stake (max lockable lovelace = total ADA supply). An entry
	// above it is SKIPPED by the observer (never bricks the Mandatory block), not rejected.
	type MaxStakeWeight = ConstU128<45_000_000_000_000_000>;
	type MinLock = ObsMinLock;
	type StabilitySlots = ObsStabilitySlots;
	type ShelleyStartUnix = ObsShelleyStartUnix;
	type ShelleyStartSlot = ObsShelleyStartSlot;
	type VaultPolicyId = ObsVaultPolicyId;
	// Voting power = total Cardano stake; its ceiling is also the whole ADA supply. Over-cap entries are
	// SKIPPED (never brick the Mandatory block), like MaxStakeWeight for the vault.
	type MaxVotingPower = ConstU128<45_000_000_000_000_000>;
	// Read epoch_stake 1 epoch before the reference's epoch — a fully-closed (immutable) snapshot, and the
	// ~2-epoch manipulation-resistant lag Cardano itself uses (CIP-1694 voting power).
	type StakeEpochLookback = ConstU64<1>;
	type BeaconResolver = BeaconLookup;
	type StakeResolver = StakeLookup;
	type WeightSink = WeightApply;
	type VotingPowerSink = VotingPowerApply;
	// DR-07: root/sudo OR the 3-of-5 FollowerCommittee gates the enforce/shadow cutover flip — the same
	// crown-jewel origin as set_stake/link_identity/anchor_ack. Default is SHADOW (EnforceWeight=false):
	// the inherent verifies + projects but does not write weight; the committee set_stake stays the sole
	// writer until the gated, multi-producer cutover (D4-SHAPED, IN-PROTOCOL-OBSERVATION.md §2/§9).
	type EnforceOrigin = AuthorityOrigin;
	// pallet-timestamp implements `UnixTime` — the block's consensus clock for the stability sanity bound.
	type UnixTime = Timestamp;
	type WeightInfo = ();
}

/// Configure pallet-profile (social-actions branch): the mutable per-account display profile. Gated
/// on a live Cardano-identity binding via the SAME `IsAllowed` trait microblog posting uses
/// (`IdentityGate = CognoGate`). `set_profile`/`clear_profile` are FEE-BEARING (the tx fee is the
/// anti-spam for this low-frequency call), so no second capacity extension is wired — feeless +
/// capacity-metering stays reserved for the high-frequency microblog social writes. The avatar is a
/// URL / IPFS CID reference (`MaxAvatar` bytes), NOT image bytes.
impl pallet_profile::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type IdentityGate = CognoGate;
	type MaxName = ConstU32<64>;
	type MaxBio = ConstU32<256>;
	type MaxAvatar = ConstU32<128>;
	type MaxBanner = ConstU32<256>;
	type MaxLocation = ConstU32<64>;
	type MaxWebsite = ConstU32<256>;
	type WeightInfo = pallet_profile::weights::SubstrateWeight<Runtime>;
}
