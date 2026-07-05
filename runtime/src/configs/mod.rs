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
    traits::{ConstBool, ConstU128, ConstU32, ConstU64, ConstU8, Contains, VariantCountOf},
    weights::{
        constants::{RocksDbWeight, WEIGHT_REF_TIME_PER_SECOND},
        IdentityFee, Weight,
    },
};
// DR-07: the mutable k-of-t committee origin combinator + its default instance. cogno-chain is SUDO-FREE:
// the FollowerCommittee is the SOLE governance authority, so there is no `frame_system::EnsureRoot` /
// `EitherOfDiverse` root fallback anywhere in the runtime.
use frame_system::limits::{BlockLength, BlockWeights};
use pallet_collective::{EnsureProportionAtLeast, Instance1};
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
    EXISTENTIAL_DEPOSIT, MINUTES, SLOT_DURATION, UNIT, VERSION,
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

/// Runtime migrations (a tuple of `OnRuntimeUpgrade` types run by the Executive before the per-pallet
/// hooks in the first block after a `setCode`). The all-Rust restart is a FRESH GENESIS, so there is no
/// pre-200 storage to migrate: every pallet starts at its declared `STORAGE_VERSION` at genesis, so the
/// old microblog/profile v0→v4 `VersionedMigration`s (still present in the pallets, self-skipping) are
/// deliberately NOT registered here. Add a new migration only for a future in-place governed upgrade.
type SingleBlockMigrations = ();

