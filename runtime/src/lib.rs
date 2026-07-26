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
    // Bump `spec_version` on any encoding-affecting change (calls, storage, events, metadata,
    // transaction extensions) or any change to consensus-visible behaviour that requires nodes to
    // upgrade in lockstep. Leave it alone for comments, bounds, logging and tests. The per-release
    // history lives in CHANGELOG.md, not here.
    // spec 205: dynamic stake voting — vote/poll storage v5 → v6 (stored weight dropped, `Poll.close_at`
    // + `PollResults` added, `close_poll` at call_index 13, `PollClosed` event/error, live weighted reads).
    // spec 207: governance polls — `RoleEntry`/`ObservedRole` gain a delegated-stake `weight` (observer
    // payload + roles storage v0 → v1), `Poll` gains `kind` (Stake | Governance, microblog storage v6 → v7),
    // and `poll()`'s `PollView`/`PollOptionView` gain the SPO + dRep chamber lenses.
    // spec 208: `close_poll` FREEZES a governance poll's SPO/dRep chambers into `PollResult` (four new
    // chamber-snapshot vecs, microblog storage v7 → v8), so a concluded poll's chambers no longer re-price
    // live. Storage/read-shape change only — `TxExtension` byte-identical, so `transaction_version` STAYS 5.
    // spec 209: governance-poll flavors — `PollKind` gains `Spo`/`Drep` (chamber-only lenses), `Poll` gains
    // an optional `action` governance-action tag (CIP-1694 type + off-chain anchor link, microblog storage
    // v8 → v9), and `create_poll` gains an `action` argument (→ `transaction_version` 6). `PollView` gains
    // the four kinds + the `action` view.
    // spec 210: `verify_bind_proof_role` (cogno-gate CIP-8) also accepts the BARE 28-byte role credential a
    // CIP-95 wallet embeds as the COSE "address" when signing with a dRep key (Eternl/Lace in-wallet role
    // claims), in addition to a headered vkey-payment address. Verifier logic only — no call/storage/event
    // change, so `transaction_version` STAYS 6 and the SCALE metadata is byte-identical.
    // spec 211 (the pre-mainnet safe batch): `link_identity_signed` DROPS its unauthenticated
    // `thread_pointer` argument + the `ThreadOf` storage (→ `transaction_version` 7 — the only mover);
    // `create_poll` REQUIRES `close_at` inside a new `MinPollDuration`/`MaxPollDuration` window (3 new
    // pinned microblog errors; the argument stays `Option`, so no tx-version move); `pallet-tx-pause`
    // lands at index 20 (committee break-glass, `BaseCallFilter = InsideBoth`); the profile tidy-up
    // calls are capacity-priced per account; the observed-role truncation reserves non-SPO badges; and
    // the Cardano cutover collapses to the one `CARDANO_NET` selector. (The enum-variant pinning and
    // the cardano-roles DbWeight fix ride along — both non-encoding.)
    spec_version: 211,
    impl_version: 1,
    apis: apis::RUNTIME_API_VERSIONS,
    // Bump `transaction_version` only when the on-wire extrinsic encoding changes — a call's args, or
    // the `TxExtension` tuple. Metadata-only churn (new calls, new storage, doc strings) does not.
    // 3 → 4: `create_poll` gained a `close_at: Option<BlockNumber>` argument (spec 205). Spec 206 adds the
    // CardanoRoles pallet (new calls/storage only, `TxExtension` byte-identical), so it STAYED 4.
    // 4 → 5: `create_poll` gained a `kind: PollKind` argument (spec 207).
    // 5 → 6: `create_poll` gained an `action: Option<GovActionInput>` argument (spec 209).
    // 6 → 7: `link_identity_signed` LOST its `thread_pointer: Option<Vec<u8>>` argument (spec 211) —
    // removing a call ARGUMENT changes the extrinsic encoding. (Nothing else in spec 211 moves it: the
    // new tx-pause CALLS and the new poll-duration VALIDATION are metadata-only, and the `TxExtension`
    // tuple is byte-identical.)
    transaction_version: 7,
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
    NativeVersion {
        runtime_version: VERSION,
        can_author_with: Default::default(),
    }
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
    // The feeless-post spam gate. Runs at the pool BEFORE payment; over-budget `post_message` →
    // `ExhaustsResources`, capacity consumed at inclusion.
    pallet_microblog::CheckCapacity<Runtime>,
    // Wrap payment in `SkipCheckIfFeeless` so calls marked `#[pallet::feeless_if]`
    // (i.e. `post_message`) skip the fee. Feeless is per-call, not chain-wide — the microblog social
    // writes (post_message/quote_post/vote/clear_vote/vote_account/clear_account_vote/follow/unfollow/
    // create_poll/cast_poll_vote)
    // AND pallet-profile's four writes (set_profile/clear_profile/pin_post/unpin_post, since spec 117 —
    // metered against the one battery via the `ForeignCapacityCost` seam at `ProfileCost`) are feeless;
    // everything else stays fee-bearing. (Metadata-invisible: PAPI sees plain payment.)
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

    // (Index 6 is permanently vacant: cogno-chain is SUDO-FREE from genesis — `pallet-sudo` was removed
    // in the all-Rust restart. FRAME allows index gaps. There is no root/break-glass key; the 3-of-5
    // FollowerCommittee is the SOLE governance authority.)

    // 7 = GovernedUpgrade: the sudo-free, committee-governed runtime-upgrade authorizer.
    // `authorize_upgrade(code_hash)` is AuthorityOrigin-gated; the WASM is applied permissionlessly via
    // `System::apply_authorized_upgrade` (spec-version checked).
    #[runtime::pallet_index(7)]
    pub type GovernedUpgrade = pallet_governed_upgrade;

    // ── cogno-chain app pallets ──
    // Indices are on-wire contracts (FRAME allows index gaps): 8 = CognoGate (the CIP-8 identity gate /
    // anti-Sybil anchor); 9 = TalkStake (the weight ledger); 10 = Microblog (posting + the talk-capacity
    // meter, folded in rather than split out); 11 = SkipFeelessPayment (the feeless fee-waiver pallet).
    #[runtime::pallet_index(8)]
    pub type CognoGate = pallet_cogno_gate;

    #[runtime::pallet_index(9)]
    pub type TalkStake = pallet_talk_stake;

    #[runtime::pallet_index(10)]
    pub type Microblog = pallet_microblog;

    #[runtime::pallet_index(11)]
    pub type SkipFeelessPayment = pallet_skip_feeless_payment;

    // (Index 12 is permanently vacant: anchoring was DROPPED in the all-Rust restart — the chain is
    // observe-only, with no Cardano WRITE link / `pallet-anchor`. FRAME allows index gaps. The stable
    // Cardano block reference is still SEALED into each block header by the `cobs` proposer, but that is
    // the node-side consensus header seal (`node/src/consensus/`), unrelated to the removed pallet.)

    // 13 = FollowerCommittee: the MUTABLE 3-of-5 k-of-t committee that is the SOLE
    // governance authority — it backs the crown-jewel origins (cogno-gate FollowerOrigin / microblog
    // ForceOrigin / validator-set AddRemoveOrigin / cardano-observer EnforceOrigin / governed-upgrade
    // AuthorityOrigin) via `EnsureProportionAtLeast<3,5>`. cogno-chain is SUDO-FREE: there is NO
    // `EnsureRoot`/sudo fallback. The committee also polices ITSELF (SetMembers/Disapprove/Kill all gated
    // by the 3/5 origin); the `CognoCallFilter` brick-guard forbids emptying it. Members rotate via
    // `Collective::set_members`; the proposal lifecycle events are the per-action audit log. One shared
    // instance. Next free index after the (vacant) anchor slot.
    #[runtime::pallet_index(13)]
    pub type FollowerCommittee = pallet_collective<Instance1>;

    // 14 = ValidatorSet: the MUTABLE Aura+GRANDPA validator set (vendor-forked from
    // gautamdhameja/substrate-validator-set). It is pallet-session's SessionManager — each session
    // rotation it hands the current set to Aura/GRANDPA. `add_validator`/`remove_validator` are
    // gated by the `AuthorityOrigin` (3-of-5 FollowerCommittee, sudo-free) and queued to a session
    // boundary. Declared BEFORE Session so its genesis seats `Validators` before Session's genesis
    // reads it via `SessionManager::new_session_genesis`.
    #[runtime::pallet_index(14)]
    pub type ValidatorSet = pallet_validator_set;

    // 15 = Session: drives Aura+GRANDPA authorities from the ValidatorSet SessionManager
    // instead of static genesis (the two are mutually exclusive — the aura/grandpa genesis is now
    // empty; authorities are seated through SessionConfig). `SessionHandler = (Aura, Grandpa)` via
    // the opaque SessionKeys; changes apply at session boundaries (~2 sessions).
    #[runtime::pallet_index(15)]
    pub type Session = pallet_session;

    // 16 = CardanoObserver (in-protocol-observation, the D4 weight rung): the SOLE weight writer. Sets
    // talk-stake weight/voting-power from a consensus-verified Cardano observation INHERENT
    // (`ProvideInherent`; every importing validator re-derives the read and rejects the block on mismatch).
    // There is no trusted off-chain `set_stake` path any more (talk-stake is call-less). Declared AFTER
    // Timestamp (@1) and CognoGate (@8), which its Mandatory inherent reads (block time for the stability
    // bound; `AccountOf` for beacon→account). `EnforceWeight` defaults to true (writes from block 0);
    // `set_enforcement(false)` is the emergency weight-freeze revert. Next free index 17.
    #[runtime::pallet_index(16)]
    pub type CardanoObserver = pallet_cardano_observer;

    // 17 = Profile (social-actions branch): the mutable per-account display profile (name/bio/
    // avatar). `set_profile` is identity-gated via the microblog `IsAllowed` trait (CognoGate)
    // and FEE-BEARING (low-frequency — the tx fee is its own anti-spam, so no second capacity
    // extension is needed and transaction_version is unaffected). A separate pallet keeps the
    // security-sensitive identity verifier and the feeless hot path lean. Next free index 18.
    #[runtime::pallet_index(17)]
    pub type Profile = pallet_profile;

    // 18 = GovernanceFuel: the sudo-free, committee-administered REGENERATING admin-fuel budget. Fuel
    // (native `Balances`) pays the fee-bearing admin extrinsics (`Session::set_keys`, committee
    // propose/vote/close). `set_allowance`/`revoke` are AuthorityOrigin-gated (3-of-5, sudo-free); an
    // `on_initialize` hook mints each funded account back toward its committee-set standing allowance so
    // the supply never depletes (mint-on-demand — the FIRST post-genesis mint path) and a drained member
    // auto-recovers (no self-refund deadlock). Fuel is non-transferable (the `CognoCallFilter` blocks
    // `Balances::transfer*`) and can NEVER post (the social layer never reads `Balances`) — the admin-side
    // analogue of talk-capacity. Additive (new calls/storage/events/metadata): spec_version bumps,
    // transaction_version STAYS 3 (the `TxExtension` tuple is byte-identical). Next free index 19.
    #[runtime::pallet_index(18)]
    pub type GovernanceFuel = pallet_governance_fuel;

    // 19 = CardanoRoles: verifiable Cardano role tags (SPO / dRep / CC). Two ledgers: a PERMISSIONLESS
    // CIP-8 role-key claim ledger (`claim_role_signed` reuses the cogno-gate crown-jewel verifier via a
    // pure function; the 3-of-5 FollowerCommittee gates only `revoke_role`), and a CALL-LESS
    // observer-written observed-role ledger (`ObservedRoles`) the profile badge reads. Declared AFTER
    // CognoGate (@8, whose `PkhOf` gates a claim to a payment-bound account) and the CardanoObserver
    // (@16, the sole writer of `ObservedRoles`). Additive (new calls/storage/events/metadata):
    // spec_version bumps, transaction_version STAYS the same (the `TxExtension` tuple is byte-identical).
    #[runtime::pallet_index(19)]
    pub type CardanoRoles = pallet_cardano_roles;

    // 20 = TxPause (spec 211): the committee-gated BREAK-GLASS. `pause`/`unpause` ONE
    // `(pallet_name, call_name)` pair BY NAME, gated by the same 3-of-5 `AuthorityOrigin` as every
    // other privileged write; enforcement rides `BaseCallFilter`
    // (`InsideBoth<CognoCallFilter, TxPause>`). Before this there was NO fast lever:
    // `set_enforcement` freezes only the observer's weight writes (it stops nothing a user can
    // dispatch), `CognoCallFilter` is compile-time, so the only response to e.g. a forgery bug in
    // the unaudited CIP-8 verifier was build a wasm, propose, vote, close, apply.
    //
    // TWO ASYMMETRIES worth knowing before you write a motion:
    //
    // 1. PAUSING IS PAIR-GRANULAR, WHITELISTING IS NOT. `pallet-tx-pause` 30.0.0 has no
    //    whole-pallet pause: `pause` takes a `(PalletNameOf, PalletCallNameOf)` PAIR, and
    //    `is_paused_unbound` only ever looks up the exact pair `GetCallMetadata` yields, so shutting
    //    a pallet takes one motion per call. It also does not check the name against runtime
    //    metadata, so a bogus or empty call name is ACCEPTED, stored, and `CallPaused` is emitted —
    //    a motion that reports success while pausing nothing. `WhitelistedCalls`, by contrast, is
    //    free to match on pallet name alone, and `TxPauseWhitelist` does exactly that for
    //    `FollowerCommittee`. Do not "fix" that asymmetry; it is the pallet's shape.
    // 2. A PAUSE STOPS THE DISPATCH, NOT THE POOL. `BaseCallFilter` is consulted at dispatch, so a
    //    paused bare-unsigned call (the CIP-8 binds, the role claim) still runs its full
    //    `validate_unsigned` verify at gossip and again at inclusion via `pre_dispatch`, then fails
    //    `CallFiltered`. That is fine for the case the lever exists for — a forgery bug's harm is
    //    forged binds TAKING EFFECT, and the pause stops that in minutes rather than a wasm cycle.
    //    It is not a fix for the free pool-level verify cost, which is a separate, pre-existing and
    //    accepted surface (see the note on cogno-gate's `validate_unsigned`).
    //
    // `WhitelistedCalls` pins what may NEVER be paused: both inherents (`CardanoObserver::observe`,
    // `Timestamp::set` — a paused Mandatory dispatch is `BadMandatory`, discarding every block), the
    // whole `FollowerCommittee` (the unpause path), and the upgrade path
    // (`GovernedUpgrade::authorize_upgrade` + `System::apply_authorized_upgrade`); the pallet refuses
    // to pause itself. Upstream FRAME reference weights. Next free index 21.
    #[runtime::pallet_index(20)]
    pub type TxPause = pallet_tx_pause;
}
