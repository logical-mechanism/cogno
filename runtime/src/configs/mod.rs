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
    traits::{
        ConstBool, ConstU128, ConstU32, ConstU64, ConstU8, Contains, InsideBoth, VariantCountOf,
    },
    weights::{
        constants::{RocksDbWeight, WEIGHT_REF_TIME_PER_SECOND},
        IdentityFee, Weight,
    },
};
// The mutable k-of-t committee origin combinator + its default instance. cogno-chain is SUDO-FREE:
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
    AccountId, Aura, Balance, Balances, Block, BlockNumber, CardanoObserver, CognoGate,
    FollowerCommittee, GovernedUpgrade, Hash, Nonce, PalletInfo, Runtime, RuntimeCall,
    RuntimeEvent, RuntimeFreezeReason, RuntimeHoldReason, RuntimeOrigin, RuntimeTask, SessionKeys,
    System, Timestamp, TxPause, ValidatorSet, DAYS, EXISTENTIAL_DEPOSIT, MINUTES, SLOT_DURATION,
    UNIT, VERSION,
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
/// hooks in the first block after a `setCode`). The all-Rust restart was a FRESH GENESIS, so there was no
/// pre-200 storage to migrate: every pallet started at its declared `STORAGE_VERSION`, which is why the
/// old microblog/profile v0→v4 `VersionedMigration`s (still present in the pallets, self-skipping) are
/// deliberately NOT registered here.
///
/// spec 204 is the first IN-PLACE governed upgrade of a chain that already holds state, so it carries the
/// first live migration. `MigrateV4ToV5` drops the retired repost storage (`Reposts` + `RepostCount` — this
/// DELETES rows the live chain holds) and settles every capacity bucket at its current weight. It is
/// `VersionedMigration`-guarded on the microblog storage version moving 4 → 5, so it runs exactly once and
/// self-skips on a re-run. Registering it is load-bearing: without it the on-chain storage version stays 4
/// while the pallet code declares 5, and the repost rows orphan permanently under a prefix no pallet
/// declares any more.
///
/// spec 205 APPENDS `MigrateV5ToV6` (dynamic stake voting): it re-encodes every vote / tally / poll row to
/// drop the stored weight (keeping the counts) and defaults `Poll.close_at = None`. `MigrateV4ToV5` is kept
/// (never replaced) as the self-skipping guard for any node still at v4 — each `VersionedMigration` runs
/// only when the on-chain version matches its `from`, so the tuple is safe to grow.
///
/// spec 207 APPENDS two more (governance polls): `MigrateV6ToV7` appends `Poll.kind = Stake` to every poll,
/// and `pallet_cardano_roles::migrations::MigrateV0ToV1` appends the chamber `weight = 0` to every
/// `ObservedRole` (the observer re-derives the live delegated stake next block). Both are
/// `VersionedMigration`-guarded and no-op on empty state, so a chain that gains the roles pallet in the same
/// upgrade migrates a fresh (empty) `ObservedRoles` harmlessly.
///
/// spec 208 APPENDS `MigrateV7ToV8`: `close_poll` now FREEZES a governance poll's SPO/dRep chambers, so
/// `PollResult` grows four chamber-snapshot vecs; the migration re-encodes every `PollResults` row with
/// empty snapshots (no-op on the live chain, which has no `PollResults` rows).
type SingleBlockMigrations = (
    pallet_microblog::migrations::v5::MigrateV4ToV5<Runtime>,
    pallet_microblog::migrations::v6::MigrateV5ToV6<Runtime>,
    pallet_microblog::migrations::v7::MigrateV6ToV7<Runtime>,
    pallet_cardano_roles::migrations::MigrateV0ToV1<Runtime>,
    // spec 208: freeze the SPO/dRep chambers into `PollResult` (`PollResults` re-encode, empty snapshots
    // on existing rows — a no-op on the live chain, which has none). See `migrations::v8`.
    pallet_microblog::migrations::v8::MigrateV7ToV8<Runtime>,
    // spec 209: append `Poll.action` (the optional governance-action tag) to every poll; existing polls
    // migrate to `action = None` (a no-op on the live chain, which has no polls). See `migrations::v9`.
    pallet_microblog::migrations::v9::MigrateV8ToV9<Runtime>,
    // spec 212: REPAGE `ByAuthor` / `TopLevelByAuthor` from one bounded-vec blob per author to a
    // seq-keyed double map beside an explicit counter. This one MOVES REAL ROWS on the live chain
    // (every author's post-id list is rewritten), and the old and new items share a storage prefix —
    // read the ordering note at the top of `migrations::v10` before touching it.
    pallet_microblog::migrations::v10::MigrateV9ToV10<Runtime>,
    // spec 212: REMOVE the rows of cogno-gate's retired `ThreadOf` map (dropped in spec 211 with
    // `link_identity_signed`'s unauthenticated `thread_pointer`). Deleting the declaration stopped the
    // writes; this deletes what was already written, so the rows do not sit in the state root forever
    // under a prefix nothing declares. See `pallet_cogno_gate::migrations::v1`.
    pallet_cogno_gate::migrations::v1::MigrateV0ToV1<Runtime>,
    // spec 215: REPAGE the observer's three `LastObserved*` clamp bases from whole-set `BoundedVec`
    // blobs into StorageMaps — the change that removes the population ceiling. This one MOVES REAL ROWS
    // on the live chain (7 vault + 2 stake), and the migrated values are deliberately seeded EMPTY so the
    // first observation after the upgrade re-derives them; read the module docs before touching it.
    // The observer had NO declared storage version before this, so the on-chain version reads 0.
    pallet_cardano_observer::migrations::v1::MigrateV0ToV1<Runtime>,
);