/// The runtime base call filter — the sudo-free brick-guard + the fuel-non-transferability rule.
/// cogno-chain permits EVERY call except:
///
/// 1. a `FollowerCommittee::set_members` that would EMPTY the committee, or land it at exactly TWO seats.
///    The committee is the SOLE governance authority (no sudo / `EnsureRoot` fallback), so an empty member
///    set makes [`AuthorityOrigin`] (`EnsureProportionAtLeast<3,5>`) permanently unsatisfiable — bricking
///    ALL governance (validator rotation, runtime upgrades, identity revoke, force-capacity) with no
///    on-chain recovery, only a chain fork. A passed motion — or, at the 1-seat bootstrap where the
///    threshold is 1, a single fat-finger / lost-key vote — could otherwise write `Members = []`. A TWO-seat
///    set is the other trap: `ceil(2*3/5)=2` = unanimity, so it has ZERO fault tolerance AND recovery from
///    one lost/dark seat needs that very seat's vote (irreversible brick). So the allowed sizes are 1 (the
///    founder bootstrap) and `>= 3` (fault-tolerant): the federation jump is 1 -> 3+ directly, and a 3 -> 2
///    shrink is also rejected (never sit at the fragile 2). Rejecting these here makes such a motion fail
///    on-chain (`CallFiltered`) instead of bricking the chain: the filter is enforced even on the
///    collective's OWN proposal dispatch, because `RawOrigin::Members(..).into()` resets the origin filter
///    to this `BaseCallFilter`. (The `1 || >= 3` floor is always satisfiable from any legal state.)
///
/// 2. `Session::purge_keys`. It is permissionless + self-signed, so a SEATED validator could purge its own
///    session keys and become a keyless "phantom" — dropped from the live Aura/GRANDPA authorities
///    (`QueuedKeys`) yet still counted in `Validators::len()`, which is what `MinAuthorities` guards. Enough
///    phantoms let the committee remove the last REAL validator while the floor still reads satisfied → zero
///    live authorities. Blocking purge keeps `Validators` and the keyed set in lockstep (so the len-based
///    floor stays correct). Deregistration is via committee `remove_validator`, not self-purge; `set_keys`
///    still rotates keys; a leftover `NextKeys` entry for an unseated account is harmless.
///
/// 3. ANY `pallet-balances` call. The native token is **governance FUEL**, not money: it exists only to
///    pay the fee-bearing admin extrinsics and is minted/regenerated/clawed-back exclusively by the
///    committee via `GovernanceFuel` (index 18). No signed user ever needs a `Balances` extrinsic (funding
///    is committee-only), so blocking the WHOLE pallet surface — not just today's `transfer_allow_death` /
///    `transfer_keep_alive` / `transfer_all` — is deliberate: a per-variant match would silently miss a
///    future SDK train's new value-moving variant and re-open a sweep path that defeats the escape-proof
///    `GovernanceFuel::revoke`. `force_*` are already unreachable (root-gated, and cogno-chain is
///    sudo-free). This makes fuel a pure committee-administered budget and routes ALL funding through the
///    audited 3-of-5 path; ordinary social users are feeless and never transfer, so nothing legitimate is
///    lost. NOTE: a call-ACCEPTANCE change, not an encoding change — `transaction_version` is unaffected.
///    SKIPPED under `runtime-benchmarks` so the node's `benchmark extrinsic` `TransferKeepAliveBuilder`
///    (node/src/benchmarking.rs) can still exercise a real transfer.
///
/// ⚠ FEDERATION PREREQUISITE: the `1 || >= 3` floor stops the fragile sizes, but a value-bearing launch
/// should also carry loss-tolerance headroom (a 5-seat committee tolerates 2 lost keys) plus a written
/// key-custody/rotation runbook — there is no sudo break-glass if `ceil(3n/5)` live keys are ever lost.
/// `set_members` is the ONLY committee-membership mutator (pallet-collective has no add/remove call), so
/// guarding it covers every path to a bricked committee.
pub struct CognoCallFilter;
impl Contains<RuntimeCall> for CognoCallFilter {
    fn contains(call: &RuntimeCall) -> bool {
        if let RuntimeCall::FollowerCommittee(pallet_collective::Call::set_members {
            new_members,
            ..
        }) = call
        {
            // Brick-guard: never allow a motion that would empty the committee (see doc above).
            if new_members.is_empty() {
                return false;
            }
            // Brick-guard: reject a 2-seat committee. `ceil(2*3/5)=2` = unanimity — ZERO fault tolerance,
            // and recovery from ONE lost/dark seat needs that very seat's vote (an irreversible brick, no
            // sudo). Allowed sizes are 1 (the founder bootstrap) and >= 3 (fault-tolerant); federate 1 -> 3+
            // directly. This also blocks a 3 -> 2 shrink, which is intended (never sit at the fragile 2).
            if new_members.len() == 2 {
                return false;
            }
            // Footgun-guard: every NEWLY-added member must already hold a governance-fuel allowance, so it
            // can pay to `propose`/`vote` — an unfunded member only dilutes the `EnsureProportionAtLeast`
            // denominator (raising the threshold) without adding voting capacity. EXISTING members (delta
            // = new_members \ current `Members`) are exempt, so genesis seats (endowed, no allowance) and
            // sitting members re-listed in a rotation pass. Skipped under runtime-benchmarks so the
            // `pallet_collective` benchmark's `set_members` isn't blocked.
            #[cfg(not(feature = "runtime-benchmarks"))]
            {
                let current = pallet_collective::Members::<Runtime, Instance1>::get();
                let allowances = pallet_governance_fuel::Allowances::<Runtime>::get();
                for m in new_members.iter() {
                    if !current.contains(m) && !allowances.iter().any(|(a, _)| a == m) {
                        return false;
                    }
                }
            }
            return true;
        }
        // Validator floor-bypass guard: block `Session::purge_keys`. It is permissionless + self-signed, so
        // a SEATED validator could purge its own session keys and become a keyless "phantom" — filtered out
        // of the live Aura/GRANDPA authorities (`QueuedKeys`) yet still counted in `Validators::len()`, which
        // is what `MinAuthorities` checks. Enough phantoms let the committee remove the last REAL validator
        // while the floor still reads satisfied → zero live authorities. Blocking purge keeps `Validators`
        // and the keyed set in lockstep (so the len-based floor stays correct); a validator is deregistered
        // by committee `remove_validator`, not self-purge, and `set_keys` still rotates keys. A leftover
        // `NextKeys` entry for an unseated account is harmless (its keys are never loaded).
        if matches!(call, RuntimeCall::Session(pallet_session::Call::purge_keys { .. })) {
            return false;
        }
        // Fuel is non-transferable: block the entire pallet-balances call surface (future-proof vs. new
        // SDK transfer variants). Skipped under runtime-benchmarks so `benchmark extrinsic` still works.
        #[cfg(not(feature = "runtime-benchmarks"))]
        if matches!(call, RuntimeCall::Balances(..)) {
            return false;
        }
        true
    }
}

