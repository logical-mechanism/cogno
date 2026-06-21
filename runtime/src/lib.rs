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
	// 106 -> 107 for M7 (ops cleanup): dropped the unused `pallet-template` (@7, the M0 scaffold).
	// Removing a pallet from construct_runtime changes the metadata — encoding-affecting; regen the
	// PAPI descriptors. transaction_version is UNCHANGED (no TxExtension change). The on-wire pallet
	// indices 8..15 are UNCHANGED (FRAME allows index gaps; only @7 is vacated).
	// 107 -> 108: two independent branches each developed against 108, folded together here (see the
	// 108 -> 109 merge note below).
	//   • D1 (trustless identity): added the permissionless `cogno_gate::link_identity_signed` call
	//     (@8 call_index 2 — on-chain CIP-8 ed25519 self-proof) + the `Tombstoned` storage + the
	//     `CardanoNetwork` constant + new error variants. New call/storage/constant — encoding-affecting.
	//     The new call is a normal signed extrinsic, so transaction_version is UNCHANGED.
	//   • in-protocol-observation (D4): added pallet-cardano-observer (@16) — the `ProvideInherent`
	//     pallet that sets talk-stake weight from a consensus-verified Cardano observation inherent.
	//     New pallet + Mandatory `observe` call + storage (LastReference/LastObserved) + event —
	//     encoding-affecting. `observe` is an INHERENT (not a signed extrinsic), so transaction_version
	//     is UNCHANGED. ADDITIVE/shadow: inert until the node-side InherentDataProvider is wired; the
	//     committee `set_stake` path still drives weight.
	// 108 -> 109 (merge): both PRs above independently claimed spec 108, so the runtime that carries
	// BOTH (the trustless gate AND the cardano-observer pallet) bumps to 109 to give the combined
	// metadata a distinct version. New pallet + new call/storage relative to either branch alone —
	// encoding-affecting; regen the PAPI descriptors. transaction_version is UNCHANGED (no TxExtension
	// change on either branch).
	// 109 -> 110 (cardano-observer hardening): the `observe` inherent gained an `inputs_commitment:
	// [u8;32]` arg (the partner-chains `selection_inputs_hash` analog) and a third `InherentError`
	// variant (`ComputeDiverged`), so `check_inherent` can tell "saw different Cardano data" apart from
	// "reduced the same data differently". The `observe` Call encoding changed — encoding-affecting,
	// regen the PAPI descriptors. `observe` is still an INHERENT, so transaction_version is UNCHANGED.
	// 110 -> 111 (in-protocol-observation §15.3 / Midnight delta A.1): the header-sealed "McHash"
	// stable-block reference. `CardanoRef.block_hash` is now the SEALED anchor — the header hash of the
	// latest stable Cardano block ≤ the reference (the deterministic db-sync `block` at/before slot) —
	// instead of a node-local tip
	// diagnostic, and `check_inherent` now RE-VALIDATES it cross-node (a forged/regressing anchor ⇒
	// Mismatch). The custom block proposer also seals it into each block HEADER as a `cobs` PreRuntime
	// digest (external auditability). This is a CONSENSUS-VALIDITY change (a new block-import rejection
	// rule), NOT an encoding change: `CardanoRef` already carried `block_hash`, so the `observe`
	// Call/storage/event encoding is UNCHANGED and the PAPI/indexer/frontend metadata is byte-identical —
	// the bump exists to signal the REQUIRED LOCKSTEP node upgrade (an old author's tip-hash anchor would
	// be fatally rejected by a new importer). `observe` is still an INHERENT, so transaction_version is
	// UNCHANGED. Architecture A: the header digest is auditability; the load-bearing importer
	// re-validation rides `check_inherent` (no import_queue/start_aura fork). D4-SHAPED, not D4-TRUST —
	// load-bearing only with ≥3 independent producers, co-sequenced with the enforcement cutover.
	// 111 -> 112 (social actions, chain-first): microblog gained the engagement calls — `quote_post`
	// (@3), stake-weighted `vote`/`clear_vote` (@4/@5), permanent `repost` (@6), `follow`/`unfollow`
	// (@7/@8) — plus the `Post.quote` field, new storage (Votes/VoteTally/Reposts/RepostCount/
	// Following/Follower+FollowingCount), per-action cost constants, and REMOVED `delete_post`
	// (@1 permanently vacant; content is append-only). Added pallet-profile (@17, mutable display
	// profile; fee-bearing `set_profile`). The `Post.quote` field RE-ENCODES `Posts`, so this ships
	// the project's FIRST storage migration: microblog now declares `#[pallet::storage_version(1)]`
	// and a v0->v1 `VersionedMigration` is wired into `SingleBlockMigrations`. Encoding-affecting
	// (calls/storage/struct field/constants/new pallet) — regen the PAPI descriptors + indexer
	// mappings. transaction_version is UNCHANGED (2): the `TxExtension` tuple is byte-identical —
	// the new feeless calls ride the existing `CheckCapacity` (only its internal match arms grew),
	// and `set_profile` is a plain fee-bearing signed extrinsic.
	// 112 -> 113 (polls + pinned post): microblog gained `create_poll` (@9) + `cast_poll_vote` (@10)
	// — a stake-weighted poll is a normal post (the question) plus a `Polls`/`PollVotes`/`PollTally`
	// side-record; pallet-profile gained `pin_post` (@2) + `unpin_post` (@3) + a `PinnedPost` map.
	// All ADDITIVE storage/calls/constants (NO Post/Profile struct change) — so NO new migration;
	// encoding-affecting, so regen the PAPI descriptors + indexer mappings. The new microblog calls
	// ride the existing CheckCapacity (feeless); pin/unpin are fee-bearing. transaction_version is
	// UNCHANGED (2) — the TxExtension tuple is byte-identical.
	// 113 -> 114 (stake-key voting power): the franken-address fix. Voting/poll weight is now the
	// voter's TOTAL Cardano stake (the `epoch_stake` snapshot of a PROVEN stake credential), not the
	// locked-ADA posting deposit. cogno-gate gained `link_stake_signed` (@3, a stake-key CIP-8 self-proof
	// over the wallet's reward address) + the 1:1 stake-credential anchor storage (StakeCredOf/
	// AccountOfStakeCred/TombstonedStakeCred), the `StakeLinked` event, and four new errors; `revoke` now
	// also tombstones the bound stake credential (ban-the-key). talk-stake gained `set_voting_power` (@1)
	// + the `VotingPower` map + `VotingPowerSet` event + `VotingPowerTooHigh` error + the `MaxVotingPower`
	// config bound. microblog `vote`/`cast_poll_vote` now read `VotingPower` instead of `AllowedStake`
	// (posting capacity still reads `AllowedStake`) — the Call/struct ENCODING is unchanged, only the
	// storage they read. All ADDITIVE storage/calls/constants (NO struct re-encode) — so NO new migration.
	// Encoding-affecting (new calls/storage/events/errors) — regen the PAPI descriptors. The new calls are
	// normal signed extrinsics, so transaction_version is UNCHANGED (2).
	// 114 -> 115 (trustless voting power): the cardano-observer inherent now ALSO observes, per BOUND stake
	// credential, its total Cardano stake (the `epoch_stake` snapshot) and projects it to talk-stake
	// `VotingPower` — the trustless replacement for the committee `set_voting_power` path. `CardanoObservation`
	// + the `observe` inherent Call gained a `stake_entries` field (encoding-affecting → regen PAPI), the
	// `CardanoObserverApi` gained `bound_stake_credentials()`, the `ObserverConfig` a `stake_epoch_lookback`,
	// and the pallet new storage (`ShadowVotingPower`/`LastObservedStake`) + a `VotingPowerObserved` event.
	// Runs in SHADOW (the existing `EnforceWeight` flag also gates voting power): the inherent verifies +
	// projects but the committee `set_voting_power` stays the writer until the ≥3-producer cutover. `observe`
	// is still an INHERENT, so transaction_version is UNCHANGED (2).
	spec_version: 115,
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
	// (i.e. `post_message`) skip the fee. Feeless is per-call, not chain-wide — `set_profile`
	// (the microblog social writes post_message/quote_post/vote/clear_vote/repost/follow/unfollow
	// are feeless) and everything else stays fee-bearing. (Metadata-invisible: PAPI sees plain payment.)
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

	// (Index 7 is vacant: the M0 `pallet-template` scaffold was dropped in M7. FRAME allows index
	// gaps, so vacating @7 leaves the on-wire indices 8..15 unchanged.)

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
	// the opaque SessionKeys; changes apply at session boundaries (~2 sessions).
	#[runtime::pallet_index(15)]
	pub type Session = pallet_session;

	// 16 = CardanoObserver (in-protocol-observation, the D4 weight rung): sets talk-stake weight from a
	// consensus-verified Cardano observation INHERENT (`ProvideInherent`; every importing validator
	// re-derives the read and rejects the block on mismatch) instead of the trusted off-chain
	// `set_stake` write. Declared AFTER Timestamp (@1) and CognoGate (@8), which its Mandatory inherent
	// reads (block time for the stability bound; `AccountOf` for beacon→account). ADDITIVE / shadow:
	// inert until the node-side InherentDataProvider is wired (a later step); the committee `set_stake`
	// path keeps driving weight until cutover. Next free index 17.
	#[runtime::pallet_index(16)]
	pub type CardanoObserver = pallet_cardano_observer;

		// 17 = Profile (social-actions branch): the mutable per-account display profile (name/bio/
		// avatar). `set_profile` is identity-gated via the microblog `IsAllowed` trait (CognoGate)
		// and FEE-BEARING (low-frequency — the tx fee is its own anti-spam, so no second capacity
		// extension is needed and transaction_version is unaffected). A separate pallet keeps the
		// security-sensitive identity verifier and the feeless hot path lean. Next free index 18.
		#[runtime::pallet_index(17)]
		pub type Profile = pallet_profile;
}
