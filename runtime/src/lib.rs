#![cfg_attr(not(feature = "std"), no_std)]

#[cfg(feature = "std")]
include!(concat!(env!("OUT_DIR"), "/wasm_binary.rs"));

pub mod apis;
#[cfg(feature = "runtime-benchmarks")]
mod benchmarks;
pub mod configs;

extern crate alloc;
use alloc::vec::Vec;
use sp_runtime::{
	generic, impl_opaque_keys,
	traits::{BlakeTwo256, IdentifyAccount, Verify},
	MultiAddress, MultiSignature,
};
#[cfg(feature = "std")]
use sp_version::NativeVersion;
use sp_version::RuntimeVersion;

pub use frame_system::Call as SystemCall;
pub use pallet_balances::Call as BalancesCall;
pub use pallet_timestamp::Call as TimestampCall;
#[cfg(any(feature = "std", test))]
pub use sp_runtime::BuildStorage;

pub mod genesis_config_presets;

/// Opaque types. These are used by the CLI to instantiate machinery that don't need to know
/// the specifics of the runtime. They can then be made to be agnostic over specific formats
/// of data like extrinsics, allowing for them to continue syncing the network through upgrades
/// to even the core data structures.
pub mod opaque {
	use super::*;
	use sp_runtime::{
		generic,
		traits::{BlakeTwo256, Hash as HashT},
	};

	pub use sp_runtime::OpaqueExtrinsic as UncheckedExtrinsic;

	/// Opaque block header type.
	pub type Header = generic::Header<BlockNumber, BlakeTwo256>;
	/// Opaque block type.
	pub type Block = generic::Block<Header, UncheckedExtrinsic>;
	/// Opaque block identifier type.
	pub type BlockId = generic::BlockId<Block>;
	/// Opaque block hash type.
	pub type Hash = <BlakeTwo256 as HashT>::Output;
}

impl_opaque_keys! {
	pub struct SessionKeys {
		pub aura: Aura,
		pub grandpa: Grandpa,
	}
}

// To learn more about runtime versioning, see:
// https://docs.substrate.io/main-docs/build/upgrade#runtime-versioning
#[sp_version::runtime_version]
pub const VERSION: RuntimeVersion = RuntimeVersion {
	spec_name: alloc::borrow::Cow::Borrowed("cogno-chain-runtime"),
	impl_name: alloc::borrow::Cow::Borrowed("cogno-chain-runtime"),
	authoring_version: 1,
	// The version of the runtime specification. A full node will not attempt to use its native
	//   runtime in substitute for the on-chain Wasm runtime unless all of `spec_name`,
	//   `spec_version`, and `authoring_version` are the same between Wasm and native.
	// This value is set to 100 to notify Polkadot-JS App (https://polkadot.js.org/apps) to use
	//   the compatible custom types.
	// Bumped 100 -> 101 for M0 (added pallet-microblog @ 10). 101 -> 102 for M2c: added
	// pallet-talk-stake (@9) + pallet-skip-feeless-payment (@11), folded talk-capacity +
	// feeless `post_message` into microblog (new storage/calls/constants — encoding-affecting).
	// 102 -> 103 for M2: added pallet-cogno-gate (@8, the CIP-8 identity gate) + the
	// `IdentityGate` (NotAllowed) check on `post_message` (new storage/calls/error variant —
	// encoding-affecting). transaction_version is UNCHANGED (no TxExtension change).
	// 103 -> 104 for M3: added pallet-anchor (@12, the Tier-A Cardano WRITE link) with the
	// `anchor_ack` call + `LastCheckpoint` storage (new pallet/calls/storage — encoding-affecting;
	// regen the PAPI descriptors). transaction_version is UNCHANGED (no TxExtension change).
	// 104 -> 105 for M5 (DR-07): added pallet-collective (@13, FollowerCommittee Instance1) — the
	// mutable 3-of-5 k-of-t committee that backs the crown-jewel authority origins (FollowerOrigin
	// / SetStakeOrigin / AnchorOrigin / ForceOrigin) alongside the retained EnsureRoot/sudo dev
	// fallback. New pallet + calls/storage/events — encoding-affecting; regen the PAPI descriptors.
	// (DR-05 real benchmarked WeightInfo replaced the placeholders too, but weights are not
	// encoding-affecting.) transaction_version is UNCHANGED (no TxExtension change).
	// 105 -> 106 for M6 (DR-26): MUTABLE Aura+GRANDPA authorities. Added pallet-session (@15) +
	// pallet-validator-set (@14, the SessionManager). Aura/GRANDPA now derive authorities from the
	// session each rotation instead of from static genesis; add_validator/remove_validator (gated
	// by the M5 AuthorityOrigin) queue a change applied at a session boundary. New pallets +
	// calls/storage/events — encoding-affecting; regen the PAPI descriptors. transaction_version is
	// UNCHANGED (no TxExtension change — pallet-session's set_keys/purge_keys are plain calls).
	spec_version: 106,
	impl_version: 1,
	apis: apis::RUNTIME_API_VERSIONS,
	// Bumped 1 -> 2: the `CheckCapacity` transaction extension was added to `TxExtension`
	// (the signed-extension set changed → the extrinsic format version changes).
	transaction_version: 2,
	system_version: 1,
};