#[cfg(test)]
mod call_filter_tests {
    use super::*;
    use frame_support::traits::Contains;

    fn addr() -> crate::Address {
        sp_runtime::MultiAddress::Id(AccountId::from([1u8; 32]))
    }

    #[test]
    fn blocks_every_balances_transfer_variant() {
        // The load-bearing "fuel is non-transferable / revoke is escape-proof" invariant. Runs in the
        // normal (non-benchmarks) build where the Balances block is active.
        assert!(!CognoCallFilter::contains(&RuntimeCall::Balances(
            pallet_balances::Call::transfer_keep_alive {
                dest: addr(),
                value: 1
            }
        )));
        assert!(!CognoCallFilter::contains(&RuntimeCall::Balances(
            pallet_balances::Call::transfer_allow_death {
                dest: addr(),
                value: 1
            }
        )));
        assert!(!CognoCallFilter::contains(&RuntimeCall::Balances(
            pallet_balances::Call::transfer_all {
                dest: addr(),
                keep_alive: false
            }
        )));
    }

    #[test]
    fn blocks_emptying_the_committee() {
        // The empty-set brick-guard is checked BEFORE any storage read, so it holds without
        // externalities. (The non-empty case now reads `Members`/`Allowances` for the fuel-delta gate —
        // that path is covered end-to-end in the acceptance script, which runs against real storage.)
        assert!(!CognoCallFilter::contains(&RuntimeCall::FollowerCommittee(
            pallet_collective::Call::set_members {
                new_members: Default::default(),
                prime: None,
                old_count: 0
            }
        )));
    }

    #[test]
    fn blocks_a_two_seat_committee() {
        // `ceil(2*3/5)=2` = unanimity with ZERO fault tolerance; one lost seat is an irreversible brick.
        // Checked before any storage read (like the empty-set guard), so it holds without externalities.
        let two = [AccountId::from([1u8; 32]), AccountId::from([2u8; 32])].to_vec();
        assert!(!CognoCallFilter::contains(&RuntimeCall::FollowerCommittee(
            pallet_collective::Call::set_members {
                new_members: two,
                prime: None,
                old_count: 1
            }
        )));
    }

    #[test]
    fn blocks_session_purge_keys() {
        // purge_keys would let a seated validator self-demote to a keyless phantom, bypassing the
        // MinAuthorities floor (which counts `Validators::len()`, not the live keyed set).
        assert!(!CognoCallFilter::contains(&RuntimeCall::Session(
            pallet_session::Call::purge_keys {}
        )));
    }

    #[test]
    fn allows_a_normal_signed_call() {
        // A committee-gated fuel grant and an ordinary system call are NOT filtered.
        assert!(CognoCallFilter::contains(&RuntimeCall::System(
            frame_system::Call::remark {
                remark: Default::default()
            }
        )));
        assert!(CognoCallFilter::contains(&RuntimeCall::GovernanceFuel(
            pallet_governance_fuel::Call::set_allowance {
                who: AccountId::from([3u8; 32]),
                max: 1
            }
        )));
    }
}