/// The runtime base call filter — the sudo-free brick-guard + the fuel-non-transferability rule.
/// cogno-chain permits EVERY call except:
///
/// 1. a `FollowerCommittee::set_members` that repeats an account, exceeds `MaxMembers`, would EMPTY the
///    committee, or land it at exactly TWO seats.
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
///    DISTINCTNESS is checked before any of the size rules, because a repeated account defeats all of
///    them: `pallet_collective` writes duplicates through verbatim, and the origin then measures
///    `ayes * 5 >= 3 * Members::len()` against a denominator that counts them while `DuplicateVote`
///    caps the reachable ayes at the DISTINCT seats. `set_members([A, A, A])` passes a `len() == 3`
///    check while seating one real key — an irreversible brick, and exactly the shape the size rules
///    exist to stop. `MaxMembers` is checked here for the same reason: the pallet only `log::error!`s
///    an overflow rather than rejecting it, so genesis was previously the only place it was enforced.
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
            // Brick-guard: DISTINCTNESS. `pallet_collective::set_members` only `sort()`s — it neither
            // dedupes nor rejects a repeated account (and its `MaxMembers` overflow is a bare
            // `log::error!`, not a rejection). A duplicate is therefore written straight into `Members`,
            // where it counts toward the ORIGIN's denominator while contributing no extra vote:
            // `vote` rejects a second ballot from the same account (`DuplicateVote`), so the reachable
            // ayes are the DISTINCT seats while `EnsureProportionAtLeast<3,5>` measures
            // `ayes * 5 >= 3 * Members::len()`. `set_members([A, A, A])` therefore seats one real key
            // behind a denominator of 3 — `1 * 5 >= 3 * 3` is false forever, so EVERY AuthorityOrigin
            // call (including the `set_members` that would undo it, and `TxPause::unpause`) is
            // permanently unsatisfiable with no sudo recovery. The size rules below are meaningless
            // until the set is known distinct, so this runs FIRST. `gen_chainspec.rs` already enforces
            // the same rule at genesis; this is the dispatch path finally getting it.
            let mut distinct = new_members.clone();
            distinct.sort();
            distinct.dedup();
            if distinct.len() != new_members.len() {
                return false;
            }
            // Brick-guard: never allow a motion that would empty the committee (see doc above).
            if new_members.is_empty() {
                return false;
            }
            // Brick-guard: `pallet_collective` only LOGS an over-`MaxMembers` set (it does not reject),
            // so the bound is enforced at genesis and nowhere else. Take it from the pallet's own
            // `Config` rather than re-spelling `FollowerMaxMembers`, so the two can never drift.
            if new_members.len()
                > <Runtime as pallet_collective::Config<Instance1>>::MaxMembers::get() as usize
            {
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
        // by committee `remove_validator`, not self-purge, and `set_keys` still rotates keys.
        //
        // ACCEPTED COST (bounded state leak): `purge_keys` is the ONLY path that drops the consumer ref
        // `set_keys` takes (`dec_consumers`). Blocking it means a removed / never-seated validator account
        // keeps its `NextKeys` row AND its consumer ref forever, so `GovernanceFuel::revoke` cannot reap it
        // (an ~ED dust account lingers). This is BOUNDED — one leak per ever-removed validator on a small
        // committee-managed set — and preferred over the alternative (allow purge + floor over
        // `Validators ∩ NextKeys`), which re-opens a self-purge-to-halt liveness hole. The clean rework
        // (allow purge, floor over the keyed set, prune keyless ids in `new_session`) is a MAINNET-path
        // item, co-sequenced with the im-online wiring; see validator-set::do_remove_validator.
        if matches!(
            call,
            RuntimeCall::Session(pallet_session::Call::purge_keys { .. })
        ) {
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
    fn blocks_a_duplicated_committee_seat() {
        // `[A, A, A]` clears BOTH size rules (non-empty, `len() != 2`) while seating ONE real key.
        // `pallet_collective::set_members` only `sort()`s, so the duplicate reaches `Members` verbatim.
        // Checked before any storage read, so it holds without externalities.
        let a = AccountId::from([1u8; 32]);
        let dup = [a.clone(), a.clone(), a].to_vec();
        assert!(!CognoCallFilter::contains(&RuntimeCall::FollowerCommittee(
            pallet_collective::Call::set_members {
                new_members: dup,
                prime: None,
                old_count: 1
            }
        )));
    }

    #[test]
    fn a_duplicated_seat_leaves_the_authority_origin_unsatisfiable() {
        // WHY the distinctness guard exists — pinned to the REAL `AuthorityOrigin` rather than to a
        // restated `3/5`, so this fails for the right reason if the proportion ever changes.
        use frame_support::traits::EnsureOrigin;
        // `set_members([A, A, A])` seats one distinct key behind a denominator of 3. `DuplicateVote`
        // caps the reachable ayes at 1, so this is the BEST origin that member set can ever produce:
        let best_from_dup = pallet_collective::RawOrigin::<AccountId, Instance1>::Members(1, 3);
        assert!(
            AuthorityOrigin::try_origin(RuntimeOrigin::from(best_from_dup)).is_err(),
            "a duplicated 3-seat set can never satisfy AuthorityOrigin — the brick this guard prevents",
        );
        // ...whereas the honest 3-DISTINCT-seat set it imitates reaches the threshold at two ayes.
        let honest = pallet_collective::RawOrigin::<AccountId, Instance1>::Members(2, 3);
        assert!(AuthorityOrigin::try_origin(RuntimeOrigin::from(honest)).is_ok());
    }

    #[test]
    fn blocks_a_committee_over_max_members() {
        // `pallet_collective` only `log::error!`s an over-`MaxMembers` set; it does not reject one.
        let over = (0u8..=<Runtime as pallet_collective::Config<Instance1>>::MaxMembers::get()
            as u8)
            .map(|i| AccountId::from([i; 32]))
            .collect::<alloc::vec::Vec<_>>();
        assert!(!CognoCallFilter::contains(&RuntimeCall::FollowerCommittee(
            pallet_collective::Call::set_members {
                new_members: over,
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
    /// The sudo-free committee-brick guard AND the committee's break-glass, composed: a call
    /// dispatches only if the compile-time [`CognoCallFilter`] allows it AND it is not currently
    /// paused by the `TxPause` pallet (spec 211; overrides the `SolochainDefaultConfig`
    /// `Everything` filter).
    type BaseCallFilter = InsideBoth<CognoCallFilter, TxPause>;
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
/// accountability (the mutable authority set is gated by the 3-of-5 `AuthorityOrigin`).
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
    // The one remaining hand-estimated placeholder, deliberately DEFERRED: the pallet has no `#[benchmarks]`
    // module to generate from. Unlike the observer's `observe` and fuel's `regenerate`, `authorize_upgrade`
    // is neither Mandatory nor billed from a hook — it is a single committee-gated call that writes one
    // storage value, so an over-estimate costs a fraction of one 3-of-5 motion and can never crowd a block.
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
    /// Per-account PAYABILITY FLOOR: a `set_allowance` must fund at least the existential deposit PLUS fee
    /// headroom, so a granted seat can actually pay the fee-bearing admin extrinsics (propose/vote/close/
    /// set_keys). Fee withdrawal is `Preservation::Preserve` (reducible = balance − ED), so a grant of
    /// exactly the ED is unpayable yet still creates an allowance row — an unpayable seat that dilutes the
    /// governance quorum. `ED + 1 UNIT` (≈ 1000× the ED) buys many propose/vote/close cycles per
    /// `FuelRegenPeriod`; far below `MaxFuelAllowance`, so no legitimate small grant is blocked.
    pub const MinFuelAllowance: Balance = EXISTENTIAL_DEPOSIT + UNIT;
    /// Regeneration cadence: refill funded accounts toward their allowance once a minute (10 blocks at
    /// 6s/block). DEV-TUNED snappy so a drained member recovers quickly in the showcase; a longer cadence
    /// is a runtime-tunable constant change. The funded set is tiny (≤ MaxFundedAccounts), so the periodic
    /// mint loop is cheap.
    pub const FuelRegenPeriod: BlockNumber = MINUTES;
}

// Config invariants (compile-time): the payability floor must sit at/above the ED and at/below the ceiling,
// else `set_allowance` is either unsatisfiable (Min > Max) or fails to guarantee payability (Min < ED).
const _: () = assert!(
    MinFuelAllowance::get() > EXISTENTIAL_DEPOSIT,
    "MinFuelAllowance must be STRICTLY above the ED — an exactly-ED grant has zero reducible balance \
     (fees use Preservation::Preserve), so it could never pay a propose/vote/close fee (the very \
     unpayable-seat bug this floor exists to prevent)",
);
const _: () = assert!(
    MinFuelAllowance::get() <= MaxFuelAllowance::get(),
    "MinFuelAllowance must be <= MaxFuelAllowance (else no allowance is grantable)",
);

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
    // Payability floor: a grant must cover the ED + fee headroom, so a seated member can always pay
    // (an exactly-ED grant would seat an unpayable member that dilutes the quorum).
    type MinAllowance = MinFuelAllowance;
    // Comfortably covers MaxValidators (32) + FollowerMaxMembers (7) with headroom.
    type MaxFundedAccounts = ConstU32<64>;
    type RegenPeriod = FuelRegenPeriod;
    // Real benchmarked weights (spec 204). `regenerate(n)` is billed by the `on_initialize` hook on every
    // `RegenPeriod` block and is linear in the funded-set size, so it cannot be skipped or refunded — it
    // gets a measured number, not an estimate. At the `MaxFundedAccounts` ceiling (n = 64) the hook costs
    // ~9.3 ms, 0.47% of the 2 s `max_block`; the funded set today is single digits. The hand-estimated
    // placeholder this replaces OVER-charged by ~1.6x at that ceiling (it counted `TotalIssuance` as a
    // write per account, but it is one key rewritten n times), so it was conservative rather than unsafe —
    // this makes it honest.
    type WeightInfo = pallet_governance_fuel::weights::SubstrateWeight<Runtime>;
}

// ── The FollowerCommittee — the mutable k-of-t authority behind the crown jewels ──
//
// `pallet-collective` (one shared `Instance1`) holds a MUTABLE member set (rotation via
// `Collective::set_members`, gated by `SetMembersOrigin` = the committee's own `AuthorityOrigin`)
// and produces an `EnsureProportionAtLeast<3,5>` origin when a motion carries a 3-of-5 supermajority.
// That origin authorizes every privileged write — there is NO `EnsureRoot`/sudo fallback (sudo-free
// from genesis; index 6 vacant).
// The proposal lifecycle (`Proposed`/`Voted`/`Closed`/`Approved`/`Executed`) IS the per-action
// audit log. The gate before any mainnet run is exactly this 3-of-5 across five independent custody
// domains (see docs/D2-custody-runbook.md).
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
    // UPSTREAM reference weights, not generated here — a deliberate choice, not an oversight. Parity
    // measures these on the reference hardware the weight constants assume; the numbers a benchmark run on
    // this dev box would produce are calibrated to a machine no validator is required to match, which is
    // WORSE than upstream's for a pallet whose propose/close cost is a block-fill surface. `pallet_collective`
    // stays listed in `define_benchmarks!` so a real run on production-representative hardware can graduate
    // it later.
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
    // No proposal deposit/consideration in v1 (the committee is permissioned, not open). NOTE: a fuel-HOLD
    // deposit does NOT bound the proposal queue here, because governance-fuel regeneration refills the free
    // balance the hold draws from every period — so a hold is a rolling rate-gate, not a cap. A real D-1
    // anti-flood guard needs either total-balance-capped regen (so holds count against the ceiling) or a
    // per-member proposal counter; deferred as a deliberate decision, not wired blindly here.
    type Consideration = ();
}

/// The crown-jewel authority origin: a **3-of-5 supermajority** of the [`FollowerCommittee`]
/// (`EnsureProportionAtLeast<3,5>`, `needed = ceil(n*3/5)` so it works at every size — 1→1, 3→2, 5→3,
/// 7→5). cogno-chain is SUDO-FREE, so there is NO `EnsureRoot` fallback. Shared by the committee's own
/// self-policing origins, `cogno-gate::FollowerOrigin`, `microblog::ForceOrigin`,
/// `validator-set::AddRemoveOrigin`, `cardano-observer::EnforceOrigin`
/// (the weight-freeze control — the observer, not this origin, writes weight), and
/// `governed-upgrade::AuthorityOrigin` — so identity, validators, upgrades, and force-capacity all sit
/// behind ONE trust boundary.
pub type AuthorityOrigin = EnsureProportionAtLeast<AccountId, Instance1, 3, 5>;

// ── TxPause (index 20) — the committee break-glass (spec 211) ──────────────────────────────────────
//
// `pause((pallet_name, call_name))` / `unpause(..)` are gated by the SAME 3-of-5 [`AuthorityOrigin`]
// as every other privileged write; enforcement is `BaseCallFilter = InsideBoth<CognoCallFilter,
// TxPause>` (frame_system config above). Pausing `(pallet, "")`-style whole-pallet names is not a
// thing in this pallet — a motion pauses one `(pallet_name, call_name)` pair per call.

/// Calls that can NEVER be paused. Everything here is load-bearing for liveness or for recovery:
///
/// - Both INHERENTS (`CardanoObserver::observe`, `Timestamp::set`). Inherents dispatch with the
///   `None` origin, which carries `BaseCallFilter` like any other non-root origin — and a filtered
///   Mandatory dispatch is `BadMandatory`, so a paused inherent would discard EVERY block (a
///   chain-halt lever no pause should ever be able to reach).
/// - The whole `FollowerCommittee` pallet: propose/vote/close is the path that UN-pauses, so pausing
///   it would weld the break-glass shut (a 3-of-5 motion locking out the 3-of-5).
/// - The upgrade path (`GovernedUpgrade::authorize_upgrade` + the permissionless
///   `System::apply_authorized_upgrade`): the fix for whatever prompted a pause ships through it.
///
/// (`TxPause` itself needs no entry — the pallet refuses to pause its own calls.)
///
/// ⚠ The PALLET halves are never spelled as literals. `pallet_tx_pause` matches on the same
/// `(pallet_name, call_name)` strings `GetCallMetadata` derives from the `#[frame_support::runtime]`
/// declaration, so a literal here is anchored to nothing: rename a pallet in the runtime and a
/// whitelist entry silently stops matching, re-opening the very lever it exists to weld shut. Taking
/// each name from `<Pallet as PalletInfoAccess>::name()` makes the rename a COMPILE error (the type
/// alias must exist) and keeps the string the runtime's own. The CALL halves cannot be typed the same
/// way — there is no per-call type — so `whitelisted_names_exist_in_this_runtime` below re-derives
/// them from `RuntimeCall::get_call_names()`, i.e. from the runtime's metadata rather than from these
/// same literals, and fails on a typo or a renamed call.
pub struct TxPauseWhitelist;

/// The `(pallet, call)` pairs [`TxPauseWhitelist`] admits. An empty call name means WHOLE PALLET.
/// Split out so the unit test can walk exactly what `contains` matches on, instead of restating it.
fn tx_pause_whitelist_names() -> [(&'static str, &'static str); 5] {
    use frame_support::traits::PalletInfoAccess;
    [
        (<CardanoObserver as PalletInfoAccess>::name(), "observe"),
        (<Timestamp as PalletInfoAccess>::name(), "set"),
        (<FollowerCommittee as PalletInfoAccess>::name(), ""),
        (
            <GovernedUpgrade as PalletInfoAccess>::name(),
            "authorize_upgrade",
        ),
        (
            <System as PalletInfoAccess>::name(),
            "apply_authorized_upgrade",
        ),
    ]
}

impl Contains<pallet_tx_pause::RuntimeCallNameOf<Runtime>> for TxPauseWhitelist {
    fn contains(full_name: &pallet_tx_pause::RuntimeCallNameOf<Runtime>) -> bool {
        let (pallet, call) = full_name;
        let p = pallet.as_slice();
        let c = call.as_slice();
        tx_pause_whitelist_names()
            .iter()
            .any(|(wp, wc)| p == wp.as_bytes() && (wc.is_empty() || c == wc.as_bytes()))
    }
}

impl pallet_tx_pause::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
    type RuntimeCall = RuntimeCall;
    // Pause AND unpause both sit behind the one crown-jewel committee origin (sudo-free) — a pause
    // is an emergency governance action, and an unpause is the same committee undoing it.
    type PauseOrigin = AuthorityOrigin;
    type UnpauseOrigin = AuthorityOrigin;
    type WhitelistedCalls = TxPauseWhitelist;
    // Bounds the stored (pallet_name, call_name) strings. Far above every real name in this
    // runtime; an over-long name is treated as paused (fail-closed), per the pallet's contract.
    type MaxNameLen = ConstU32<256>;
    // UPSTREAM reference weights, not generated here — the same deliberate choice as
    // pallet-collective's (see the note there): two single-map committee-gated writes, measured by
    // Parity on reference hardware.
    type WeightInfo = pallet_tx_pause::weights::SubstrateWeight<Runtime>;
}

#[cfg(test)]
mod tx_pause_tests {
    use super::*;

    fn name(p: &[u8], c: &[u8]) -> pallet_tx_pause::RuntimeCallNameOf<Runtime> {
        (
            p.to_vec().try_into().expect("pallet name fits"),
            c.to_vec().try_into().expect("call name fits"),
        )
    }

    #[test]
    fn whitelist_covers_inherents_committee_and_the_upgrade_path() {
        // Never pausable: the two inherents (a paused Mandatory dispatch = BadMandatory = every
        // block discarded), the committee (the unpause path), and the upgrade path (the fix path).
        assert!(TxPauseWhitelist::contains(&name(
            b"CardanoObserver",
            b"observe"
        )));
        assert!(TxPauseWhitelist::contains(&name(b"Timestamp", b"set")));
        assert!(TxPauseWhitelist::contains(&name(
            b"FollowerCommittee",
            b"propose"
        )));
        assert!(TxPauseWhitelist::contains(&name(
            b"FollowerCommittee",
            b"vote"
        )));
        assert!(TxPauseWhitelist::contains(&name(
            b"GovernedUpgrade",
            b"authorize_upgrade"
        )));
        assert!(TxPauseWhitelist::contains(&name(
            b"System",
            b"apply_authorized_upgrade"
        )));
        // Pausable: the exploit surfaces a pause exists FOR — e.g. the unaudited CIP-8 binds.
        assert!(!TxPauseWhitelist::contains(&name(
            b"CognoGate",
            b"link_identity_signed"
        )));
        assert!(!TxPauseWhitelist::contains(&name(
            b"Microblog",
            b"post_message"
        )));
        assert!(!TxPauseWhitelist::contains(&name(
            b"CardanoObserver",
            b"set_enforcement"
        )));
    }

    /// The whitelist's call names re-derived from the RUNTIME's own metadata, not from the literals
    /// in `tx_pause_whitelist_names`. Without this the test above only proves the whitelist agrees
    /// with itself: rename `observe`, and `contains` stops matching the inherent while every
    /// assertion still passes — and a 3-of-5 `pause(("CardanoObserver","observe"))` motion is then
    /// accepted, filtering a Mandatory dispatch into `BadMandatory` and discarding EVERY block.
    /// (`get_call_names` is generated from the `#[frame_support::runtime]` declaration, so it moves
    /// with a rename and these literals do not.)
    #[test]
    fn whitelisted_names_exist_in_this_runtime() {
        use frame_support::traits::GetCallMetadata;
        let modules = <RuntimeCall as GetCallMetadata>::get_module_names();
        for (pallet, call) in tx_pause_whitelist_names() {
            assert!(
                modules.contains(&pallet),
                "whitelisted pallet `{pallet}` is not in this runtime"
            );
            if call.is_empty() {
                continue; // a whole-pallet entry names no call
            }
            let calls = <RuntimeCall as GetCallMetadata>::get_call_names(pallet);
            assert!(
                calls.contains(&call),
                "whitelisted call `{pallet}::{call}` is not in this runtime (renamed or typo'd)"
            );
        }
    }

    /// … and the other direction: a REAL call's own `get_call_metadata()` — the exact value
    /// `pallet_tx_pause` compares a stored pause against — lands inside the whitelist.
    #[test]
    fn a_real_inherent_calls_metadata_is_whitelisted() {
        use frame_support::traits::GetCallMetadata;
        let ts = RuntimeCall::Timestamp(pallet_timestamp::Call::set { now: 0 });
        let observe = RuntimeCall::CardanoObserver(pallet_cardano_observer::Call::observe {
            reference: Default::default(),
            inputs_commitment: [0u8; 32],
            changes: Default::default(),
            stake_changes: Default::default(),
            role_changes: Default::default(),
            pending: 0,
        });
        for call in [ts, observe] {
            let m = call.get_call_metadata();
            assert!(
                TxPauseWhitelist::contains(&name(
                    m.pallet_name.as_bytes(),
                    m.function_name.as_bytes()
                )),
                "the {}::{} inherent must never be pausable",
                m.pallet_name,
                m.function_name
            );
        }
    }

    #[test]
    fn a_paused_call_is_rejected_by_the_base_filter() {
        sp_io::TestExternalities::default().execute_with(|| {
            let call = RuntimeCall::CognoGate(pallet_cogno_gate::Call::link_identity_signed {
                cose_sign1: Default::default(),
                cose_key: Default::default(),
            });
            type Filter = InsideBoth<CognoCallFilter, TxPause>;
            // Unpaused: the composed BaseCallFilter admits it.
            assert!(<Filter as Contains<RuntimeCall>>::contains(&call));
            // Paused (as a 3-of-5 pause motion would store it): the SAME filter now rejects it.
            pallet_tx_pause::PausedCalls::<Runtime>::insert(
                name(b"CognoGate", b"link_identity_signed"),
                (),
            );
            assert!(!<Filter as Contains<RuntimeCall>>::contains(&call));
        });
    }
}

// ── MUTABLE Aura+GRANDPA authorities via pallet-session + pallet-validator-set ──
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
    // KeyDeposit MUST stay 0 while `CognoCallFilter` blocks `Session::purge_keys` (the keyless-phantom
    // floor-bypass guard). `purge_keys` is the ONLY path that releases a held key deposit and drops the
    // consumer ref, so a `KeyDeposit > 0` would permanently strand the deposit + consumer ref of any
    // committee-`remove_validator`'d or registered-but-never-seated account. To ever charge a deposit
    // (anti-spam on the validator-candidate registry), FIRST rework the floor: unblock purge and compute
    // `MinAuthorities` over `Validators ∩ Session::NextKeys` in `validator-set::do_remove_validator`
    // (its note sketches this), so the phantom bypass stays closed without an unconditional purge block.
    type KeyDeposit = ConstU128<0>;
}

/// Configure pallet-validator-set: the mutable Aura+GRANDPA validator set. `add_validator`
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
    // ── Talk-capacity constants. RETUNED IN SPEC 212 for a real posting rate; they were previously
    //    DEV-TUNED for a snappy, watchable showcase (a 25-block empty→full window) and the ~5 h window
    //    was carried as a mainnet TODO. Units are "micro-capacity"; one post ≈ BaseCost.
    //
    //    WHY NOW, and why it ships with the `ByAuthor` repage rather than after it: `MaxPostsPerAuthor`
    //    was the de-facto brake on sustained posting. It capped an author at 10_000 posts EVER, so a
    //    floor-lock account exhausted its lifetime quota in ~2_500 blocks and stopped. Removing it (the
    //    other half of this upgrade) hands the whole job to talk-capacity, which is already the ONLY
    //    anti-spam here — the social calls are feeless, so there is no fee floor under them, and
    //    `RuntimeBlockWeights` sets proof size to `u64::MAX`, so there is no block-level backstop
    //    either. Preprod never surfaced any of this because tADA is free.
    //
    //    THE TARGET: a ~5 h empty→full refill window at the 100-ADA `MinLock` floor, keeping the burst
    //    size and the ceiling knee that docs/ECONOMICS.md and docs/PROTOCOL-PARAMS.md already commit to.
    //    The window is `CapRatio / RegenPerBlock` blocks and is weight-independent, so:
    //        5 h at 6 s/block = 3_000 blocks  ⇒  CapRatio / RegenPerBlock = 3_000
    //    Everything else is a pure unit rescale of the bucket axis (60x) that holds every documented
    //    ratio fixed, so the only behaviour that moves is the refill speed (120x slower) and the new
    //    rate knee.
    //
    //    AT THE 100-ADA FLOOR LOCK (weight 10^8 lovelace):
    //      cap  = min(10^8·3_000, Ceiling) = 3·10^11        = 100 posts of burst   (unchanged)
    //      rate = 10^8·1                   = 10^8 / block   = 1 post / 30 blocks (~3 min)
    //      empty→full = 3·10^11 / 10^8     = 3_000 blocks   = 5 h   (was 25 blocks / 2.5 min)
    //      sustained  = 14_400 blocks-per-day / 30          = 480 posts/day (was 57_600)
    //    Worst-case permanent state growth is a SEPARATE calculation — 480 posts/day is the rate for a
    //    `BaseCost`-only post, while the biggest row comes from a 512-byte one. A 512-byte post costs
    //    4.536e9, so 45.4 blocks/post = 317 posts/day, and a top-level post writes FOUR rows: `Posts`
    //    (~648 B) + `ByAuthor` (~112 B) + `TopLevelByAuthor` (~112 B) + `TopLevelPosts` (~64 B) = ~936 B.
    //    That is ~290 KB/day/account.
    //    A 512-byte post costs BaseCost + 512·PerByteCost ≈ 1.5 posts of capacity, as before.
    //
    //    AT THE KNEE (Ceiling/CapRatio = 10^11 lovelace = 100_000 ADA locked, unchanged and already
    //    documented): cap = 3·10^14 = 100_000 posts, rate = 3·10^14/3_000 = 10^11/block = 33.3
    //    posts/block = 480_000 posts/day. Against a block ceiling of ~1_586 posts (post_message ≈ 945 µs
    //    of ref_time against `NORMAL_DISPATCH_RATIO · 2 s`), that is ~2.1 % of one block. BEFORE the
    //    retune the same account sustained 4_000 posts/block against a then-ceiling of ~2_012 — MORE
    //    than an entire block — so one maximally-staked account could monopolize the mempool
    //    outright. That is the concrete failure
    //    this prevents, and it is what makes ECONOMICS.md's "flattened at the top so no single whale
    //    can dominate the mempool" true rather than aspirational. See `Pallet::regen_per_block` for the
    //    second half of that fix: the rate is now derived from the ceiling, so both axes share ONE knee
    //    instead of the rate's sitting a full refill window further out (at 2.5M ADA under the old
    //    constants, and documented nowhere).
    pub const CapRatio: u128 = 3_000;
    pub const RegenPerBlock: u128 = 1;
    // 3·10^14 = 100_000 posts of bucket; the knee stays at 3·10^14/3_000 = 10^11 lovelace = 100k ADA.
    pub const Ceiling: u128 = 300_000_000_000_000;
    pub const BaseCost: u128 = 3_000_000_000;     // 1 post
    pub const PerByteCost: u128 = 3_000_000;      // BaseCost/1000, as before
    // A profile CREATE/OVERWRITE (set_profile / pin_post) is feeless but capacity-metered at this
    // STEEP price — ≈10 posts (10 × BaseCost). Profiles are a low-frequency mutable overwrite, so a
    // high capacity cost is the anti-spam: only the identity-bound owner can edit, and they cannot
    // churn it. The whole app stays feeless (a freshly-derived posting key never needs funding).
    // The TIDY-UP calls (clear_profile / unpin_post) are priced per-account in
    // `ProfileCapacityCost` below (0 with a row to clear, unpayable without), NOT at this constant.
    pub const ProfileCost: u128 = 30_000_000_000; // 10 × BaseCost
}

// The v9→v10 migration RESCALES every stored `Capacity.cap_last` by `CAPACITY_UNIT_RESCALE`, because
// the constants above moved the micro-capacity unit itself. That factor is a number in ANOTHER crate
// (`pallet_microblog::migrations::v10`) that has to mirror these values, and its own `post_upgrade`
// asserts against the same constant — so it agrees with itself and cannot catch a drift. Retune
// `BaseCost` (or the two constants the rescale's no-overflow argument rests on) again before spec 212
// is enacted, and every live bucket would be scaled by the wrong factor, silently.
//
// So pin it HERE, where both halves are knowable, at COMPILE time. A further retune fails the build.
const _: () = {
    use pallet_microblog::migrations::v10::{v9_constants, CAPACITY_UNIT_RESCALE};
    assert!(
        BaseCost::get() == v9_constants::BASE_COST * CAPACITY_UNIT_RESCALE,
        "BaseCost moved without updating pallet_microblog::migrations::v10::CAPACITY_UNIT_RESCALE — \
         the v9->v10 migration would rescale every live capacity bucket by the wrong factor"
    );
    // The migration's "multiplying cannot overflow the new ceiling" argument is only true while the
    // BOUND moved by the same factor: an old value clamped to `min(w·CAP_RATIO, CEILING)` times the
    // factor is still inside `min(w·CapRatio, Ceiling)`.
    assert!(
        CapRatio::get() == v9_constants::CAP_RATIO * CAPACITY_UNIT_RESCALE,
        "CapRatio moved by a different factor than BaseCost — the v9->v10 rescale could exceed the ceiling"
    );
    assert!(
        Ceiling::get() == v9_constants::CEILING * CAPACITY_UNIT_RESCALE,
        "Ceiling moved by a different factor than BaseCost — the v9->v10 rescale could exceed the ceiling"
    );
    // Not load-bearing for the rescale, but it is denominated in the same unit: a per-byte cost left
    // behind would silently re-price long posts relative to short ones.
    assert!(
        PerByteCost::get() == v9_constants::PER_BYTE_COST * CAPACITY_UNIT_RESCALE,
        "PerByteCost moved by a different factor than BaseCost — post pricing is no longer proportional"
    );
};

/// Prices `pallet-profile`'s feeless writes against microblog's ONE per-account capacity battery — the
/// [`pallet_microblog::ForeignCapacityCost`] seam that lets the profile pallet share the feeless+capacity
/// machinery without microblog ever naming the profile crate (no Cargo cycle).
///
/// The two CREATE/OVERWRITE calls (`set_profile`, `pin_post`) cost the flat, steep `ProfileCost` —
/// that price is their anti-spam. The two TIDY-UP calls (`clear_profile`, `unpin_post`) are priced
/// PER ACCOUNT (spec 211):
///
/// - `0` when the caller actually has the row to clear. `capacity_ceiling(0) == 0`, so a REVOKED
///   account (weight clamped to 0, capacity permanently 0) could otherwise never erase its own
///   profile or pin — defeating the stated design intent on `unpin_post` ("a revoked account with
///   capacity may still tidy up its own state"), which is why neither call has an identity gate.
///   Zero cost is not a churn farm: every clear/unpin requires a prior `set_profile`/`pin_post`
///   paid at the full `ProfileCost`.
/// - [`pallet_microblog::UNPAYABLE`] when there is nothing to clear: `CheckCapacity` then rejects the
///   no-op at the POOL as `InvalidTransaction::Call` (malformed, NOT retried — the same code as an
///   over-length post body, and deliberately not the retriable `ExhaustsResources` the client reads as
///   a rate limit), so pricing the tidy-up at 0 does not open a free-spam path for doomed calls. This
///   mirrors the dispatch-side `NoProfile`/`NotPinned` rejections, at the pool.
///
/// NOTE: this is CAPACITY cost (the talk-capacity battery), not FRAME weight — the calls still
/// carry their benchmarked dispatch weights.
pub struct ProfileCapacityCost;
impl pallet_microblog::ForeignCapacityCost<AccountId, RuntimeCall> for ProfileCapacityCost {
    fn cost(who: &AccountId, call: &RuntimeCall) -> Option<u128> {
        match call {
            RuntimeCall::Profile(pallet_profile::Call::clear_profile { .. }) => {
                if pallet_profile::Profiles::<Runtime>::contains_key(who) {
                    Some(0)
                } else {
                    Some(pallet_microblog::UNPAYABLE)
                }
            }
            RuntimeCall::Profile(pallet_profile::Call::unpin_post { .. }) => {
                if pallet_profile::PinnedPost::<Runtime>::contains_key(who) {
                    Some(0)
                } else {
                    Some(pallet_microblog::UNPAYABLE)
                }
            }
            RuntimeCall::Profile(_) => Some(ProfileCost::get()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod profile_capacity_cost_tests {
    use super::*;
    use pallet_microblog::ForeignCapacityCost;

    #[test]
    fn tidy_up_calls_price_per_account_and_writes_stay_steep() {
        sp_io::TestExternalities::default().execute_with(|| {
            let who = AccountId::from([9u8; 32]);
            let clear = RuntimeCall::Profile(pallet_profile::Call::clear_profile {});
            let unpin = RuntimeCall::Profile(pallet_profile::Call::unpin_post {});
            // Nothing to clear: both tidy-up calls are priced unpayable, so the pool rejects the
            // doomed no-op instead of including it free.
            assert_eq!(
                ProfileCapacityCost::cost(&who, &clear),
                Some(pallet_microblog::UNPAYABLE)
            );
            assert_eq!(
                ProfileCapacityCost::cost(&who, &unpin),
                Some(pallet_microblog::UNPAYABLE)
            );
            // With a row to clear: free — this is what lets a REVOKED account (capacity clamped to
            // 0 forever) still erase its own profile/pin.
            pallet_profile::Profiles::<Runtime>::insert(
                &who,
                pallet_profile::Profile {
                    display_name: Default::default(),
                    bio: Default::default(),
                    avatar: Default::default(),
                    banner: Default::default(),
                    location: Default::default(),
                    website: Default::default(),
                },
            );
            pallet_profile::PinnedPost::<Runtime>::insert(&who, 0u64);
            assert_eq!(ProfileCapacityCost::cost(&who, &clear), Some(0));
            assert_eq!(ProfileCapacityCost::cost(&who, &unpin), Some(0));
            // The CREATE/OVERWRITE calls keep the steep flat price, and non-profile calls stay
            // unpriced by this source.
            let set = RuntimeCall::Profile(pallet_profile::Call::pin_post { id: 1 });
            assert_eq!(
                ProfileCapacityCost::cost(&who, &set),
                Some(ProfileCost::get())
            );
            let remark = RuntimeCall::System(frame_system::Call::remark {
                remark: Default::default(),
            });
            assert_eq!(ProfileCapacityCost::cost(&who, &remark), None);
        });
    }
}

/// Configure pallet-microblog: feeless, capacity-metered posting, with the talk-capacity meter folded
/// into the pallet rather than split out. MaxLength = 512 is the v1 baseline; post ids are u64. The
/// `ForceOrigin` (the 3-of-5 committee) lets the operator prime a battery by hand; `IdentityGate`'s
/// first bind calls `on_first_bind`.
///
/// `MaxPostsPerAuthor = 10_000` used to sit here. Removed in spec 212 with the bounded-vec per-author
/// index (storage v10): it bricked an author permanently at the cap, and there is no per-post cost left
/// for it to bound. Sustained posting is now metered ONLY by talk-capacity, which is why the constants
/// below were retuned in the same upgrade.
impl pallet_microblog::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
    type MaxLength = ConstU32<512>;
    type CapRatio = CapRatio;
    type RegenPerBlock = RegenPerBlock;
    type Ceiling = Ceiling;
    type BaseCost = BaseCost;
    type PerByteCost = PerByteCost;
    // Per-action costs for the social engagement calls, all drawn from the SAME single talk-capacity
    // battery as posting. Relative to BaseCost (= 3_000_000_000, one post): a vote ≈ 0.4 of a post, a
    // follow ≈ 0.2. Both were rescaled with BaseCost in spec 212, holding those ratios exactly.
    // (quote_post reuses `post_cost`, so it has no constant here.)
    type VoteCost = ConstU128<1_200_000_000>;
    type FollowCost = ConstU128<600_000_000>;
    // Poll bounds: up to 4 options, each up to 80 bytes (the question reuses MaxLength = 512).
    type MaxPollOptions = ConstU32<4>;
    type MaxPollOptionLen = ConstU32<80>;
    // Governance poll anchor URL: a link to the off-chain proposal doc (GitHub/IPFS). 256 bytes covers a
    // long URL + an IPFS CID; the proposal BODY is never stored on-chain.
    type MaxAnchorUrlLen = ConstU32<256>;
    // Poll-duration window (spec 211): every new poll must carry a close deadline inside it.
    // Min 10 minutes — long enough that a poll cannot close before anyone could plausibly vote,
    // short enough that a quick preprod test poll stays convenient. Max 90 days — the outer bound
    // on how long a poll's weighted result may keep re-pricing before it is freezable; a longer
    // signal belongs in a new poll.
    type MinPollDuration = ConstU32<{ 10 * MINUTES }>;
    type MaxPollDuration = ConstU32<{ 90 * DAYS }>;
    // Gated by the 3-of-5 FollowerCommittee (sudo-free).
    type ForceOrigin = AuthorityOrigin;
    // Gate posting on a live Cardano-identity binding (the anti-Sybil anchor).
    type IdentityGate = CognoGate;
    // Profile pallet's feeless writes share this one battery, priced at `ProfileCost` and gated at the
    // pool by `CheckCapacity` — so the whole app is feeless with no second transaction-extension.
    type ForeignCost = ProfileCapacityCost;
    // The staker set for the LIVE weighted-tally join = the observer's currently-credited accounts. Capped
    // at `MaxScanned`; exactly the set of accounts with non-zero `VotingPower`. See `ObservedStakers`.
    type StakerSet = ObservedStakers;
    // Governance-poll chambers (spec 207): read each voter's observed roles + delegated-stake weight from
    // pallet-cardano-roles' `ObservedRoles`. See `ChamberRolesProvider`.
    type ChamberRoles = ChamberRolesProvider;
    // The staker set AND the role-holder set are both capped at the observer's `MaxScanned`; `close_poll`
    // uses this to declare its worst-case weight (then refunds to the rows actually scanned). Single source.
    //
    // ⚠ Since spec 215 this is a cap the READ SIDE imposes, not one the write side guarantees. The observer
    // no longer bounds how many accounts hold voting power, so above `MaxScanned` a poll tally joins over a
    // capped, storage-order subset of stakers rather than all of them. That is a real behaviour change at a
    // scale this chain is nowhere near (it has single-digit stakers), and fixing it properly means giving
    // `close_poll` a paged tally — a separate piece of work from removing the observer's cliff.
    type MaxObservedAccounts = <Runtime as pallet_cardano_observer::Config>::MaxScanned;
    type WeightInfo = pallet_microblog::weights::SubstrateWeight<Runtime>;
}

/// Observed-role provider for pallet-microblog's GOVERNANCE-POLL chambers (spec 207): each voter's live
/// role set + chamber weight, read from pallet-cardano-roles' observer-written `ObservedRoles` and lowered
/// to the primitive `(kind_index, display_id, delegated_stake)` triples microblog consumes (it cannot name
/// the on-wire `ObservedRole` type there without a Cargo cycle). Mirrors how `observed_role_pairs`
/// (apis.rs) folds roles into the badge — only read off-chain, for a `PollKind::Governance` poll.
pub struct ChamberRolesProvider;
impl pallet_microblog::ChamberRoles<AccountId> for ChamberRolesProvider {
    fn roles_of(who: &AccountId) -> alloc::vec::Vec<(u8, [u8; 28], u128)> {
        pallet_cardano_roles::Pallet::<Runtime>::observed_roles(who)
            .into_iter()
            .map(|r| (r.kind.index(), r.id, r.weight))
            .collect()
    }
    // The observed role-holder set — the `ObservedRoles` keys, capped at `MaxScanned` so the on-chain
    // chamber freeze (`close_poll`) stays bounded even against a map with stale rows — mirroring
    // `ObservedStakers::stakers`. The role axis cannot actually exceed the cap today: the observation is
    // scoped to the claimed credentials, and that scan is capped at the same value.
    fn role_holders() -> alloc::vec::Vec<AccountId> {
        let cap = <<Runtime as pallet_cardano_observer::Config>::MaxScanned as frame_support::traits::Get<
            u32,
        >>::get() as usize;
        pallet_cardano_roles::ObservedRoles::<Runtime>::iter_keys()
            .take(cap)
            .collect()
    }
}

/// Staker-set provider for pallet-microblog's live weighted-tally join: the accounts the `cardano-observer`
/// currently credits (`LastObservedStake`), which on a Cardano-observing chain is exactly the set with
/// non-zero `VotingPower` (the observer writes both in the same inherent and zeroes everything it
/// explicitly drops). Microblog stays free of a Cargo dependency on cardano-observer — the same
/// loose-coupling seam as `WeightApply`/`BeaconLookup`.
///
/// ⚠ The cap moved from the WRITE side to the READ side in spec 215. `LastObservedStake` used to be a
/// `BoundedVec<_, MaxObserved>` read whole in one go, so the join was bounded because the basis itself
/// could not be bigger. It is a StorageMap now and nothing bounds it, so the `.take(cap)` below is what
/// keeps `close_poll`'s declared worst case honest. Above the cap a tally joins over a storage-order
/// subset — see `MaxObservedAccounts` in the microblog config for why that is left as separate work.
///
/// FALLBACK for a no-observer chain (`--dev`/`local`): there the observer never runs, so `LastObservedStake`
/// stays EMPTY while genesis seeds `pallet_talk_stake::VotingPower` directly (`genesis_config_presets`).
/// Without a fallback every weighted vote/poll/reputation would read `0` on a dev chain even though voting
/// power is seeded. So when `LastObservedStake` is empty we derive the set from the `VotingPower` map keys
/// instead, capped the same way. This branch is UNREACHABLE on any chain that has ever observed: the
/// observer writes `LastObservedStake` and `VotingPower` together, so a non-empty `VotingPower` there
/// implies a non-empty `LastObservedStake` and the primary path is taken — the `VotingPower` map (which
/// keeps stale `0` rows) is never the canonical source in production.
pub struct ObservedStakers;
impl pallet_microblog::StakerSet<AccountId> for ObservedStakers {
    fn stakers() -> alloc::vec::Vec<AccountId> {
        let cap = <<Runtime as pallet_cardano_observer::Config>::MaxScanned as frame_support::traits::Get<
            u32,
        >>::get() as usize;
        let observed: alloc::vec::Vec<AccountId> =
            pallet_cardano_observer::LastObservedStake::<Runtime>::iter_values()
                .map(|(account, _total)| account)
                .take(cap)
                .collect();
        if !observed.is_empty() {
            return observed;
        }
        // No observation yet (dev/local genesis-seeded weight, or a chain before its first observation —
        // where `VotingPower` is likewise empty and this yields nothing).
        pallet_talk_stake::VotingPower::<Runtime>::iter_keys()
            .take(cap)
            .collect()
    }
}

/// Configure pallet-cogno-gate: the 1:1 Cardano-owner-Address ↔ posting-account binding —
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
    // Fans out to microblog AND cardano-roles; see `IdentityLifecycle`. Was `Microblog`, which
    // silently left a revoked account holding its verified role badge.
    type OnBind = IdentityLifecycle;
    // The Cardano network the on-chain self-proof binds for — derived from the ONE `CARDANO_NET`
    // cutover selector (spec 211), shared with cardano-roles so the two can never flip apart.
    type CardanoNetwork = CardanoNetworkId;
    type WeightInfo = pallet_cogno_gate::weights::SubstrateWeight<Runtime>;
}

/// Verifiable Cardano role tags (SPO / dRep / CC, index 19). `claim_role_signed` is the PERMISSIONLESS
/// self-proof — it reuses the cogno-gate crown-jewel CIP-8 verifier (`verify_bind_proof_role`) as a pure
/// function, so no committee trust is needed to claim; the 3-of-5 `AuthorityOrigin` gates only
/// `revoke_role` (the moderation ban, which tombstones the credential permanently). `IdentityGate =
/// CognoGate` — a role claim requires a payment-bound account (a Settings add-on, never onboarding).
/// `CardanoNetwork = 0` (testnet — the live preprod addresses). The `ObservedRoles` ledger the badge
/// reads is written ONLY by the CardanoObserver inherent (see the `RoleSink` wiring below). ⚠ MAINNET
/// PREREQUISITE: the role verifier shares the cogno-gate verifier's unaudited-crown-jewel status, and the
/// weights here are conservative hand-set placeholders (benchmark before mainnet).
impl pallet_cardano_roles::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
    // Gated by the 3-of-5 FollowerCommittee (sudo-free) — gates `revoke_role` only.
    type RoleAuthorityOrigin = AuthorityOrigin;
    // A role claim requires an onboarded (payment-bound) account.
    type IdentityGate = CognoGate;
    // Derived from the ONE `CARDANO_NET` cutover selector (spec 211), shared with cogno-gate.
    type CardanoNetwork = CardanoNetworkId;
    // The cap on the per-block claimed-credential scan that scopes the node's db-sync role query. Taken
    // from the observer's own Config so the two cannot drift. It is no longer "the same cap the observer
    // bounds its observation by" — nothing bounds that since spec 215 — but the scan cap is load-bearing
    // for its own reason: `claim_role_signed` is feeless and bare-unsigned.
    type MaxScanned = <Runtime as pallet_cardano_observer::Config>::MaxScanned;
    type WeightInfo = ();
}

/// Beacon → bound account adapter for pallet-cardano-observer: the beacon name IS the cogno-gate
/// `AccountOf` key (the 32-byte L1 beacon `token_name`), so the in-runtime lookup is a direct read.
pub struct BeaconLookup;
impl pallet_cardano_observer::BeaconResolver<AccountId> for BeaconLookup {
    fn resolve(beacon: &[u8; 32]) -> Option<AccountId> {
        pallet_cogno_gate::AccountOf::<Runtime>::get(beacon)
    }
}

/// The identity bind/revoke lifecycle, fanned out to every pallet that holds per-identity state.
///
/// `pallet-cogno-gate` calls this through its `OnBind` seam. It is a RUNTIME-side adapter for the same
/// no-Cargo-cycle reason as [`RoleApply`] / [`RoleLookup`]: only the runtime may name every pallet, so
/// the gate depends on a trait rather than on its downstream crates.
///
/// It exists because `revoke` used to tear down only what cogno-gate itself owns (the identity maps, the
/// stake anchor) plus microblog's capacity/provider state — and stopped there. `pallet-cardano-roles`
/// was added later and was never wired in, so a committee ban left the account holding a live,
/// observer-verified Cardano role badge forever: `MicroblogApi::profile` reported `is_allowed: false`
/// and a verified SPO/dRep chip in the same response, and the credential stayed locked 1:1 against its
/// real holder. Anything that grows per-identity state from here on belongs in `on_revoke` below.
pub struct IdentityLifecycle;
impl pallet_microblog::OnIdentityBind<AccountId> for IdentityLifecycle {
    fn on_bind(who: &AccountId) {
        // Capacity row + the single provider reference. Roles are claimed separately (and only by an
        // already-bound account), so there is nothing to seed for them here.
        pallet_microblog::Pallet::<Runtime>::on_bind(who);
    }

    fn on_revoke(who: &AccountId) {
        pallet_microblog::Pallet::<Runtime>::on_revoke(who);
        // At most 3 claim rows + 3 index rows + 1 badge row — `RoleClaimOf` is keyed by `RoleKind`,
        // which has three variants — so this cannot blow the `revoke` weight.
        let _ = pallet_cardano_roles::Pallet::<Runtime>::purge_account_roles(who);
    }
}

/// Weight-application adapter for pallet-cardano-observer.
///
/// Deliberately a ONE-LINE delegation. The going-forward-only rule — settle the capacity bucket at the OLD
/// weight, then write `AllowedStake`, and only when the weight actually changed — is not a property of this
/// adapter; it is a property of the capacity meter, so it lives with the meter in
/// [`pallet_microblog::Pallet::apply_observed_weight`], which is the SOLE way weight may enter the chain.
/// (It used to live here, hand-copied into microblog's test mock so the tests could reach it — which meant
/// nothing tested the code that actually ran. Now the mock drives the same function the runtime does.)
///
/// The lazy capacity meter reads the live weight, so `cap`/`rate` follow it and `weight = 0` collapses
/// capacity on the next read — deliberately NO per-block refill (that would defeat the spam meter).
pub struct WeightApply;
impl pallet_cardano_observer::WeightSink<AccountId> for WeightApply {
    fn set_weight(who: &AccountId, weight: u128) {
        pallet_microblog::Pallet::<Runtime>::apply_observed_weight(who, weight);
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
        // CAPPED at the observer's `MaxScanned`, so a bare-unsigned, feeless `link_stake_signed` cannot
        // grow the per-block db-sync scope without bound and stall the sole weight writer. The scan + the
        // operator warning live in cogno-gate, next to the map and the log target.
        pallet_cogno_gate::Pallet::<Runtime>::bound_stake_credentials_capped(
            <<Runtime as pallet_cardano_observer::Config>::MaxScanned as sp_core::Get<u32>>::get(),
        )
    }
}

/// Voting-power-application adapter: write the talk-stake `VotingPower` (the total-stake VOTE weight).
/// Distinct from `WeightApply` (which sets the locked-ADA `AllowedStake` deposit weight + primes the
/// microblog capacity row) — voting power touches neither capacity nor `AllowedStake`, so there is no
/// bucket to settle here. The `previous != weight` guard is the same per-block economy as `WeightApply`'s:
/// the observer re-derives the full stake set every block, and an unchanged account must not cost a write
/// + a `VotingPowerSet` event in a Mandatory inherent.
pub struct VotingPowerApply;
impl pallet_cardano_observer::VotingPowerSink<AccountId> for VotingPowerApply {
    fn set_voting_power(who: &AccountId, weight: u128) {
        let previous = pallet_talk_stake::VotingPower::<Runtime>::get(who);
        if previous != weight {
            pallet_talk_stake::Pallet::<Runtime>::apply_voting_power(who, weight);
        }
    }
}

/// Role credential → bound account adapter for pallet-cardano-observer (spec 206): resolve the observed
/// role credential via the reverse map named by its `RoleSource` — the roles-pallet `RoleCredIndex` for
/// the claim-based sources, and cogno-gate `AccountOfStakeCred` for the free `SpoOwner` path.
pub struct RoleLookup;
impl pallet_cardano_observer::RoleResolver<AccountId> for RoleLookup {
    fn resolve(
        source: pallet_cardano_observer::RoleSource,
        credential: &[u8; 28],
    ) -> Option<AccountId> {
        use pallet_cardano_observer::RoleSource;
        use pallet_cardano_roles::RoleKind;
        match source {
            RoleSource::SpoCalidus => {
                pallet_cardano_roles::RoleCredIndex::<Runtime>::get(RoleKind::Spo, credential)
            }
            RoleSource::SpoOwner => {
                pallet_cogno_gate::AccountOfStakeCred::<Runtime>::get(credential)
            }
            RoleSource::DRep => {
                pallet_cardano_roles::RoleCredIndex::<Runtime>::get(RoleKind::DRep, credential)
            }
            RoleSource::Committee => {
                pallet_cardano_roles::RoleCredIndex::<Runtime>::get(RoleKind::Committee, credential)
            }
        }
    }
}

/// Observed-role sink adapter: overwrite `who`'s full observed-role set in pallet-cardano-roles (the map
/// the profile badge reads). `apply_roles` is idempotent (no write/event on an unchanged re-derive) and
/// clears the row when the set is empty (the observer's unlock clamp).
pub struct RoleApply;
impl pallet_cardano_observer::RoleSink<AccountId> for RoleApply {
    fn set_roles(who: &AccountId, roles: &[(u8, [u8; 28], u128)]) {
        use pallet_cardano_roles::{ObservedRole, ObservedRoleSet, RoleKind};
        // Build the bounded set in TWO PASSES (spec 211), TRUNCATING not clearing: NON-SPO roles
        // (dRep, CC — at most one of each) first, then fill the remaining slots with SPO entries.
        //
        // The canonical `role_entries` order sorts on `RoleSource` first, which puts EVERY SPO entry
        // ahead of every dRep/CC one — so a single pass truncating at the cap silently dropped a
        // large mSPO's dRep badge AND its dRep-chamber weight once its pool count neared the cap
        // (the old "⚠ MAINNET PREREQUISITE (a deterministic under-count)" this fixes). Two passes
        // reserve the non-SPO badges by construction; only surplus SPO pools past the cap are
        // dropped, deterministically (the slice order within each class is preserved). Both passes
        // are deterministic, so every node stores the identical set. Side effect, priced in: the
        // stored order of an EXISTING multi-role account changes once (non-SPO now first), costing a
        // one-time `RolesUpdated` rewrite per such account on the first enforcing observation after
        // the upgrade — a handful of rows on preprod, none at a fresh mainnet genesis.
        //
        // The old `try_from(set).unwrap_or_default()` was all-or-nothing — one badge over the cap
        // wiped the ENTIRE set to empty. `weight` (spec 207) is the governance-poll chamber weight,
        // carried through verbatim.
        //
        // The non-SPO pass is itself CAPPED, at `NON_SPO_RESERVE`. "At most one of each" is what the
        // reduction emits today, but nothing in this signature enforces it — and if a future reduction
        // ever emitted a handful of dRep/CC credentials for one account, an uncapped first pass would
        // fill all 16 slots and drop EVERY SPO badge: the exact inverse of the bug the two passes fix,
        // and just as silent. Reserving a small, fixed prefix bounds the trade in both directions —
        // non-SPO badges can never be starved by pools, and pools can never be starved by badges.
        const NON_SPO_RESERVE: usize = 4;

        let mut bounded = ObservedRoleSet::default();
        'fill: for pass_spo in [false, true] {
            for (kind_ix, id, weight) in roles {
                let kind = match kind_ix {
                    0 if pass_spo => RoleKind::Spo,
                    1 if !pass_spo => RoleKind::DRep,
                    2 if !pass_spo => RoleKind::Committee,
                    _ => continue,
                };
                if !pass_spo && bounded.len() >= NON_SPO_RESERVE {
                    continue; // the non-SPO prefix is full — leave the rest of the set for pools
                }
                if bounded
                    .try_push(ObservedRole {
                        kind,
                        id: *id,
                        weight: *weight,
                    })
                    .is_err()
                {
                    // At the cap — keep what fits (deterministically), drop the rest. Break out of
                    // BOTH loops: a plain `break` would only end this pass and then re-walk the whole
                    // slice in the next one, every `try_push` failing, inside a Mandatory inherent.
                    break 'fill;
                }
            }
        }
        pallet_cardano_roles::Pallet::<Runtime>::apply_roles(who, bounded);
    }
}

#[cfg(test)]
mod identity_lifecycle_tests {
    use super::*;
    use pallet_cardano_roles::{ObservedRole, ObservedRoleSet, RoleKind};
    use pallet_microblog::OnIdentityBind;

    /// Revoking a binding must tear down the account's CARDANO ROLES, not just cogno-gate's own maps
    /// and microblog's capacity.
    ///
    /// This drives the hook through `<Runtime as pallet_cogno_gate::Config>::OnBind` — the associated
    /// type the pallet actually calls — rather than through `IdentityLifecycle` by name. That is the
    /// whole point: the bug was never a broken function, it was that cogno-gate's `OnBind` pointed at
    /// `Microblog`, which knows nothing about roles. Re-point it there and this test fails; assert
    /// against `IdentityLifecycle` directly and it would keep passing while the runtime stayed broken.
    #[test]
    fn revoking_a_binding_purges_the_accounts_role_badges() {
        sp_io::TestExternalities::default().execute_with(|| {
            let who = AccountId::from([9u8; 32]);
            let cred = [0xA1u8; 28];

            pallet_cardano_roles::RoleClaimOf::<Runtime>::insert(&who, RoleKind::Spo, cred);
            pallet_cardano_roles::RoleCredIndex::<Runtime>::insert(RoleKind::Spo, cred, &who);
            let badge: ObservedRoleSet = alloc::vec![ObservedRole {
                kind: RoleKind::Spo,
                id: cred,
                weight: 1_000,
            }]
            .try_into()
            .expect("one badge fits");
            pallet_cardano_roles::ObservedRoles::<Runtime>::insert(&who, badge);

            type Hook = <Runtime as pallet_cogno_gate::Config>::OnBind;
            <Hook as OnIdentityBind<AccountId>>::on_revoke(&who);

            assert!(
                !pallet_cardano_roles::RoleClaimOf::<Runtime>::contains_key(&who, RoleKind::Spo),
                "a banned account must not keep its role claim",
            );
            assert!(
                !pallet_cardano_roles::RoleCredIndex::<Runtime>::contains_key(RoleKind::Spo, cred),
                "the credential must be freed for its real holder",
            );
            assert!(
                pallet_cardano_roles::ObservedRoles::<Runtime>::get(&who).is_empty(),
                "the observed badge is what profiles and chamber tallies read — it must go too",
            );
        });
    }
}

#[cfg(test)]
mod role_apply_tests {
    use super::*;
    use pallet_cardano_observer::RoleSink;
    use pallet_cardano_roles::RoleKind;

    #[test]
    fn truncation_keeps_non_spo_badges_and_drops_surplus_pools() {
        sp_io::TestExternalities::default().execute_with(|| {
            let who = AccountId::from([7u8; 32]);
            // The canonical order puts every SPO entry first: 16 pools (already at the cap), then
            // the operator's dRep and CC badges. A single-pass fill dropped both badges.
            let mut roles: alloc::vec::Vec<(u8, [u8; 28], u128)> =
                (0..16u8).map(|i| (0u8, [i; 28], 1u128)).collect();
            roles.push((1, [0xD0; 28], 5));
            roles.push((2, [0xC0; 28], 0));
            RoleApply::set_roles(&who, &roles);
            let stored = pallet_cardano_roles::Pallet::<Runtime>::observed_roles(&who);
            assert_eq!(stored.len(), 16, "filled to the cap");
            // The non-SPO badges survive (filled first), in slice order, ahead of the pools …
            assert_eq!(stored[0].kind, RoleKind::DRep);
            assert_eq!(stored[1].kind, RoleKind::Committee);
            // … and only the surplus SPO pools were dropped (14 of 16 fit).
            assert_eq!(
                stored.iter().filter(|r| r.kind == RoleKind::Spo).count(),
                14
            );
            // An under-cap account keeps every role.
            let small = AccountId::from([8u8; 32]);
            RoleApply::set_roles(&small, &[(0, [1; 28], 1), (1, [2; 28], 2)]);
            assert_eq!(
                pallet_cardano_roles::Pallet::<Runtime>::observed_roles(&small).len(),
                2
            );
        });
    }

    /// The reserve is bounded in BOTH directions. Reserving the non-SPO badges must not become a way
    /// to starve the pools: an account handed more dRep/CC entries than the reserve keeps only the
    /// reserve's worth, and every remaining slot still goes to SPO badges.
    #[test]
    fn the_non_spo_reserve_cannot_starve_the_spo_badges() {
        sp_io::TestExternalities::default().execute_with(|| {
            let who = AccountId::from([9u8; 32]);
            // 16 pools (the cap on its own) plus EIGHT dRep entries — twice the reserve. Nothing in
            // `RoleSink`'s signature forbids this; an uncapped first pass would keep all eight and
            // drop every pool.
            let mut roles: alloc::vec::Vec<(u8, [u8; 28], u128)> =
                (0..16u8).map(|i| (0u8, [i; 28], 1u128)).collect();
            roles.extend((0..8u8).map(|i| (1u8, [0xD0 + i; 28], 5u128)));
            RoleApply::set_roles(&who, &roles);
            let stored = pallet_cardano_roles::Pallet::<Runtime>::observed_roles(&who);
            assert_eq!(stored.len(), 16, "filled to the cap");
            assert_eq!(
                stored.iter().filter(|r| r.kind == RoleKind::DRep).count(),
                4,
                "the non-SPO prefix is capped at the reserve"
            );
            assert_eq!(
                stored.iter().filter(|r| r.kind == RoleKind::Spo).count(),
                12,
                "every remaining slot still goes to the pools"
            );
        });
    }
}

/// The claimed role credentials, for the node-side IDP (via the `CardanoObserverApi`): enumerate the
/// roles-pallet `RoleCredIndex` keys per role at the parent block's state. The `SpoOwner` free path reuses
/// [`BoundStakeCreds`].
pub struct BoundRoleCreds;
impl pallet_cardano_observer::BoundRoleCredentials for BoundRoleCreds {
    fn claimed_calidus() -> alloc::vec::Vec<[u8; 28]> {
        pallet_cardano_roles::Pallet::<Runtime>::claimed_credentials(
            pallet_cardano_roles::RoleKind::Spo,
        )
    }
    fn claimed_dreps() -> alloc::vec::Vec<[u8; 28]> {
        pallet_cardano_roles::Pallet::<Runtime>::claimed_credentials(
            pallet_cardano_roles::RoleKind::DRep,
        )
    }
    fn claimed_committee() -> alloc::vec::Vec<[u8; 28]> {
        pallet_cardano_roles::Pallet::<Runtime>::claimed_credentials(
            pallet_cardano_roles::RoleKind::Committee,
        )
    }
}

// ── The Cardano-network cutover selector (spec 211) ────────────────────────────────────────────────
//
// Every network-dependent constant the observation + identity paths run on derives from the ONE
// `CARDANO_NET` selector below, so a mainnet cutover flips ONE line and cannot be partial. Before
// this, six symbols had to move together (the two Shelley anchors, the stability window, the min
// lock, the vault policy id, and `CardanoNetwork` declared TWICE), and a partial flip failed
// SILENTLY: preprod anchors on a mainnet chain derive a reference slot years behind the real tip,
// the node and runtime share the anchor so `ReferenceTooFresh` never fires, `config_check` prints
// "synced", every real lock is dropped by `created > reference_slot`, `ObservationApplied` fires
// every block crediting nobody, and `Stalled` never arms — everything reports healthy while every
// user's locked ADA earns zero weight.
//
// VERSIONING of a flip: it changes only `#[pallet::constant]` VALUES — no call/storage/event/
// extension shape moves, so no PAPI descriptor regen and no `transaction_version` change. But
// SHIPPING it to a LIVE chain is still a runtime upgrade, and every live upgrade bumps
// `spec_version`: `System::apply_authorized_upgrade` refuses a non-increasing spec, and the
// deployed frontend blocks posting against a chain whose spec differs from its build (the lockstep
// FE deploy). On the FRESH-GENESIS mainnet path there is no in-place upgrade, so the flip rides the
// genesis runtime with no bump of its own. (docs/PROTOCOL-PARAMS.md states the same rule.)
//
// Deliberate mirrors OUTSIDE the runtime that a cutover still owns separately: the node's
// `gen-chainspec` base shape, the frontend's Cardano network id, and the cogno-dbsync test
// fixtures. Co-sequence the flip with the ≥3-producer cutover; at the mainnet stability depth
// db-sync must retain history back to the reference (docs/IN-PROTOCOL-OBSERVATION.md).

/// Which Cardano network this runtime observes and binds identities for.
#[derive(PartialEq, Eq, Clone, Copy)]
pub enum CardanoNet {
    Preprod,
    Mainnet,
}

/// ⚠ THE one line a mainnet cutover flips.
const CARDANO_NET: CardanoNet = CardanoNet::Preprod;

/// The live `talk_vault` policy id (== vault script hash, contracts/vault.json:
/// 168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7). NETWORK-INDEPENDENT: a Plutus script
/// hash does not embed a network id, and the mainnet decision is to redeploy the SAME applied script
/// (keeping the 100-ADA floor), so both arms below share it. Consensus-pinned; the node reads it via
/// the CardanoObserverApi so every node queries the SAME Cardano policy. ⚠ moving the live contract
/// hash orphans the deployed vault — if contracts change, update this to match the new applied hash.
const TALK_VAULT_POLICY_ID: [u8; 28] = [
    0x16, 0x8a, 0x97, 0x10, 0xe9, 0x91, 0xb7, 0x68, 0x42, 0x6b, 0x58, 0x01, 0x1f, 0xeb, 0xec, 0x0f,
    0xa3, 0xc5, 0xff, 0x6b, 0xeb, 0x49, 0x06, 0x5c, 0xc5, 0x24, 0x89, 0xc7,
];

/// The full per-network parameter set — one struct so nothing can be flipped alone.
struct CardanoNetParams {
    /// The CIP-19 address-header network id the CIP-8 binds verify against (0 testnet, 1 mainnet).
    network_id: u8,
    /// The network's Shelley-era anchor — NOT Byron `systemStart`. Slot arithmetic counts from here.
    shelley_start_unix: u64,
    shelley_start_slot: u64,
    /// The observation stability window in slots (the no-rollback horizon the reference must trail).
    stability_slots: u64,
    /// The L1 `min_lock` floor (lovelace); below it, observed lovelace maps to weight 0.
    min_lock: u128,
    /// The `talk_vault` policy id to observe.
    vault_policy_id: [u8; 28],
}

const CARDANO_PARAMS: CardanoNetParams = match CARDANO_NET {
    // PREPROD (live today). Shelley begins at slot 86_400 / unix 1_655_769_600 after a 20-day Byron
    // prefix. The 600-slot (~10 min) stability window is a deliberate TESTNET-OBSERVABILITY choice —
    // preprod's real 3k/f is the same 129_600 as mainnet's — exactly like `MinAuthorities = 1`: run
    // relaxed while testing here, and the Mainnet arm below carries the production value.
    CardanoNet::Preprod => CardanoNetParams {
        network_id: 0,
        shelley_start_unix: 1_655_769_600,
        shelley_start_slot: 86_400,
        stability_slots: 600,
        min_lock: 100_000_000,
        vault_policy_id: TALK_VAULT_POLICY_ID,
    },
    // MAINNET (the cutover target). Shelley begins at slot 4_492_800 / unix 1_596_059_091
    // (2020-07-29T21:44:51Z, epoch 208). ⚠ Verify both against the mainnet shelley-genesis file at
    // cutover. Stability = 3k/f = 129_600 slots ≈ 36 h (k=2160, f=0.05).
    CardanoNet::Mainnet => CardanoNetParams {
        network_id: 1,
        shelley_start_unix: 1_596_059_091,
        shelley_start_slot: 4_492_800,
        stability_slots: 129_600,
        min_lock: 100_000_000,
        vault_policy_id: TALK_VAULT_POLICY_ID,
    },
};

// Compile-time cutover guards: deriving everything from one selector already makes a PARTIAL flip
// unrepresentable; these asserts additionally stop a TYPO edit inside one arm from building.
const _: () = {
    match CARDANO_NET {
        CardanoNet::Preprod => {
            assert!(
                CARDANO_PARAMS.network_id == 0,
                "preprod binds testnet addresses"
            );
            assert!(
                CARDANO_PARAMS.shelley_start_slot == 86_400
                    && CARDANO_PARAMS.shelley_start_unix == 1_655_769_600,
                "preprod Shelley anchor drifted from the published genesis"
            );
        }
        CardanoNet::Mainnet => {
            assert!(
                CARDANO_PARAMS.network_id == 1,
                "mainnet binds mainnet addresses"
            );
            assert!(
                CARDANO_PARAMS.stability_slots >= 129_600,
                "a mainnet build must run the full 3k/f stability window — the relaxed \
                 observability window is a labeled-testnet-only choice"
            );
            assert!(
                CARDANO_PARAMS.shelley_start_slot == 4_492_800
                    && CARDANO_PARAMS.shelley_start_unix == 1_596_059_091,
                "mainnet Shelley anchor drifted from the published genesis"
            );
        }
    }
    assert!(
        CARDANO_PARAMS.min_lock == 100_000_000,
        "the 100-ADA floor is a cross-network commitment (the vault is reused only if it holds)"
    );
};

parameter_types! {
    pub const ObsStabilitySlots: u64 = CARDANO_PARAMS.stability_slots;
    pub const ObsShelleyStartUnix: u64 = CARDANO_PARAMS.shelley_start_unix;
    pub const ObsShelleyStartSlot: u64 = CARDANO_PARAMS.shelley_start_slot;
    pub const ObsMinLock: u128 = CARDANO_PARAMS.min_lock;
    pub const ObsVaultPolicyId: [u8; 28] = CARDANO_PARAMS.vault_policy_id;
    /// The one network id BOTH CIP-8-verifying pallets (cogno-gate, cardano-roles) read — they used
    /// to declare `ConstU8<0>` independently, which is exactly the partial-flip surface this
    /// selector removes.
    pub const CardanoNetworkId: u8 = CARDANO_PARAMS.network_id;
}

/// Benchmark-only setup for pallet-cardano-observer. The pallet reaches cogno-gate / talk-stake /
/// microblog only through the resolver + sink seams (no Cargo cycle), so its benchmark cannot bind an
/// identity or seed a weight itself. This writes those rows directly, and every one of them is load-bearing
/// for the WORST CASE — seed them wrong and the benchmark prices the cheap path:
///
/// - `CognoGate::AccountOf` / `AccountOfStakeCred`: the bindings the resolvers read. An UNBOUND entry is
///   `continue`d — the cheapest possible per-entry path.
/// - `TalkStake::AllowedStake` / `VotingPower`, seeded to `ObsMinLock`: the benchmark observes
///   `MinLock + 1 + i`, which always differs, so `WeightApply`/`VotingPowerApply`'s `previous != weight`
///   guard takes the WRITE branch rather than the no-op fast path.
/// - The microblog capacity row: `settle_capacity_at` writes only when a row EXISTS and was last stamped
///   before the current block, so without it the settle write is never measured. (The benchmark advances a
///   block after this setup for the second half of that condition.)
#[cfg(feature = "runtime-benchmarks")]
pub struct ObserverBenchSetup;
#[cfg(feature = "runtime-benchmarks")]
impl pallet_cardano_observer::BenchmarkSetup<AccountId> for ObserverBenchSetup {
    fn bench_bind_beacon(beacon: &[u8; 32], i: u32) {
        let who = Self::bench_account(i);
        let seed = <ObsMinLock as frame_support::traits::Get<u128>>::get();
        pallet_cogno_gate::AccountOf::<Runtime>::insert(beacon, who.clone());
        pallet_talk_stake::AllowedStake::<Runtime>::insert(&who, seed);
        pallet_microblog::Pallet::<Runtime>::on_first_bind(&who);
    }

    fn bench_bind_stake_cred(cred: &[u8; 28], i: u32) {
        let who = Self::bench_account(i);
        let seed = <ObsMinLock as frame_support::traits::Get<u128>>::get();
        pallet_cogno_gate::AccountOfStakeCred::<Runtime>::insert(cred, who.clone());
        pallet_talk_stake::VotingPower::<Runtime>::insert(&who, seed);
    }

    fn bench_account(i: u32) -> AccountId {
        frame_benchmarking::account("cardano-observer", i, 0)
    }
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
/// validator must run cardano-node + Cardano db-sync. See docs/IN-PROTOCOL-OBSERVATION.md.
impl pallet_cardano_observer::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
    // Max CHANGES per axis per block. A churn batch size, NOT a population bound — spec 215 removed the
    // population bound entirely, and this is what replaced it. Nothing caps how many identities may hold
    // weight; what this caps is how much of a change set one block carries, with the rest draining over the
    // following blocks.
    //
    // Sizing is now purely a block-budget question, because overrunning it costs latency rather than
    // correctness. The worst case is three full pages, and the benchmarked cost puts that comfortably
    // inside the block:
    //
    //   observe( 256, 256, 256) = 0.229 s = 11.4% of max_block (2 s) — three full pages, the ceiling
    //   observe(   7,   2,   7) = 0.006 s =  0.3% — a busy block on a chain the size of this one
    //   observe(   0,   0,   0) = 0.001 s =  0.03% — a QUIET block, which is almost all of them
    //
    // That last line is the real win and it is worth stating plainly: the full-snapshot design charged
    // ~47 ms (2.4% of every block) forever just to re-observe a set that had not moved, because per-block
    // cost was O(participants). A delta makes a quiet block cost ~0.58 ms — 80x less — and, more to the
    // point, that figure does not grow as the chain does.
    //
    // 256 is ~50x more churn than a 6 s window can realistically deliver (256 vault UTxO movements per
    // block is ~43 Cardano tx/s against one script address, sustained). The one case that genuinely
    // exceeds it is a BOOTSTRAP — a fresh chain, or the first observation after the v0 -> v1 migration
    // re-derives every value — and that drains at 256 per block, so even a 100k-identity chain is caught
    // up in ~7 minutes, once. It is not on any critical path.
    //
    // The old fitted base of ~42.6 ms was a regression artifact (with four components sweeping to 1024
    // there was no datapoint anywhere near the origin, so the intercept was pure extrapolation). Three
    // components over a 256 range put real samples near it, and the fitted base fell to 0.185 ms — which
    // is why the quiet-block figure above can be read as a cost rather than as a charge.
    //
    // ⚠ RAISING or LOWERING this is safe in a way the old `MaxObserved` was not. Lowering it used to be a
    // brick vector (the clamp bases were `BoundedVec<_, MaxObserved>`, so a live vec longer than a lowered
    // bound failed to decode and `ValueQuery` handed back an EMPTY basis, stranding the weight of every
    // account that had since unlocked). The bases are StorageMaps now — no length prefix to overrun, every
    // row decodes on its own — so this bound touches only how fast a change set drains.
    type MaxChangesPerBlock = ConstU32<256>;
    // Max observed roles per ACCOUNT — a per-identity bound, never a population one.
    //
    // DOUBLE `pallet_cardano_roles::MAX_OBSERVED_ROLES_PER_ACCOUNT` (16), so that in practice the sink's
    // truncation is the only one that acts and the observer hands it a complete set.
    //
    // ⚠ Sizing does NOT make the observer's own cut safe, and it is not what makes it safe. An account
    // with more than 32 role entries reaches this bound however generous it is, and the canonical role
    // order puts every SPO entry ahead of every dRep/CC one — so a first-N cut here would drop exactly the
    // badges the sink's two-pass reserve exists to protect, one layer upstream of where that fix lives.
    // `Pallet::bounded_roles` therefore reserves non-SPO slots itself. This value only decides how often
    // either reserve has to act.
    type MaxRolesPerAccount = ConstU32<32>;
    // The cap on the per-block credential SCANS that scope the node's db-sync query, and on the read-side
    // observed-account joins. NOT a bound on the observation — see the pallet's `MaxScanned` docs. It kept
    // its 1024 value across the spec-215 rewrite because its reason is unchanged: `link_stake_signed` and
    // `claim_role_signed` are feeless bare-unsigned calls, so an unbounded scan of the maps they grow is a
    // free way to enlarge every node's per-block work until the db-sync query blows its timeout.
    //
    // ⚠ It IS still a real ceiling on two of the three axes, just not the one it used to be. A stake
    // credential or role claim past the cap is not scanned, so it is not observed and gets no weight — a
    // per-identity omission that the node WARNs about, not the chain-wide freeze the old overrun caused.
    // The vault axis is discovered by policy id and has no cap at all.
    type MaxScanned = ConstU32<1024>;
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
    // The observation is authored every block, so 5 minutes of silence is not a hiccup — it is the sole
    // weight writer stopped. Long enough to ride out a db-sync blip without crying wolf; short enough that
    // a real stop (the node's Cardano read down or behind) is on-chain and alertable within minutes rather
    // than never. A draining backlog is NOT a stall — each of those blocks applies a page and stamps the
    // clock; `PendingChanges` is the signal for that instead. The alarm only
    // ARMS once the chain has applied its first observation, so `--dev` (which has no db-sync and never
    // observes at all) does not trip it every run — see the pallet's `on_initialize`.
    type StallAfter = ConstU32<{ 5 * MINUTES }>;
    type BeaconResolver = BeaconLookup;
    type StakeResolver = StakeLookup;
    type WeightSink = WeightApply;
    type VotingPowerSink = VotingPowerApply;
    // The role axis (spec 206): resolve observed role credentials to accounts + write the observed-role
    // ledger the profile badge reads. Same enforce/freeze/clamp discipline as the weight/voting axes.
    type RoleResolver = RoleLookup;
    type RoleSink = RoleApply;
    // The 3-of-5 FollowerCommittee (sudo-free) gates the emergency weight-FREEZE flip — the same crown-jewel
    // origin as identity revoke / validator add-remove / authorize_upgrade. `EnforceWeight` defaults to
    // `true` (the observer is the sole writer from genesis); `set_enforcement(false)` freezes weight (verify
    // but don't write) as an emergency revert (D4-SHAPED on a single operator; see
    // docs/IN-PROTOCOL-OBSERVATION.md).
    type EnforceOrigin = AuthorityOrigin;
    // pallet-timestamp implements `UnixTime` — the block's consensus clock for the stability sanity bound.
    type UnixTime = Timestamp;
    // Real FRAME benchmarks. `observe` is Mandatory and runs in EVERY block, so it is the one call whose
    // weight can never be skipped or repriced by the fee market — the hand-estimate it replaces under-counted
    // it by ~100x and reported proof_size 0 for every term.
    type WeightInfo = pallet_cardano_observer::weights::SubstrateWeight<Runtime>;
    #[cfg(feature = "runtime-benchmarks")]
    type BenchmarkSetup = ObserverBenchSetup;
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
