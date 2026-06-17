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
	traits::{ConstBool, ConstU128, ConstU32, ConstU64, ConstU8, VariantCountOf},
	weights::{
		constants::{RocksDbWeight, WEIGHT_REF_TIME_PER_SECOND},
		IdentityFee, Weight,
	},
};
use frame_system::{
	limits::{BlockLength, BlockWeights},
	EnsureRoot,
};
use pallet_transaction_payment::{ConstFeeMultiplier, FungibleAdapter, Multiplier};
use sp_consensus_aura::sr25519::AuthorityId as AuraId;
use sp_runtime::{traits::One, Perbill};
use sp_version::RuntimeVersion;

// Local module imports
use super::{
	AccountId, Aura, Balance, Balances, Block, BlockNumber, CognoGate, Hash, Microblog, Nonce,
	PalletInfo, Runtime, RuntimeCall, RuntimeEvent, RuntimeFreezeReason, RuntimeHoldReason,
	RuntimeOrigin, RuntimeTask, System, EXISTENTIAL_DEPOSIT, SLOT_DURATION, VERSION,
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

/// All migrations of the runtime, aside from the ones declared in the pallets.
///
/// This can be a tuple of types, each implementing `OnRuntimeUpgrade`.
#[allow(unused_parens)]
type SingleBlockMigrations = ();

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

/// Configure the pallet-template in pallets/template.
impl pallet_template::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type WeightInfo = pallet_template::weights::SubstrateWeight<Runtime>;
}

/// Configure pallet-talk-stake (M2c): the per-account weight source for the talk-capacity
/// meter. v1 dev = the operator sets weight by sudo (`EnsureRoot`, the DR-07 escape hatch);
/// Cardano-sourced weight via the follower is M2d, and the widen to a k-of-t FollowerOrigin
/// is signature-free (it stays an `EnsureOrigin`).
impl pallet_talk_stake::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type SetStakeOrigin = EnsureRoot<AccountId>;
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
	type ForceOrigin = EnsureRoot<AccountId>;
	// M2: gate posting on a live Cardano-identity binding (the anti-Sybil anchor).
	type IdentityGate = CognoGate;
	type WeightInfo = pallet_microblog::weights::SubstrateWeight<Runtime>;
}

/// Configure pallet-cogno-gate (M2): the 1:1 Cardano-owner-Address ↔ posting-account binding —
/// the anti-Sybil identity anchor. `link_identity`/`revoke` are written by the trusted
/// Cogno-Follower; in v1 dev that authority is sudo (`EnsureRoot`, the DR-07 escape hatch), so
/// the showcase is fully drivable on-chain before the Cardano follower is wired. The
/// `EnsureOrigin` shape means the widen to a k-of-t committee (D2) is signature-free. `OnBind`
/// is the first-bind hook into microblog (primes the capacity row + provider ref at link).
impl pallet_cogno_gate::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type FollowerOrigin = EnsureRoot<AccountId>;
	type OnBind = Microblog;
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
	type AnchorOrigin = EnsureRoot<AccountId>;
	type WeightInfo = pallet_anchor::weights::SubstrateWeight<Runtime>;
}