/// The default types are being injected by [`derive_impl`](`frame_support::derive_impl`) from
/// [`SoloChainDefaultConfig`](`struct@frame_system::config_preludes::SolochainDefaultConfig`),
/// but overridden as needed.
#[derive_impl(frame_system::config_preludes::SolochainDefaultConfig)]
impl frame_system::Config for Runtime {
    /// The block type for the runtime.
    type Block = Block;
    /// The sudo-free committee-brick guard: rejects an empty `FollowerCommittee::set_members` on-chain
    /// (overrides the `SolochainDefaultConfig` `Everything` filter). See [`CognoCallFilter`].
    type BaseCallFilter = CognoCallFilter;
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

// Sudo-free governance: the committee-authorized runtime-upgrade shim (GovernedUpgrade@7). Gated by the
// shared `AuthorityOrigin` (≥3/5 committee) — the one call `frame_system` cannot re-gate off `ensure_root`.
// The WASM itself is applied by the permissionless `System::apply_authorized_upgrade` (spec-version checked).
impl pallet_governed_upgrade::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
    type AuthorityOrigin = AuthorityOrigin;
    type WeightInfo = ();
}

// Sudo-free governance: the committee-administered REGENERATING admin-fuel budget (GovernanceFuel@18).
// Fuel (native `Balances`) pays the fee-bearing admin extrinsics — a new validator's self-signed
// `Session::set_keys` and committee propose/vote/close. `set_allowance`/`revoke` are gated by the shared
// `AuthorityOrigin` (≥3/5 committee); an `on_initialize` hook mints each funded account back toward its
// standing allowance every `FuelRegenPeriod`, so fuel REGENERATES (a drained member auto-recovers → no
// self-refund deadlock) and the supply floats with mint-on-demand (this is the FIRST post-genesis mint
// path — it deliberately breaks the old monotone-decreasing-supply property; nothing keys security off
// `TotalIssuance`). Fuel is non-transferable (`CognoCallFilter` blocks every `Balances` call) and can
// NEVER post (the social layer never reads `Balances`) — the admin-side analogue of talk-capacity.
//
// Regeneration covers accounts the committee has funded via `set_allowance` (the post-genesis onboarding
// path). The GENESIS committee + validators are NOT seeded into `Allowances` — they are endowed a large
// one-time balance (`genesis_config_presets.rs`) that is drain-proof against the tiny `IdentityFee` admin
// fees, so they need no standing allowance to stay live. (A committee may `set_allowance` them anyway to
// put them on the regenerating path; there is deliberately no pallet genesis config.)
parameter_types! {
    /// DEV-TUNED per-account fuel allowance ceiling (runtime-tunable). Bounds a single fat-fingered
    /// `set_allowance` and the per-`FuelRegenPeriod` admin spend a funded account can sustain. There is
    /// deliberately NO cumulative cap on issuance (mint-on-demand — governance never runs dry). Sized far
    /// above the tiny `IdentityFee` fees of a handful of admin extrinsics.
    pub const MaxFuelAllowance: Balance = 1_000 * UNIT;
    /// Regeneration cadence: refill funded accounts toward their allowance once a minute (10 blocks at
    /// 6s/block). DEV-TUNED snappy so a drained member recovers quickly in the showcase; a longer cadence
    /// is a runtime-tunable constant change. The funded set is tiny (≤ MaxFundedAccounts), so the periodic
    /// mint loop is cheap.
    pub const FuelRegenPeriod: BlockNumber = MINUTES;
}

/// `revoke` footgun-guard: an account still seated in the `FollowerCommittee` must not be de-funded — it
/// would leave an unpayable seat in the `EnsureProportionAtLeast<3,5>` denominator (raising the threshold;
/// brick on enough of them, no sudo recovery). The mirror of the add-path `HasFuelAllowance`/set_members
/// fuel guard. Reads `pallet_collective::Members`. Returns `false` under `runtime-benchmarks` so the
/// governance-fuel `revoke` benchmark (a non-member target) isn't blocked.
pub struct IsCommitteeMember;
impl Contains<AccountId> for IsCommitteeMember {
    #[cfg(not(feature = "runtime-benchmarks"))]
    fn contains(who: &AccountId) -> bool {
        pallet_collective::Members::<Runtime, Instance1>::get().contains(who)
    }
    #[cfg(feature = "runtime-benchmarks")]
    fn contains(_who: &AccountId) -> bool {
        false
    }
}