mod block_times {
	/// This determines the average expected block time that we are targeting. Blocks will be
	/// produced at a minimum duration defined by `SLOT_DURATION`. `SLOT_DURATION` is picked up by
	/// `pallet_timestamp` which is in turn picked up by `pallet_aura` to implement `fn
	/// slot_duration()`.
	///
	/// Change this to adjust the block time.
	pub const MILLI_SECS_PER_BLOCK: u64 = 6000;

	// NOTE: Currently it is not possible to change the slot duration after the chain has started.
	// Attempting to do so will brick block production.
	pub const SLOT_DURATION: u64 = MILLI_SECS_PER_BLOCK;
}
pub use block_times::*;

// Time is measured by number of blocks.
pub const MINUTES: BlockNumber = 60_000 / (MILLI_SECS_PER_BLOCK as BlockNumber);
pub const HOURS: BlockNumber = MINUTES * 60;
pub const DAYS: BlockNumber = HOURS * 24;

pub const BLOCK_HASH_COUNT: BlockNumber = 2400;

// Unit = the base number of indivisible units for balances
pub const UNIT: Balance = 1_000_000_000_000;
pub const MILLI_UNIT: Balance = 1_000_000_000;
pub const MICRO_UNIT: Balance = 1_000_000;

/// Existential deposit.
pub const EXISTENTIAL_DEPOSIT: Balance = MILLI_UNIT;

/// The version information used to identify this runtime when compiled natively.
#[cfg(feature = "std")]
pub fn native_version() -> NativeVersion {
	NativeVersion { runtime_version: VERSION, can_author_with: Default::default() }
}

/// Alias to 512-bit hash when used in the context of a transaction signature on the chain.
pub type Signature = MultiSignature;

/// Some way of identifying an account on the chain. We intentionally make it equivalent
/// to the public key of our transaction signing scheme.
pub type AccountId = <<Signature as Verify>::Signer as IdentifyAccount>::AccountId;

/// Balance of an account.
pub type Balance = u128;

/// Index of a transaction in the chain.
pub type Nonce = u32;

/// A hash of some data used by the chain.
pub type Hash = sp_core::H256;

/// An index to a block.
pub type BlockNumber = u32;

/// The address format for describing accounts.
pub type Address = MultiAddress<AccountId, ()>;

/// Block header type as expected by this runtime.
pub type Header = generic::Header<BlockNumber, BlakeTwo256>;

/// Block type as expected by this runtime.
pub type Block = generic::Block<Header, UncheckedExtrinsic>;

/// A Block signed with a Justification
pub type SignedBlock = generic::SignedBlock<Block>;

/// BlockId type as expected by this runtime.
pub type BlockId = generic::BlockId<Block>;

/// The `TransactionExtension` to the basic transaction logic.
pub type TxExtension = (
	frame_system::AuthorizeCall<Runtime>,
	frame_system::CheckNonZeroSender<Runtime>,
	frame_system::CheckSpecVersion<Runtime>,
	frame_system::CheckTxVersion<Runtime>,
	frame_system::CheckGenesis<Runtime>,
	frame_system::CheckEra<Runtime>,
	frame_system::CheckNonce<Runtime>,
	frame_system::CheckWeight<Runtime>,
	// ⚑ M2c: the feeless-post spam gate. Runs at the pool BEFORE payment; over-budget
	// `post_message` → `ExhaustsResources`, capacity consumed at inclusion (pallet-microblog §5).
	pallet_microblog::CheckCapacity<Runtime>,
	// ⚑ M2c: wrap payment in `SkipCheckIfFeeless` so calls marked `#[pallet::feeless_if]`
	// (i.e. `post_message`) skip the fee. Feeless is per-call, not chain-wide — `delete_post`
	// and everything else stay fee-bearing. (Metadata-invisible: PAPI still sees plain payment.)
	pallet_skip_feeless_payment::SkipCheckIfFeeless<
		Runtime,
		pallet_transaction_payment::ChargeTransactionPayment<Runtime>,
	>,
	frame_metadata_hash_extension::CheckMetadataHash<Runtime>,
	frame_system::WeightReclaim<Runtime>,
);

/// Unchecked extrinsic type as expected by this runtime.
pub type UncheckedExtrinsic =
	generic::UncheckedExtrinsic<Address, RuntimeCall, Signature, TxExtension>;