impl pallet_governance_fuel::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
    // The same 3-of-5 FollowerCommittee gate as every other crown-jewel call (sudo-free).
    type GrantOrigin = AuthorityOrigin;
    // Footgun-guard: refuse to de-fund a still-seated committee member (unseat via set_members first).
    type Seated = IsCommitteeMember;
    // Mint/burn the native token (Balances@4; implements `fungible::Mutate<AccountId, Balance = u128>`).
    type Currency = Balances;
    type MaxAllowance = MaxFuelAllowance;
    // Comfortably covers MaxValidators (32) + FollowerMaxMembers (7) with headroom.
    type MaxFundedAccounts = ConstU32<64>;
    type RegenPeriod = FuelRegenPeriod;
    // Placeholder weights (like GovernedUpgrade): conservative DB-weight estimates so the on_initialize
    // regeneration hook never under-charges. Graduating to a benchmarked `SubstrateWeight<Runtime>` (run
    // `benchmark pallet --pallet pallet_governance_fuel`) is a deploy step.
    type WeightInfo = ();
}

// ── DR-07: the FollowerCommittee — the mutable k-of-t authority behind the crown jewels ──
//
// `pallet-collective` (one shared `Instance1`) holds a MUTABLE member set (rotation via
// `Collective::set_members`, gated by `SetMembersOrigin` = the committee's own `AuthorityOrigin`)
// and produces an `EnsureProportionAtLeast<3,5>` origin when a motion carries a 3-of-5 supermajority.
// That origin authorizes every privileged write — there is NO `EnsureRoot`/sudo fallback (sudo-free
// from genesis; index 6 vacant).
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

/// A `DefaultVote` that counts every abstention as a **NAY** — abstentions can never carry a motion.
///
/// This replaces `pallet_collective::PrimeDefaultVote`. With the crown-jewel origin
/// [`AuthorityOrigin`] (`EnsureProportionAtLeast<3,5>`), `PrimeDefaultVote` was actively dangerous: once a
/// prime is set, `close()` after the motion window folds EVERY absentee into `yes_votes`
/// (`prime_vote.unwrap_or(false)`), then dispatches `RawOrigin::Members(yes_votes, seats)` — so a single
/// unopposed prime aye satisfies the 3/5 bar and passes ANY privileged call unless ≥3 members actively
/// vote NAY. That inverts "3-of-5 to ACT" into "3 nays to STOP". Abstain-as-nay closes it: a privileged
/// motion executes ONLY on explicit ayes meeting the proportion, restoring the active-supermajority
/// property the origin advertises. The prime becomes inert (kept settable but no longer load-bearing).
pub struct AbstainAsNay;
impl pallet_collective::DefaultVote for AbstainAsNay {
    fn default_vote(_prime_vote: Option<bool>, _yes_votes: u32, _no_votes: u32, _len: u32) -> bool {
        false
    }
}

impl pallet_collective::Config<Instance1> for Runtime {
    type RuntimeOrigin = RuntimeOrigin;
    type Proposal = RuntimeCall;
    type RuntimeEvent = RuntimeEvent;
    type MotionDuration = FollowerMotionDuration;
    type MaxProposals = FollowerMaxProposals;
    type MaxMembers = FollowerMaxMembers;
    // Abstain-as-NAY: absentees count as NAY, so a crown-jewel motion passes ONLY on explicit ayes meeting
    // the 3/5 bar. NOT `PrimeDefaultVote` — with the proportion origin a prime default folds absentees into
    // aye and collapses the supermajority to a lone unopposed prime after the motion window (see AbstainAsNay).
    type DefaultVote = AbstainAsNay;
    type WeightInfo = pallet_collective::weights::SubstrateWeight<Runtime>;
    // SUDO-FREE: the committee polices ITSELF — rotation (`set_members`), disapprove, and kill are all
    // gated by the same `AuthorityOrigin` (≥3/5 of the committee). There is no root fallback. At the
    // D2/D3 graduation this becomes a signature-free `EnsureOrigin` swap to an Ariadne/SPO selection
    // pallet. The `CognoCallFilter` brick-guard forbids a `set_members` that would empty the committee.
    type SetMembersOrigin = AuthorityOrigin;
    type MaxProposalWeight = MaxProposalWeight;
    type DisapproveOrigin = AuthorityOrigin;
    type KillOrigin = AuthorityOrigin;
    // No proposal deposit/consideration in v1 (the committee is permissioned, not open).
    type Consideration = ();
}

/// The crown-jewel authority origin: a **3-of-5 supermajority** of the [`FollowerCommittee`]
/// (`EnsureProportionAtLeast<3,5>`, `needed = ceil(n*3/5)` so it works at every size — 1→1, 3→2, 5→3,
/// 7→5). cogno-chain is SUDO-FREE, so there is NO `EnsureRoot` fallback. Shared by the committee's own
/// self-policing origins, `cogno-gate::FollowerOrigin`, `microblog::ForceOrigin`,
/// `validator-set::AddRemoveOrigin`, `cardano-observer::EnforceOrigin`
/// (the weight-freeze control — the observer, not this origin, writes weight), and
/// `governed-upgrade::AuthorityOrigin` — so identity, validators, upgrades, and force-capacity all sit
/// behind ONE trust boundary (L2 §8.4, L3 §4.5).
pub type AuthorityOrigin = EnsureProportionAtLeast<AccountId, Instance1, 3, 5>;

// ── M6 (DR-26): MUTABLE Aura+GRANDPA authorities via pallet-session + pallet-validator-set ──
//
// `pallet-session` rotates the block-producing authority set; `pallet-validator-set` is its
// `SessionManager` (the mutable set, gated add/remove). Aura+GRANDPA derive their authorities from
// the session each rotation (their `OneSessionHandler` impls), NOT from static genesis — the two
// are mutually exclusive (the aura/grandpa genesis is left empty; authorities are seated through
// `SessionConfig`). A queued add/remove is applied at a session boundary (~2 sessions), never
// mid-session.
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
    type DisablingStrategy = pallet_session::disabling::UpToLimitWithReEnablingDisablingStrategy;
    type WeightInfo = pallet_session::weights::SubstrateWeight<Runtime>;
    type Currency = Balances;
    // Dev: no key deposit. A real testnet sets this above the ED so registering session keys
    // (`set_keys`) costs something — anti-spam on the validator-candidate registry.
    type KeyDeposit = ConstU128<0>;
}

/// Configure pallet-validator-set (M6, DR-26): the mutable Aura+GRANDPA validator set. `add_validator`
/// / `remove_validator` are gated by the SAME `AuthorityOrigin` as the other crown jewels (the
/// 3-of-5 FollowerCommittee, sudo-free) — one operator committee governs identity, weight, AND who
/// produces blocks (the split into a separate validator committee is a documented graduation step).
///
/// ## `MinAuthorities` is a finality-safety parameter, not just an anti-zero guard
/// The floor stops `remove_validator` ever stranding the chain at zero authorities — but it ALSO
/// bounds how far the committee can shrink the BFT set. It is DELIBERATELY `1` for the small
/// single-/dual-operator preprod testnet (a higher floor would lock the operator out of removing a
/// validator on a set already at the floor). It does NOT make finality safe at low counts: GRANDPA
/// tolerates `f` faults only at `3f+1` authorities, so a 1–3 authority set can stall finality with one
/// offline node.
///
/// ⚠ MAINNET PREREQUISITE: a value-bearing / public multi-validator launch MUST raise this to at
/// least `3f+1` for the target fault tolerance (≥`4` to tolerate one Byzantine/offline authority), in
/// lockstep with the im-online auto-removal wiring. Do not ship `1` to a network meant to be BFT.
/// `add_validator` footgun-guard: an account may only be seated once it holds a standing governance-fuel
/// allowance (so it can pay for its own `set_keys` / re-keying and won't be seated unable to function).
/// Reads `GovernanceFuel::Allowances`. Allow-all under `runtime-benchmarks` so the `pallet_validator_set`
/// benchmark (which seeds a bare account) isn't blocked.
pub struct HasFuelAllowance;
impl Contains<AccountId> for HasFuelAllowance {
    #[cfg(not(feature = "runtime-benchmarks"))]
    fn contains(who: &AccountId) -> bool {
        pallet_governance_fuel::Allowances::<Runtime>::get()
            .iter()
            .any(|(a, _)| a == who)
    }
    #[cfg(feature = "runtime-benchmarks")]
    fn contains(_who: &AccountId) -> bool {
        true
    }
}