/// The payload being signed in transactions.
pub type SignedPayload = generic::SignedPayload<RuntimeCall, TxExtension>;

/// Executive: handles dispatch to the various modules.
pub type Executive = frame_executive::Executive<
	Runtime,
	Block,
	frame_system::ChainContext<Runtime>,
	Runtime,
	AllPalletsWithSystem,
>;

// Create the runtime by composing the FRAME pallets that were previously configured.
#[frame_support::runtime]
mod runtime {
	#[runtime::runtime]
	#[runtime::derive(
		RuntimeCall,
		RuntimeEvent,
		RuntimeError,
		RuntimeOrigin,
		RuntimeFreezeReason,
		RuntimeHoldReason,
		RuntimeSlashReason,
		RuntimeLockId,
		RuntimeTask,
		RuntimeViewFunction
	)]
	pub struct Runtime;

	#[runtime::pallet_index(0)]
	pub type System = frame_system;

	#[runtime::pallet_index(1)]
	pub type Timestamp = pallet_timestamp;

	#[runtime::pallet_index(2)]
	pub type Aura = pallet_aura;

	#[runtime::pallet_index(3)]
	pub type Grandpa = pallet_grandpa;

	#[runtime::pallet_index(4)]
	pub type Balances = pallet_balances;

	#[runtime::pallet_index(5)]
	pub type TransactionPayment = pallet_transaction_payment;

	#[runtime::pallet_index(6)]
	pub type Sudo = pallet_sudo;

	// Include the custom logic from the pallet-template in the runtime.
	// (Kept at index 7 for M0; to be dropped in a later milestone.)
	#[runtime::pallet_index(7)]
	pub type Template = pallet_template;

	// ── cogno-chain app pallets ──
	// Indices are on-wire contracts (FRAME allows index gaps): 8 = CognoGate (M2, the CIP-8
	// identity gate / anti-Sybil anchor); 9 = TalkStake (M2c, the weight source); 10 = Microblog
	// (+ folded talk-capacity, DR-24); 11 = SkipFeelessPayment (the feeless fee-waiver pallet).
	#[runtime::pallet_index(8)]
	pub type CognoGate = pallet_cogno_gate;

	#[runtime::pallet_index(9)]
	pub type TalkStake = pallet_talk_stake;

	#[runtime::pallet_index(10)]
	pub type Microblog = pallet_microblog;

	#[runtime::pallet_index(11)]
	pub type SkipFeelessPayment = pallet_skip_feeless_payment;

	// 12 = Anchor (M3, the Tier-A Cardano WRITE link): records the relayer-confirmed
	// finalized-state-root → Cardano-metadata-txhash checkpoints. Records only, never
	// snapshots a root itself (PLAN §4.9). Next free index after SkipFeelessPayment.
	#[runtime::pallet_index(12)]
	pub type Anchor = pallet_anchor;

	// 13 = FollowerCommittee (M5, DR-07): the MUTABLE 3-of-5 k-of-t committee that backs the
	// crown-jewel authority origins (cogno-gate FollowerOrigin / talk-stake SetStakeOrigin /
	// anchor AnchorOrigin / microblog ForceOrigin) via `EnsureProportionAtLeast<3,5>`, with
	// `EnsureRoot`/sudo retained as the v1 dev fallback (`EitherOfDiverse`). Members are mutable
	// (rotation) via `Collective::set_members`; the proposal lifecycle events are the per-action
	// audit log. One shared instance. The `EnsureOrigin` widen is signature-free (call signatures
	// are unchanged). Next free index after Anchor.
	#[runtime::pallet_index(13)]
	pub type FollowerCommittee = pallet_collective<Instance1>;

	// 14 = ValidatorSet (M6, DR-26): the MUTABLE Aura+GRANDPA validator set (vendor-forked from
	// gautamdhameja/substrate-validator-set). It is pallet-session's SessionManager — each session
	// rotation it hands the current set to Aura/GRANDPA. `add_validator`/`remove_validator` are
	// gated by the M5 `AuthorityOrigin` (sudo OR 3-of-5 FollowerCommittee) and queued to a session
	// boundary. Declared BEFORE Session so its genesis seats `Validators` before Session's genesis
	// reads it via `SessionManager::new_session_genesis`.
	#[runtime::pallet_index(14)]
	pub type ValidatorSet = pallet_validator_set;

	// 15 = Session (M6, DR-26): drives Aura+GRANDPA authorities from the ValidatorSet SessionManager
	// instead of static genesis (the two are mutually exclusive — the aura/grandpa genesis is now
	// empty; authorities are seated through SessionConfig). `SessionHandler = (Aura, Grandpa)` via
	// the opaque SessionKeys; changes apply at session boundaries (~2 sessions). Next free index 16.
	#[runtime::pallet_index(15)]
	pub type Session = pallet_session;
}