/// `add_validator` footgun-guard: an account may only be seated once it has registered session keys (else
/// it is in the set but authors nothing — inert empty slots). Reads `Session::NextKeys`. Allow-all under
/// `runtime-benchmarks`.
pub struct HasSessionKeys;
impl Contains<AccountId> for HasSessionKeys {
    #[cfg(not(feature = "runtime-benchmarks"))]
    fn contains(who: &AccountId) -> bool {
        pallet_session::NextKeys::<Runtime>::contains_key(who)
    }
    #[cfg(feature = "runtime-benchmarks")]
    fn contains(_who: &AccountId) -> bool {
        true
    }
}

impl pallet_validator_set::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
    type AddRemoveOrigin = AuthorityOrigin;
    // Deliberate testnet floor — see the ⚠ MAINNET PREREQUISITE note above before raising/shipping.
    type MinAuthorities = ConstU32<1>;
    // validators-3: MUST equal (or be below) aura/grandpa `MaxAuthorities` (= 32) so a full set never
    // gets silently truncated at a session rotation. `add_validator` rejects growth past this.
    type MaxValidators = ConstU32<32>;
    // Onboarding footgun-guards: refuse to seat a validator that isn't fuel-funded + keyed (enforces the
    // `fuel set-allowance` → `set-keys` → `add_validator` order on-chain).
    type FuelGate = HasFuelAllowance;
    type KeysGate = HasSessionKeys;
    type WeightInfo = pallet_validator_set::weights::SubstrateWeight<Runtime>;
}

/// Configure pallet-talk-stake: the call-less per-account weight + voting-power ledger. It has NO
/// extrinsic, NO origin, and NO cap — weight enters ONLY through the `cardano-observer` inherent (the
/// sole writer), which applies its OWN `MaxStakeWeight`/`MaxVotingPower` skip-not-reject before calling
/// talk-stake's internal `apply_weight`/`apply_voting_power`. So this Config is just `RuntimeEvent`.
impl pallet_talk_stake::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
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
/// `ForceOrigin` (the 3-of-5 committee) lets the operator prime/pre-charge a battery before the Cardano
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
    // Gated by the 3-of-5 FollowerCommittee (sudo-free).
    type ForceOrigin = AuthorityOrigin;
    // M2: gate posting on a live Cardano-identity binding (the anti-Sybil anchor).
    type IdentityGate = CognoGate;
    // Profile pallet's feeless writes share this one battery, priced at `ProfileCost` and gated at the
    // pool by `CheckCapacity` — so the whole app is feeless with no second transaction-extension.
    type ForeignCost = ProfileCapacityCost;
    type WeightInfo = pallet_microblog::weights::SubstrateWeight<Runtime>;
}

/// Configure pallet-cogno-gate (M2): the 1:1 Cardano-owner-Address ↔ posting-account binding —
/// the anti-Sybil identity anchor. Binding is a PERMISSIONLESS on-chain CIP-8 self-proof (see the
/// D1 note below); `FollowerOrigin` (the 3-of-5 committee, sudo-free) gates only `revoke`. The
/// `EnsureOrigin` shape kept the widen to a k-of-t committee signature-free. `OnBind`
/// is the first-bind hook into microblog (primes the capacity row + provider ref at link).
///
/// D1 (trustless identity): `link_identity_signed` is the PERMISSIONLESS self-proof bind — the runtime
/// verifies a CIP-8 wallet signature on-chain (`pallet_cogno_gate::cip8`), so no `FollowerOrigin` trust
/// is needed to create a binding. `FollowerOrigin` now only gates `revoke` (the moderation ban, which
/// tombstones permanently). `CardanoNetwork = 0` (testnet — the live preprod addresses). ⚠ MAINNET
/// PREREQUISITE: the verifier has NOT had a formal external audit (see `cip8` module docs).
impl pallet_cogno_gate::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
    // Gated by the 3-of-5 FollowerCommittee (sudo-free) — gates `revoke` only.
    type FollowerOrigin = AuthorityOrigin;
    type OnBind = Microblog;
    // The Cardano network the on-chain self-proof binds for: 0 = testnet (live preprod), 1 = mainnet.
    type CardanoNetwork = ConstU8<0>;
    type WeightInfo = pallet_cogno_gate::weights::SubstrateWeight<Runtime>;
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

/// Configure pallet-cardano-observer (in-protocol-observation, the D4 weight rung). It is the **SOLE
/// weight writer**: every block the node-side `InherentDataProvider` carries a Cardano observation,
/// `check_inherent` re-derives + verifies it on every importer (reject on mismatch), and the Mandatory
/// `observe` applies it to `AllowedStake`/`VotingPower`. There is no trusted off-chain `set_stake` path
/// any more (talk-stake is call-less). `EnforceWeight` defaults to `true`; `set_enforcement(false)` is the
/// emergency weight-freeze revert (verify but don't write), gated by the committee.
///
/// ⚠ MAINNET PREREQUISITE: `check_inherent`'s "every producer re-derives" is load-bearing only with
/// MULTIPLE independent producers — on a single operator this is "D4-SHAPED, not D4-TRUST"; and every
/// validator must run cardano-node + Cardano db-sync. See docs/IN-PROTOCOL-OBSERVATION.md §2/§8/§11.
impl pallet_cardano_observer::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
    // Max identities observed per block. This is a HARD CEILING on concurrent participants, not a batch
    // size: the observation is a FULL-SET snapshot re-derived every block (the unlock-clamp zeroes any
    // identity absent from the CURRENT set, so a delta would wrongly clear unchanged accounts), carried in
    // every block body and re-derived by every producer. Both axes are bounded by it — the vault set
    // (`entries`) AND the bound-stake set (`stake_entries`) — and an observation over it makes
    // `create_inherent` abstain (drops the whole inherent → the sole weight writer FREEZES), so the node
    // now WARNs at 75% and ERRORs at/over it (surfaced via `ObserverConfig::max_observed`). 4096 gives
    // ~4x headroom over the realistic preprod user base while staying well within the block-length budget
    // (~48 B/vault + ~44 B/stake entry) and, with the O(N) unlock-clamp, a modest per-block weight. Raising
    // it further is a one-line const bump within these budgets; REMOVING the ceiling (unbounded users) needs
    // a delta/paged observation re-architecture (a separate milestone). It stays >= talk-stake's cap needs.
    type MaxObserved = ConstU32<4096>;
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
    // The 3-of-5 FollowerCommittee (sudo-free) gates the emergency weight-FREEZE flip — the same crown-jewel
    // origin as identity revoke / validator add-remove / authorize_upgrade. `EnforceWeight` defaults to
    // `true` (the observer is the sole writer from genesis); `set_enforcement(false)` freezes weight (verify
    // but don't write) as an emergency revert (D4-SHAPED on a single operator, IN-PROTOCOL-OBSERVATION.md §2/§9).
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
