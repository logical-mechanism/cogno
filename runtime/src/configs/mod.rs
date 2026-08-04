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
        constants::{RocksDbWeight, WEIGHT_REF_TIME_PER_MILLIS, WEIGHT_REF_TIME_PER_SECOND},
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

/// The share of a block's compute the Normal (ordinary user transaction) dispatch class may spend.
///
/// Kept as a plain percentage BESIDE the `Perbill` because `MAX_CLOSE_PAGE_CEILING` further down has to
/// redo this arithmetic in a `const` context, and `Perbill`'s multiplication is a trait impl, so it is
/// not const-callable. `block_limit_derivation_matches_frame` pins the pair against the real
/// `RuntimeBlockWeights`, so the two cannot drift apart silently.
const NORMAL_DISPATCH_PERCENT: u32 = 75;
const NORMAL_DISPATCH_RATIO: Perbill = Perbill::from_percent(NORMAL_DISPATCH_PERCENT);

/// The compute a block may spend: 2 seconds against a 6 second average block time. Named rather than
/// inlined so `MAX_CLOSE_PAGE_CEILING` tracks it — a change here moves every dispatch class's budget, and
/// with it the largest observed-account set `close_poll` can declare a weight for.
const MAXIMUM_BLOCK_REF_TIME: u64 = 2u64 * WEIGHT_REF_TIME_PER_SECOND;

/// The share of `max_block` that `BlockWeights::with_sensible_defaults` withholds for block
/// initialization when it derives each class's `max_extrinsic` — its
/// `avg_block_initialization(Perbill::from_percent(10))` call. FRAME does not export the figure, so it
/// is restated here for the const derivation below; `block_limit_derivation_matches_frame` reads the
/// real `max_extrinsic` back off `RuntimeBlockWeights` and fails if this ever stops matching.
///
/// ⚠ It is taken against `max_block` (the whole 2 s), NOT against the Normal class's own 75% share —
/// `BlockWeightsBuilder::build` computes `max_block` as the largest `max_total` across classes, which
/// is Operational's, which is the full `expected_block_weight`. That is why a single Normal extrinsic
/// gets 1.3 s rather than the 1.5 s the class allowance suggests.
const BLOCK_INIT_RESERVE_PERCENT: u32 = 10;

parameter_types! {
    pub const BlockHashCount: BlockNumber = 2400;
    pub const Version: RuntimeVersion = VERSION;

    /// We allow for 2 seconds of compute with a 6 second average block time.
    pub RuntimeBlockWeights: BlockWeights = BlockWeights::with_sensible_defaults(
        Weight::from_parts(MAXIMUM_BLOCK_REF_TIME, u64::MAX),
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
    // spec 216: backfill `RepliesByParentSeq`, microblog's ORDERED reply spine, from the hash-ordered
    // `RepliesByParent`. Purely additive (a still-declared source, a brand-new destination prefix), but
    // LOAD-BEARING on the live chain: `thread` and `replies_page` both walk the spine now, so without
    // this every existing thread would read back as having no replies at all. See `migrations::v11`.
    pallet_microblog::migrations::v11::MigrateV10ToV11<Runtime>,
    // spec 217: re-push every observer role basis row THROUGH the badge sink, so that the widened
    // `MAX_OBSERVED_ROLES_PER_ACCOUNT` reaches accounts that were already truncated. Widening a
    // `BoundedVec` bound is decode-compatible and needs no rewrite to be READ — but `derive_call` diffs
    // against this basis, which the sink cap never bounded, so a truncated row is otherwise never
    // re-emitted and the raise is inert on exactly the accounts it exists for. Re-derives IN PLACE
    // rather than clearing and waiting for an observation: a cleared badge set is zero chamber weight,
    // and a `close_poll` in that window freezes the zero permanently. A no-op on the live chain, where
    // `v1` (above) empties the same basis in the same block. See `migrations::v2`.
    pallet_cardano_observer::migrations::v2::MigrateV1ToV2<Runtime>,
    // spec 220: ENROL every already-bound account in cogno-gate's new scan rotation, the dense slot
    // table the observer's credential scan now rotates a window over. Load-bearing on the live chain
    // rather than tidy: an account outside the rotation is covered by no window, and an account no
    // window covers reads as `ScanCoverage::Absent` — which `derive_call` clears ON SIGHT, because a
    // row no future window can reach would otherwise be held for ever. So the failure is not a freeze:
    // without this the whole live ledger's voting power and every role badge would be ZEROED on the
    // block after the upgrade and could never be re-credited. `post_upgrade` fails rather than warns if
    // a single account is left out. See `migrations::v2`.
    pallet_cogno_gate::migrations::v2::MigrateV1ToV2<Runtime>,
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
    // How many voters (or chamber scratch rows) one `close_poll` page handles — the WORK-PER-BLOCK bound
    // that replaced the population bound in spec 219. Checked at compile time against
    // `MAX_CLOSE_PAGE_CEILING`, which is what now stands where `MAX_SCANNED_CEILING` used to.
    type MaxClosePage = ConstU32<MAX_CLOSE_PAGE>;
    // The roles pallet's own per-account badge bound. It is the ratio between a `close_poll` walk item
    // and a drain item, and it is what `CLOSE_POLL_*_PER_PAGE_ITEM` sizes the page ceiling against, so
    // the assert below pins the three together rather than leaving a hand-copied literal in each.
    type MaxChamberBadges = ConstU32<MAX_ROLES_PER_ACCOUNT>;
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
    // `ObservedStakers::stakers`.
    //
    // ⚠ It used to be true that the role axis "cannot exceed the cap": before spec 215 `role_entries`
    // was itself a `BoundedVec<_, MaxObserved>`, so the observation could not carry more. It is a plain
    // `Vec` now and nothing bounds it, and the SCAN cap is applied PER `RoleKind` (`claimed_credentials`
    // takes `cap` of each of Spo/DRep/Committee) with `BoundStakeCreds` a fourth independent budget for
    // the SpoOwner free path — so the union ceiling is a few times `MaxScanned`, not `MaxScanned`. Above
    // it this `.take(cap)` is a real truncation of the chamber tally, which `close_poll` then freezes
    // into `PollResult`. Same accepted-deferred-work note as `MaxObservedAccounts` below: the chain has
    // single-digit role holders against a 1024 cap, and the fix is a paged tally.
    fn role_holders() -> alloc::vec::Vec<AccountId> {
        let cap = <<Runtime as pallet_cardano_observer::Config>::MaxScanned as frame_support::traits::Get<
            u32,
        >>::get() as usize;
        pallet_cardano_roles::ObservedRoles::<Runtime>::iter_keys()
            .take(cap)
            .collect()
    }
    // The chamber-axis movement counter for the paged `close_poll` (spec 219). Bumped by BOTH writers of
    // `ObservedRoles` — the inherent's `apply_roles` and the committee-reachable `purge_account_roles` —
    // so a revoke mid-tally invalidates a chamber freeze exactly as an observation does.
    fn roles_seq() -> u64 {
        pallet_cardano_roles::ObservedRolesSeq::<Runtime>::get()
    }
    // Seed `badges` SPO badges so `close_poll`'s benchmark measures a voter at its worst case: one chamber
    // scratch WRITE per badge, which is the dominant term in a page item's cost. Writes `ObservedRoles`
    // directly — the observer is the only legal writer on a real chain, and this is compiled only under
    // `runtime-benchmarks`.
    //
    // ⚠ The pool ids must be unique PER VOTER, not just per badge. Seeding every voter the same ids makes
    // the second and later voters find each scratch row already present and agreeing, so they write
    // nothing — the measured curve comes back `Writes = 32 + (0 * p)` and the whole per-voter write cost
    // vanishes from the weight. Mixing the account into the id is what keeps the component honest.
    #[cfg(feature = "runtime-benchmarks")]
    fn benchmark_set_roles(who: &AccountId, badges: u32) {
        use codec::Encode;
        use pallet_cardano_roles::{ObservedRole, RoleKind};
        let account_bytes = who.encode();
        let mut set = pallet_cardano_roles::ObservedRoleSet::default();
        for i in 0..badges {
            let mut id = [0u8; 28];
            id[..4].copy_from_slice(&i.to_le_bytes());
            let take = core::cmp::min(account_bytes.len(), 24);
            id[4..4 + take].copy_from_slice(&account_bytes[..take]);
            if set
                .try_push(ObservedRole {
                    kind: RoleKind::Spo,
                    id,
                    weight: 1_000_000u128,
                })
                .is_err()
            {
                break; // hit MAX_OBSERVED_ROLES_PER_ACCOUNT — that IS the worst case
            }
        }
        pallet_cardano_roles::ObservedRoles::<Runtime>::insert(who, set);
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
    // Drops the observer's basis rows + the derived weight when a bind goes away. Mandatory since spec
    // 220 — the scan is a rotating window, so a torn-down account is in no future window and nothing
    // else would ever clear it. See `ObservedTeardown`.
    type OnTeardown = ObservedTeardown;
    // The Cardano network the on-chain self-proof binds for — derived from the ONE `CARDANO_NET`
    // cutover selector (spec 211), shared with cardano-roles so the two can never flip apart.
    type CardanoNetwork = CardanoNetworkId;
    // Shared with cardano-roles so the two committee batch verbs can never be sized apart. See
    // `MaxBatchTargets` for why 64 rather than the ~623 the weights would allow.
    type MaxBatchTargets = MaxBatchTargets;
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
    // The same bound cogno-gate's `revoke_many` uses — one knob for both committee cleanup verbs.
    type MaxBatchTargets = MaxBatchTargets;
    // The observer half of the role teardown (spec 221). The roles pallet clears its own badge set;
    // this drops the observer's diff basis, without which the badge set never comes back.
    type OnRoleTeardown = RoleBasisTeardown;
    type WeightInfo = ();
}

/// The observer's half of `pallet_cardano_roles`'s explicit role teardown, the role-verb analogue of
/// [`ObservedTeardown`]. Lives here for the same reason that one does: the roles pallet owns
/// `ObservedRoles` but has no Cargo edge to the observer, so the runtime is the only place the two
/// ledgers can be moved together.
///
/// One line, and it is the load-bearing one. `derive_call`'s forward pass emits a role change only when
/// the recomputed set differs from `LastObservedRoles`; leave the basis behind and the next observation
/// agrees with itself, writes nothing, and the badge row it just cleared stays empty for ever.
pub struct RoleBasisTeardown;
impl pallet_cardano_roles::OnObservedRolesCleared<AccountId> for RoleBasisTeardown {
    fn forget_role_basis(who: &AccountId) {
        pallet_cardano_observer::LastObservedRoles::<Runtime>::remove(who);
    }
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

/// The observer's `MaxRolesPerAccount` — how many role entries the observer will carry for one account,
/// and therefore the largest set it can ever hand the `RoleSink`. Named rather than inlined so the
/// relationship below can be checked at compile time.
const MAX_ROLES_PER_ACCOUNT: u32 = 32;

/// The two role caps are stacked, and the ORDER they cut in is load-bearing. The sink's
/// `MAX_OBSERVED_ROLES_PER_ACCOUNT` must never exceed the observer's `MaxRolesPerAccount`: past it the
/// sink's bound is unreachable, every cut moves upstream into `bounded_roles`, and nothing here would
/// say so — the pair has only ever been documented in prose, never checked. Both layers reserve the
/// non-SPO badges, so EQUAL is fine; greater is not.
/// `close_poll`'s badge ratio must be the roles pallet's REAL per-account bound, and this is the half
/// that pins it from ABOVE — the opposite direction to the assert below, so only equality satisfies
/// both. That is deliberate rather than accidental, because the two cut in opposite directions:
///
/// - `MaxChamberBadges` too SMALL under-declares the WALK phase: a voter can then hold more badges than
///   a page item was priced for, and each one is a chamber-scratch read and write.
/// - `MaxChamberBadges` too LARGE under-declares the DRAIN phase, which is the one this assert exists
///   for. `close_poll` scales its drain budget by `MaxChamberBadges` (`pallet_microblog`'s `ratio`) on
///   the argument that a walk item costs that many scratch writes — while the benchmark seeds
///   `benchmark_set_roles(voter, MaxChamberBadges)`, which the roles pallet then truncates to
///   `MAX_OBSERVED_ROLES_PER_ACCOUNT`. Set the two apart and the drain is allowed `ratio` times as many
///   items as the measured page can pay for.
///
/// ⚠ THIS ASSERT USED TO BE A BYTE-IDENTICAL DUPLICATE of the one below — same operands, same
/// direction — so it constrained nothing, and its prose named the unsafe direction as the safe one.
/// Both bounds are 32 today, so nothing was ever wrong; the guard simply was not guarding.
const _: () = assert!(
    MAX_ROLES_PER_ACCOUNT <= pallet_cardano_roles::MAX_OBSERVED_ROLES_PER_ACCOUNT,
    "MaxChamberBadges (= MAX_ROLES_PER_ACCOUNT) must not exceed MAX_OBSERVED_ROLES_PER_ACCOUNT, or \
     close_poll's drain phase is allowed more items than its declared page can pay for",
);

const _: () = assert!(
    pallet_cardano_roles::MAX_OBSERVED_ROLES_PER_ACCOUNT <= MAX_ROLES_PER_ACCOUNT,
    "MAX_OBSERVED_ROLES_PER_ACCOUNT must not exceed the observer's MaxRolesPerAccount",
);

/// The observer's `MaxScanned` — the cap on the per-block credential SCANS that scope the node's db-sync
/// query, and (through the `MaxObservedAccounts` alias) on the read-side observed-account joins. The
/// value's own rationale is at the `type MaxScanned` line in the observer's `Config` impl.
///
/// ⚠ Spec 219 removed the compile-time ceiling that used to sit on this. `close_poll` no longer declares
/// anything per observed account, so raising it can no longer make a poll impossible to finalize. It is
/// still named rather than inlined, because the read-path adapters below spend it.
const MAX_SCANNED: u32 = 1024;

/// How many voters (or chamber scratch rows) one `close_poll` page processes — the pallet's
/// `MaxClosePage`, named here so `MAX_CLOSE_PAGE_CEILING` below can check it at compile time.
///
/// 64 against a ceiling in the low hundreds. The same relationship `MaxScanned = 1024` has to its own
/// ceiling: room to raise it on measurement without a second look at the arithmetic. Bigger is not
/// better — a poll with fewer voters than this closes in ONE call, byte-identically to the pre-219
/// atomic close, so a larger page only reduces the number of calls on polls that exceed it, at the cost
/// of a larger reservation every call must declare.
const MAX_CLOSE_PAGE: u32 = 64;

/// DB reads `close_poll` DECLARES per page item: the `PollVotes` prefix iteration, that voter's record,
/// their `VotingPower`, and their `ObservedRoles` set, plus one read of the chamber scratch row for each
/// role badge they hold. Mirrors the `p` addend in `pallet_microblog::weights`.
const CLOSE_POLL_READS_PER_PAGE_ITEM: u64 = 4 + MAX_ROLES_PER_ACCOUNT as u64;

/// DB WRITES `close_poll` declares per page item: one chamber scratch row per role badge the voter holds.
///
/// ⚠ This is the term that decides the ceiling, and it is the one the pre-219 arithmetic had no analogue
/// for. A write is 100 µs against a read's 25 µs, so at the current `MaxRolesPerAccount` the writes are
/// roughly four fifths of a page item's cost. Anyone re-deriving the ceiling from the old reads-only shape
/// will get a number about 5x too large.
const CLOSE_POLL_WRITES_PER_PAGE_ITEM: u64 = MAX_ROLES_PER_ACCOUNT as u64;

/// The pure EXECUTION time `close_poll` spends per page item, on top of the DB weights above — decoding a
/// voter's role set, the per-badge scratch merge, the running fold. Reserved at 200 µs against a measured
/// ~153 µs (`weights.rs`, the `p` component), because a const cannot read the benchmark.
///
/// It is a small term next to the 3.2 ms of writes, but leaving it out entirely made the ceiling
/// arithmetic optimistic — the compile-time gate would have passed a page the real weight function does
/// not fit. `max_close_page_ceiling_is_not_optimistic` re-derives the bound from the REAL measured weight
/// and fails if this reserve ever stops covering it.
const CLOSE_POLL_EXEC_PS_PER_PAGE_ITEM: u64 = 200 * WEIGHT_REF_TIME_PER_MILLIS / 1000;

/// The ref_time FRAME will let a single Normal extrinsic DECLARE, before the fixed per-extrinsic costs:
/// the class allowance minus the block-initialization reserve. FRAME subtracts `ExtrinsicBaseWeight` on
/// top of this; that, the benchmarked `WeightInfo::close_poll(0)` and the `TxExtension` weight that
/// `DispatchInfo::total_weight()` folds in are all covered by `CLOSE_POLL_FIXED_REF_TIME_RESERVE`,
/// because none of the three is reachable from a const context.
const NORMAL_EXTRINSIC_REF_TIME_ALLOWANCE: u64 = (MAXIMUM_BLOCK_REF_TIME / 100)
    * (NORMAL_DISPATCH_PERCENT as u64)
    - (MAXIMUM_BLOCK_REF_TIME / 100) * (BLOCK_INIT_RESERVE_PERCENT as u64);

/// Everything a `close_poll` transaction weighs APART from its per-page-item work: `ExtrinsicBaseWeight`
/// (~0.11 ms), the benchmarked `WeightInfo::close_poll(0)` (~0.69 ms) and the `TxExtension` weight
/// (~0.65 ms, of which `CheckCapacity` is about a quarter) — roughly 1.45 ms all told. None of the three
/// is const-reachable, so a flat 4 ms is withheld here, a comfortable multiple of the real figure.
/// `max_close_page_ceiling_is_not_optimistic` re-derives the bound from the REAL weights and fails if the
/// reserve ever stops covering them, so this is a conservative shortcut rather than an unchecked guess.
const CLOSE_POLL_FIXED_REF_TIME_RESERVE: u64 = 4 * WEIGHT_REF_TIME_PER_MILLIS;

/// The largest `MaxClosePage` at which `close_poll` still declares a weight that FRAME will accept.
///
/// ⚠ THIS IS A BRICK THRESHOLD, and it is the SUCCESSOR to `MAX_SCANNED_CEILING`. Spec 219 paged the
/// tally, so `close_poll` no longer declares `6 x MaxObservedAccounts` reads and the population no longer
/// bounds whether a poll can be finalized. What still has to fit in one block is a single PAGE. Past this
/// ceiling `CheckWeight::check_extrinsic_weight` rejects the transaction at POOL VALIDATION with
/// `ExhaustsResources`, before any dispatch runs, so the post-dispatch refund the call is built around
/// never gets the chance to help — and `close_poll` is feeless, permissionless and the only way a poll is
/// ever finalized, with nothing on a sudo-free chain able to force it through.
///
/// The derivation, all of it from named constants above so it tracks a change to any of them:
///
/// ```text
///   block                    2 s                             = 2_000_000_000_000 ps
///   Normal class allowance   75% of the block                = 1_500_000_000_000 ps
///   less block-init reserve  10% of the block                = 1_300_000_000_000 ps
///   less fixed costs         ~3.63 ms, reserved at 4 ms      = 1_296_000_000_000 ps
///   per page item            36 reads x 25 us                =       900_000_000 ps
///                          + 32 writes x 100 us              =     3_200_000_000 ps
///                          + execution, reserved at 200 us   =       200_000_000 ps
///   ceiling                                                  =             301 items
/// ```
///
/// Note how much lower this is than the 8_640 the pre-219 ceiling carried. That is not a regression: the
/// old number bounded a POPULATION that had to fit in one block, this one bounds a PAGE, and the chain is
/// now correct for any population. The number is smaller because a page item WRITES (a chamber scratch row
/// per role badge) where an observed account only ever read — the writes alone are three quarters of it.
///
/// The live `MAX_CLOSE_PAGE` of 64 declares ~274 ms, about a fifth of what one Normal extrinsic may.
///
/// ⚠ The 4 ms fixed reserve is no longer comfortable: `close_poll(0)` measures ~2.87 ms, and with
/// `ExtrinsicBaseWeight` (~0.11 ms) and the `TxExtension` (~0.65 ms) the real fixed cost is ~3.63 ms of
/// the 4 ms withheld. `max_close_page_ceiling_is_not_optimistic` re-derives the bound from the measured
/// weight and is what actually guards this, but raise the reserve rather than shave it.
const MAX_CLOSE_PAGE_CEILING: u32 = ((NORMAL_EXTRINSIC_REF_TIME_ALLOWANCE
    - CLOSE_POLL_FIXED_REF_TIME_RESERVE)
    / (CLOSE_POLL_READS_PER_PAGE_ITEM * RocksDbWeight::get().read
        + CLOSE_POLL_WRITES_PER_PAGE_ITEM * RocksDbWeight::get().write
        + CLOSE_POLL_EXEC_PS_PER_PAGE_ITEM)) as u32;

const _: () = assert!(
    MAX_CLOSE_PAGE <= MAX_CLOSE_PAGE_CEILING,
    "MaxClosePage exceeds close_poll's block-fit ceiling: one page declares its per-item reads AND \
     WRITES up front, so past this the feeless close_poll is rejected by CheckWeight at validation and \
     every poll on a sudo-free chain becomes impossible to finalize. Lower the page, or re-derive the \
     ceiling if the per-item cost changed.",
);

/// The observer's `MaxScanned`, the one cap the three credential scans and the read-side observed-account
/// joins all spend. Named once so the adapters below cannot drift from the pallet's own bound.
fn max_scanned() -> u32 {
    <<Runtime as pallet_cardano_observer::Config>::MaxScanned as sp_core::Get<u32>>::get()
}

/// The compile-time `MAX_CLOSE_PAGE_CEILING` above restates three things FRAME owns — the block budget's
/// split, the block-initialization reserve and the per-read DB weight — because none of them is
/// const-reachable. These tests read the REAL values back and fail if any restatement drifts, so the
/// cheap compile-time gate cannot quietly become a lie.
#[cfg(test)]
mod batch_revoke_ceiling_tests {
    use super::*;
    use pallet_cardano_roles::weights::WeightInfo as _;
    use pallet_cogno_gate::weights::WeightInfo as _;

    /// The bound a committee call is really measured against.
    ///
    /// NOT the Normal class `max_extrinsic` that `close_poll_ceiling_tests` uses: `pallet-collective`
    /// checks `proposal.get_dispatch_info().call_weight.all_lte(MaxProposalWeight)` when the motion is
    /// PROPOSED, and `MaxProposalWeight` is 50% of `max_block` — lower than `max_extrinsic`. A batch
    /// sized against the block limit would therefore fit a block and still be unproposable, which is a
    /// dead call rather than a failed one. That module's SHAPE is reusable here; its input is not.
    fn max_proposal_ref_time() -> u64 {
        MaxProposalWeight::get().ref_time()
    }

    /// A full `MaxBatchTargets` identity revoke must fit one motion — declared weight, not actual, since
    /// the propose-time check sees only the declaration and the refund happens far later.
    #[test]
    fn revoke_many_batch_fits_a_committee_motion() {
        let n = MaxBatchTargets::get();
        let declared = <Runtime as pallet_cogno_gate::Config>::WeightInfo::revoke_many(n)
            .saturating_add(
                <Runtime as frame_system::Config>::DbWeight::get()
                    .reads_writes(4 * u64::from(n), 10 * u64::from(n)),
            )
            .ref_time();
        assert!(
            declared <= max_proposal_ref_time(),
            "a full {n}-target revoke_many declares {declared} ref_time against a MaxProposalWeight of \
             {}: the call could never be proposed. Lower MaxBatchTargets (and move \
             pallet_cogno_gate::benchmarking::MAX_BATCH_TARGETS with it).",
            max_proposal_ref_time(),
        );
    }

    /// The same for the role axis.
    #[test]
    fn revoke_role_many_batch_fits_a_committee_motion() {
        let n = MaxBatchTargets::get();
        let declared =
            <Runtime as pallet_cardano_roles::Config>::WeightInfo::revoke_role_many(n).ref_time();
        assert!(
            declared <= max_proposal_ref_time(),
            "a full {n}-target revoke_role_many declares {declared} ref_time against a \
             MaxProposalWeight of {}: the call could never be proposed.",
            max_proposal_ref_time(),
        );
    }

    /// The batch verbs must be priced at no less than N times the single verb they repeat. A batch that
    /// declared a flat cost would be a free amplifier for the one origin that is trusted not to need
    /// one — and the refund path would then be handing back weight that was never charged.
    #[test]
    fn a_batch_costs_at_least_what_the_single_verb_costs_per_target() {
        let n = MaxBatchTargets::get();
        let single_identity = <Runtime as pallet_cogno_gate::Config>::WeightInfo::revoke()
            .saturating_add(<Runtime as frame_system::Config>::DbWeight::get().reads_writes(4, 10));
        let batch_identity = <Runtime as pallet_cogno_gate::Config>::WeightInfo::revoke_many(n)
            .saturating_add(
                <Runtime as frame_system::Config>::DbWeight::get()
                    .reads_writes(4 * u64::from(n), 10 * u64::from(n)),
            );
        assert!(
            batch_identity.ref_time() >= single_identity.ref_time() * u64::from(n),
            "revoke_many({n}) declares {} but {n} × revoke() is {}",
            batch_identity.ref_time(),
            single_identity.ref_time() * u64::from(n),
        );

        let single_role = <Runtime as pallet_cardano_roles::Config>::WeightInfo::revoke_role();
        let batch_role = <Runtime as pallet_cardano_roles::Config>::WeightInfo::revoke_role_many(n);
        assert!(
            batch_role.ref_time() >= single_role.ref_time() * u64::from(n),
            "revoke_role_many({n}) declares {} but {n} × revoke_role() is {}",
            batch_role.ref_time(),
            single_role.ref_time() * u64::from(n),
        );
    }

    /// The runtime's bound and the benchmark's `Linear` upper bound are two separate literals that a
    /// const generic cannot tie together. The benchmark body asserts it too, but only under
    /// `--features runtime-benchmarks`; this runs on every `cargo test`.
    #[test]
    fn the_two_pallets_and_the_benchmark_agree_on_the_batch_bound() {
        assert_eq!(
            <Runtime as pallet_cogno_gate::Config>::MaxBatchTargets::get(),
            <Runtime as pallet_cardano_roles::Config>::MaxBatchTargets::get(),
            "the two committee cleanup verbs must be sized together",
        );
        assert_eq!(MaxBatchTargets::get(), 64);
    }
}

#[cfg(test)]
mod close_poll_ceiling_tests {
    use super::*;
    use crate::TxExtension;
    use frame_support::dispatch::{DispatchClass, GetDispatchInfo};
    use pallet_microblog::weights::WeightInfo as _;

    /// The `ref_time` a `close_poll` transaction DECLARES for a page of `items` — the whole of its
    /// `#[pallet::weight]`, which since spec 219 is `WeightInfo::close_poll(MaxClosePage)` and nothing
    /// else. This is `DispatchInfo::call_weight`; `total_weight()` adds the extension weight, which
    /// `close_poll_declared_weight_fits_a_block` accounts for separately.
    fn declared_call_ref_time(items: u32) -> u64 {
        <Runtime as pallet_microblog::Config>::WeightInfo::close_poll(items).ref_time()
    }

    /// What `CheckWeight::check_extrinsic_weight` compares `DispatchInfo::total_weight()` against. This
    /// is the TIGHTEST of the three weight checks a transaction faces and the one that matters here: it
    /// runs during POOL VALIDATION, on an empty block, so unlike the per-class accrual check it cannot
    /// be waited out — an over-budget `close_poll` is unincludable for ever, not merely this block.
    fn max_normal_extrinsic_ref_time() -> u64 {
        RuntimeBlockWeights::get()
            .get(DispatchClass::Normal)
            .max_extrinsic
            .expect("with_sensible_defaults derives max_extrinsic for the Normal class")
            .ref_time()
    }

    /// The three FRAME-owned figures the const derivation restates, checked against FRAME.
    #[test]
    fn block_limit_derivation_matches_frame() {
        let limits = RuntimeBlockWeights::get();
        let normal = limits.get(DispatchClass::Normal);

        // `max_block` is the largest `max_total` across classes — Operational's, i.e. the whole
        // `expected_block_weight`. The block-init reserve is taken against THIS, not against the
        // Normal allowance, which is the step that makes the real ceiling ~13% lower than it looks.
        assert_eq!(limits.max_block.ref_time(), MAXIMUM_BLOCK_REF_TIME);
        assert_eq!(
            normal
                .max_total
                .expect("Normal is a limited class")
                .ref_time(),
            (MAXIMUM_BLOCK_REF_TIME / 100) * (NORMAL_DISPATCH_PERCENT as u64),
        );
        // `NORMAL_EXTRINSIC_REF_TIME_ALLOWANCE` is FRAME's `max_extrinsic` before it subtracts
        // `ExtrinsicBaseWeight`; that subtraction is one of the costs the fixed reserve covers.
        assert_eq!(
            max_normal_extrinsic_ref_time() + normal.base_extrinsic.ref_time(),
            NORMAL_EXTRINSIC_REF_TIME_ALLOWANCE,
            "BLOCK_INIT_RESERVE_PERCENT no longer matches with_sensible_defaults",
        );
        // Both per-item costs the ceiling divides by are the ones `close_poll` will actually be charged.
        // The WRITE half is new in spec 219 and is the dominant term — see `CLOSE_POLL_WRITES_PER_PAGE_ITEM`.
        assert_eq!(
            <Runtime as frame_system::Config>::DbWeight::get().read,
            RocksDbWeight::get().read,
        );
        assert_eq!(
            <Runtime as frame_system::Config>::DbWeight::get().write,
            RocksDbWeight::get().write,
        );
    }

    /// The compile-time ceiling must be no HIGHER than the exact bound the real weights give, or the
    /// `const _: () = assert!(..)` would wave through a `MaxClosePage` that bricks `close_poll`.
    #[test]
    fn max_close_page_ceiling_is_not_optimistic() {
        let budget = max_normal_extrinsic_ref_time();

        // Derive the true bound from the REAL measured weight function rather than by restating the
        // const's own arithmetic — otherwise the test only proves the const equals itself. The benchmark
        // carries a per-item EXECUTION term as well as the DB weights, and an earlier version of this
        // test missed exactly that.
        let exact = (0u32..)
            .take_while(|p| declared_call_ref_time(*p) <= budget)
            .last()
            .expect("a zero-item page must fit");

        assert!(
            MAX_CLOSE_PAGE_CEILING <= exact,
            "MAX_CLOSE_PAGE_CEILING is {MAX_CLOSE_PAGE_CEILING}, but close_poll's declared weight only \
             fits a block up to a {exact}-item page — the compile-time assert would pass a value that \
             bricks the call. Re-derive the const (raise CLOSE_POLL_FIXED_REF_TIME_RESERVE or \
             CLOSE_POLL_EXEC_PS_PER_PAGE_ITEM, or fix whichever input moved).",
        );
        // ...and the cliff it is guarding is real, not an artefact of the arithmetic: the declaration
        // fits at `exact` and does not one item later.
        assert!(declared_call_ref_time(exact) <= budget);
        assert!(declared_call_ref_time(exact + 1) > budget);

        // The const's per-item model must not UNDER-state what the benchmark measures, or the ceiling
        // drifts optimistic the next time someone re-derives it by hand instead of running this.
        let db = <Runtime as frame_system::Config>::DbWeight::get();
        let modelled = CLOSE_POLL_READS_PER_PAGE_ITEM * db.read
            + CLOSE_POLL_WRITES_PER_PAGE_ITEM * db.write
            + CLOSE_POLL_EXEC_PS_PER_PAGE_ITEM;
        let measured = declared_call_ref_time(2) - declared_call_ref_time(1);
        assert!(
            modelled >= measured,
            "the ceiling models {modelled} ps per page item but the benchmark measures {measured} ps: \
             the compile-time gate is optimistic by the difference",
        );
    }

    /// `proof_size` cannot reject `close_poll` today because the runtime declares an unbounded PoV
    /// dimension. If that ever changes — a parachain collator, a PoV-limited profile — the page has to be
    /// re-derived against it too, because a page item records ~82 KB of proof.
    #[test]
    fn the_proof_size_dimension_is_unbounded() {
        assert_eq!(
            RuntimeBlockWeights::get().max_block.proof_size(),
            u64::MAX,
            "proof_size is now bounded: MAX_CLOSE_PAGE_CEILING only checks ref_time, and a page item \
             records ~82 KB of proof, so the page must be re-derived against the PoV budget as well",
        );
    }

    /// The population no longer appears in the declaration AT ALL. This is the whole point of spec 219,
    /// and it is the one assertion that would catch a regression back to a population-shaped bound.
    #[test]
    fn close_poll_no_longer_declares_anything_per_observed_account() {
        let budget = max_normal_extrinsic_ref_time();
        let at_live = declared_call_ref_time(MAX_CLOSE_PAGE);

        // The pre-219 shape, restated: `close_poll() + 6 reads x MaxObservedAccounts`. Evaluate it at a
        // population the chain must be able to serve and show it does NOT fit — that is the ceiling this
        // change removed, and the assertion fails the day someone reintroduces a population term.
        const A_POPULATION_WE_MUST_SERVE: u64 = 10_000;
        let old_shape = declared_call_ref_time(0).saturating_add(
            <Runtime as frame_system::Config>::DbWeight::get()
                .reads(A_POPULATION_WE_MUST_SERVE * 6)
                .ref_time(),
        );
        assert!(
            old_shape > budget,
            "the old population-shaped declaration is supposed to be the thing that did not fit; at \
             {A_POPULATION_WE_MUST_SERVE} accounts it declares {old_shape} against a {budget} budget",
        );

        // The new declaration fits with room to spare AT ANY POPULATION, because the population is not in
        // it. `close_poll_declared_weight_fits_a_block` pins the exact shape; this pins the consequence.
        assert!(
            at_live < budget / 2,
            "a page should cost well under half a block; it declares {at_live}",
        );
        assert!(
            declared_call_ref_time(MAX_CLOSE_PAGE + 1) > at_live,
            "the declaration must still scale with the page, or the refund is unbounded",
        );
    }

    /// The live `MaxClosePage` fits, with the whole transaction priced the way FRAME prices it —
    /// `total_weight()` = the declared call weight PLUS the `TxExtension` weight.
    #[test]
    fn close_poll_declared_weight_fits_a_block() {
        let budget = max_normal_extrinsic_ref_time();
        let info = RuntimeCall::Microblog(pallet_microblog::Call::close_poll { host_id: 0 })
            .get_dispatch_info();

        // The weight really is declared off `MaxClosePage` and nothing else. This is the only thing tying
        // the ceiling's arithmetic to `close_poll`'s actual `#[pallet::weight]`: change the declaration
        // there and `MAX_CLOSE_PAGE_CEILING` silently becomes optimistic, with nothing else to notice.
        // Fail here, loudly, rather than there.
        assert_eq!(
            info.call_weight.ref_time(),
            declared_call_ref_time(MAX_CLOSE_PAGE),
            "close_poll's declared weight is not `close_poll(MaxClosePage)` any more. Update \
             CLOSE_POLL_READS_PER_PAGE_ITEM / CLOSE_POLL_WRITES_PER_PAGE_ITEM (and re-check \
             MAX_CLOSE_PAGE_CEILING, which divides by them) to match the #[pallet::weight] in \
             pallet-microblog.",
        );
        assert_eq!(
            <<Runtime as pallet_microblog::Config>::MaxClosePage as sp_core::Get<u32>>::get(),
            MAX_CLOSE_PAGE,
        );
        // A Normal-class call: the budget above is the right one to hold it to.
        assert_eq!(info.class, DispatchClass::Normal);

        // `GetDispatchInfo` leaves `extension_weight` zero — `CheckedExtrinsic::apply` fills it from
        // `TransactionExtension::weight` before `CheckWeight` sees it — so price it here the same way,
        // over the runtime's real extension tuple in its real order (mirrors `cli::tx::tx_extension`).
        let extension =
            <TxExtension as sp_runtime::traits::TransactionExtension<RuntimeCall>>::weight(
                &(
                    frame_system::AuthorizeCall::<Runtime>::new(),
                    frame_system::CheckNonZeroSender::<Runtime>::new(),
                    frame_system::CheckSpecVersion::<Runtime>::new(),
                    frame_system::CheckTxVersion::<Runtime>::new(),
                    frame_system::CheckGenesis::<Runtime>::new(),
                    frame_system::CheckEra::<Runtime>::from(sp_runtime::generic::Era::Immortal),
                    frame_system::CheckNonce::<Runtime>::from(0),
                    frame_system::CheckWeight::<Runtime>::new(),
                    pallet_microblog::CheckCapacity::<Runtime>::new(),
                    pallet_skip_feeless_payment::SkipCheckIfFeeless::from(
                        pallet_transaction_payment::ChargeTransactionPayment::<Runtime>::from(0),
                    ),
                    frame_metadata_hash_extension::CheckMetadataHash::<Runtime>::new(false),
                    frame_system::WeightReclaim::<Runtime>::new(),
                ),
                &RuntimeCall::Microblog(pallet_microblog::Call::close_poll { host_id: 0 }),
            );
        let total = info.call_weight.ref_time() + extension.ref_time();
        assert!(
            total <= budget,
            "close_poll declares {total} ps at MaxClosePage={MAX_CLOSE_PAGE}, over the {budget} ps a \
             single Normal extrinsic may declare",
        );
        // The same transaction at the compile-time ceiling must still fit — that is what makes the
        // `const _: () = assert!(..)` a sufficient gate and not just a necessary one.
        assert!(
            declared_call_ref_time(MAX_CLOSE_PAGE_CEILING) + extension.ref_time() <= budget,
            "the compile-time ceiling does not leave room for the TxExtension weight",
        );
    }
}

/// The accounts the observer's credential scan covers this block: cogno-gate's scan rotation, read
/// from the observer's own cursor.
///
/// ONE window feeds all four db-sync credential arrays. That is the point of rotating over accounts
/// rather than over credentials: an account is wholly inside a window or wholly outside it, so the role
/// sink's whole-set overwrite never sees a half-observed account, and `derive_call` gets a single
/// unambiguous scope for both scoped axes. See `pallet_cardano_observer::ScanWindow`.
///
/// ⚠ Every caller must evaluate this against PARENT state. The node reads it through the runtime API at
/// the parent hash to build its query; `derive_call` reads it in-runtime on both sides of consensus.
/// The cursor is advanced only by `observe`, so all three see the same value.
fn scan_window_accounts() -> alloc::vec::Vec<AccountId> {
    pallet_cogno_gate::Pallet::<Runtime>::scan_window(
        pallet_cardano_observer::ScanCursor::<Runtime>::get(),
        max_scanned(),
    )
}

/// The rotating scan window, for the observer (`ScanWindow`) and — through it — for `derive_call`'s
/// scope test. This lives in the runtime rather than in either pallet because it is the only place that
/// can name both cogno-gate's rotation and the observer's cursor.
pub struct GateScanWindow;
impl pallet_cardano_observer::ScanWindow<AccountId> for GateScanWindow {
    fn window(cursor: u64, budget: u32) -> alloc::vec::Vec<AccountId> {
        pallet_cogno_gate::Pallet::<Runtime>::scan_window(cursor, budget)
    }
    fn coverage(
        cursor: u64,
        budget: u32,
        who: &AccountId,
    ) -> pallet_cardano_observer::ScanCoverage {
        use pallet_cardano_observer::ScanCoverage;
        // One read. `ScanSlotOf` answers "is this account still bound at all" and "where is it in the
        // rotation" at the same time, which is exactly the two-part question `derive_call` is asking.
        match pallet_cogno_gate::ScanSlotOf::<Runtime>::get(who) {
            None => ScanCoverage::Absent,
            Some(slot) => {
                if pallet_cogno_gate::Pallet::<Runtime>::slot_in_window(slot, cursor, budget) {
                    ScanCoverage::Covered
                } else {
                    ScanCoverage::Deferred
                }
            }
        }
    }
    fn advance(cursor: u64, budget: u32) -> u64 {
        pallet_cogno_gate::Pallet::<Runtime>::next_scan_cursor(cursor, budget)
    }
    fn sweep_blocks(budget: u32) -> u64 {
        pallet_cogno_gate::Pallet::<Runtime>::scan_sweep_blocks(budget)
    }
}

/// The set of bound stake credentials, for the node-side IDP (via the `CardanoObserverApi`): the stake
/// credential of every account in this block's scan window.
///
/// ⚠ THIS USED TO BE A HASH-ORDERED PREFIX, and replacing it is the last population ceiling coming out.
/// The old shape pinned everything already holding observed state (spec 217) and then spent whatever
/// budget was left on `AccountOfStakeCred::iter_keys()` — so a credential past the cap was never
/// scanned, never observed, and therefore silently held no voting power at all, with a `blake2_128`
/// walk deciding who. `blake2_128` is grindable offline and `link_stake_signed` is bare-unsigned and
/// feeless, so which accounts lost was targetable rather than random. The pin closed the eviction half
/// of that (an already-credited account could no longer LOSE weight it had) and deliberately left the
/// starvation half open, because fixing it needed `derive_call` to understand scope. It does now.
///
/// What replaces it is a WINDOW: bounded per-block work exactly as before, but every account is covered
/// within `ceil(rotation / MaxScanned)` blocks whatever the population is. There is nothing left to pin,
/// because nothing can be evicted — an out-of-window basis row is held, not cleared.
///
/// The db-sync bound that motivated the cap is unchanged and still binding: this feeds a single
/// `= ANY($3::bytea[])` array into a query under a 2 s timeout, on every node on every block, and
/// `MaxScanned` is what keeps that array bounded.
pub struct BoundStakeCreds;
impl pallet_cardano_observer::BoundStakeCredentials for BoundStakeCreds {
    fn bound_stake_credentials() -> alloc::vec::Vec<[u8; 28]> {
        pallet_cogno_gate::Pallet::<Runtime>::stake_credentials_of(&scan_window_accounts())
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
        // The reserve-aware two-pass bounding lives in pallet-cardano-roles, next to the cap it
        // defends and next to a `LOG_TARGET` that can announce a truncation. It used to be inlined
        // here, where it had neither.
        pallet_cardano_roles::Pallet::<Runtime>::apply_roles(
            who,
            pallet_cardano_roles::Pallet::<Runtime>::bound_observed_roles(roles),
        );
    }
}

/// Observed-state teardown adapter (spec 220): drop what the observer has written for an account whose
/// bind has gone away, at the moment it goes away.
///
/// ⚠ THIS IS NOT AN OPTIMISATION, and the reason is worth stating where it is wired. Until the scan
/// became a rotating window, teardown needed no hook at all: an unbound credential simply fell out of
/// the node's scan, `derive_call` found its basis row absent from the observation, and the next block
/// cleared it — cogno-gate's own comments said as much. That inference is exactly what the window
/// removes. Absence now means "not covered this block" for the majority of the ledger, so an
/// out-of-window row is HELD; and an account whose bind is gone is in no window ever again, so its row
/// and its voting power would be held for ever. `derive_call`'s not-enrolled probe is the backstop for
/// anything that slips past this, not a substitute for it — the probe cannot see a row whose account is
/// still enrolled, which is precisely the `unlink_stake` case.
///
/// It also closes a hazard recorded against spec 219 rather than fixed there: nothing ever removed a
/// `VotingPower` row, and both teardown sites deliberately left one standing on the grounds that the
/// observer would clear it next block. A paged `close_poll` tallies by VOTER and reads `VotingPower`
/// directly, so a stale row is a wrong vote weight — and it survives any observer freeze or stall.
///
/// The VAULT axis is deliberately not touched here. It is discovered by policy id rather than by
/// enumerating credentials, so it has no window and no scope: a revoked beacon stops resolving,
/// `derive_call` drops it from `desired`, and the next observation clears it exactly as before.
pub struct ObservedTeardown;
impl pallet_cogno_gate::OnBindTeardown<AccountId> for ObservedTeardown {
    fn forget_account(who: &AccountId) {
        pallet_cardano_observer::LastObservedRoles::<Runtime>::remove(who);
        <RoleApply as pallet_cardano_observer::RoleSink<AccountId>>::set_roles(who, &[]);
    }

    fn forget_stake(who: &AccountId, stake_cred: &[u8; 28]) {
        pallet_cardano_observer::LastObservedStake::<Runtime>::remove(stake_cred);
        <VotingPowerApply as pallet_cardano_observer::VotingPowerSink<AccountId>>::set_voting_power(
            who, 0,
        );
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

/// The spec-220 rotating scan window: the observer's per-block credential SCAN must bound WORK, never
/// POPULATION — so no account can be starved out of ever being observed, whatever the ledger's size and
/// whoever chose the credentials in it.
///
/// These replace the spec-217 `fair_scan_tests`, which tested the PIN: a pre-pass that guaranteed a slot
/// to everything already holding observer state, so that a feeless bind flood could not EVICT an
/// account that had already been credited. That fix was real and those tests passed, but it closed only
/// half the hole — a not-yet-credited credential past the cap was still never scanned at all, in a
/// `blake2_128` hash order an attacker can grind offline. A window closes the other half and subsumes
/// the first: nothing can be evicted from a rotation, because an out-of-window basis row is HELD rather
/// than cleared, so there is no longer anything for a pin to protect.
///
/// They drive the real `BoundStakeCreds` / `BoundRoleCreds` adapters and cogno-gate's real rotation
/// maintenance against real `Runtime` storage, not a mock: the window is a runtime-level join across
/// cogno-gate, cardano-roles and the OBSERVER's cursor, and no single pallet can see enough of it to
/// express the invariant.
#[cfg(test)]
mod scan_window_tests {
    use super::*;
    use alloc::collections::BTreeSet;
    use pallet_cardano_observer::{
        BoundRoleCredentials, BoundStakeCredentials, ScanCoverage, ScanWindow,
    };
    use pallet_cardano_roles::RoleKind;

    /// Distinct, deterministic `(credential, account)` pairs.
    fn pair(i: u32) -> ([u8; 28], AccountId) {
        let mut cred = [0u8; 28];
        cred[..4].copy_from_slice(&i.to_le_bytes());
        let mut acct = [0u8; 32];
        acct[..4].copy_from_slice(&i.to_le_bytes());
        acct[31] = 0xAA;
        (cred, AccountId::from(acct))
    }

    /// Bind account `i` the way `do_bind` + `do_bind_stake` do: identity, rotation slot, stake
    /// credential. Uses the pallet's REAL rotation maintenance rather than writing the three slot-table
    /// items by hand, so a test cannot end up agreeing with itself about a table it built wrongly.
    fn bind(i: u32) -> ([u8; 28], AccountId) {
        let (cred, who) = pair(i);
        let mut identity = [0u8; 32];
        identity[..4].copy_from_slice(&i.to_le_bytes());
        pallet_cogno_gate::PkhOf::<Runtime>::insert(&who, identity);
        pallet_cogno_gate::AccountOf::<Runtime>::insert(identity, &who);
        pallet_cogno_gate::Pallet::<Runtime>::join_rotation(&who);
        pallet_cogno_gate::StakeCredOf::<Runtime>::insert(&who, cred);
        pallet_cogno_gate::AccountOfStakeCred::<Runtime>::insert(cred, &who);
        (cred, who)
    }

    /// Bind `n` accounts and return their credentials in bind order.
    fn bind_many(n: u32) -> Vec<[u8; 28]> {
        (0..n).map(|i| bind(i).0).collect()
    }

    /// Run the rotation from cursor 0 until the union of its windows covers `target`, and report how
    /// many blocks that took.
    ///
    /// ⚠ IT DOES NOT STOP WHEN THE CURSOR RETURNS TO 0, and an earlier version of this helper that did
    /// ran for thousands of blocks. The cursor advances by a fixed stride in a ring whose size is not a
    /// multiple of it, so it lands back on 0 only after `count / gcd(count, budget)` steps — 3,079 of
    /// them at one of the sizes below, because 3,079 is prime. That drift is harmless and it is not
    /// what coverage means: consecutive windows ABUT (each starts exactly where the last ended), so the
    /// union of any `ceil(count / budget)` of them is the whole ring wherever it started.
    fn blocks_to_cover(target: &BTreeSet<[u8; 28]>) -> u64 {
        let budget = max_scanned();
        let mut cursor = 0u64;
        let mut covered: BTreeSet<[u8; 28]> = BTreeSet::new();
        for block in 1..=10_000u64 {
            pallet_cardano_observer::ScanCursor::<Runtime>::put(cursor);
            covered.extend(BoundStakeCreds::bound_stake_credentials());
            if covered.is_superset(target) {
                assert_eq!(
                    &covered, target,
                    "the scan returned a credential nobody bound"
                );
                return block;
            }
            cursor = GateScanWindow::advance(cursor, budget);
        }
        panic!("the rotation never covered every bound account");
    }

    /// THE test, and the whole point of the change. Every bound account is scanned within one sweep of
    /// the rotation, however far past `MaxScanned` the ledger has grown. Against the pre-220 scan this
    /// fails outright: that one returned a hash-ordered prefix, so the accounts outside it were never
    /// scanned in ANY block, not merely a later one.
    #[test]
    fn every_bound_account_is_scanned_within_one_sweep() {
        sp_io::TestExternalities::default().execute_with(|| {
            let cap = max_scanned();
            // Three and a bit windows' worth, so the sweep genuinely has to rotate and wrap.
            let all: BTreeSet<[u8; 28]> = bind_many(cap * 3 + 7).into_iter().collect();

            // Completes at all — against the pre-220 hash-ordered prefix this never does, because the
            // accounts outside it were skipped in every block rather than a later one.
            let blocks = blocks_to_cover(&all);

            // And it completes in a BOUNDED number of blocks, which is the other half of "bound the
            // work per block, never the population".
            assert_eq!(
                blocks,
                pallet_cogno_gate::Pallet::<Runtime>::scan_sweep_blocks(cap),
                "the sweep took a different number of blocks than the chain reports it does",
            );
            assert_eq!(blocks, (u64::from(cap) * 3 + 7).div_ceil(u64::from(cap)));
        });
    }

    /// Per-block work stays bounded — the constraint the cap exists for, unchanged. This feeds one
    /// `= ANY($3::bytea[])` array into a db-sync query under a 2 s timeout on every node every block.
    #[test]
    fn a_window_never_exceeds_max_scanned() {
        sp_io::TestExternalities::default().execute_with(|| {
            let cap = max_scanned();
            bind_many(cap * 3 + 7);
            for cursor in [0u64, 1, 7, u64::from(cap), u64::from(cap) * 2 + 3] {
                pallet_cardano_observer::ScanCursor::<Runtime>::put(cursor);
                assert!(
                    BoundStakeCreds::bound_stake_credentials().len() <= cap as usize,
                    "the scan exceeded MaxScanned at cursor {cursor}",
                );
            }
        });
    }

    /// The fairness property, and the one the old hash-ordered cursor could not have. A flood of
    /// feeless binds queues at the TAIL of the rotation, so it cannot move an account that was already
    /// there — not one slot, whatever credentials it grinds.
    ///
    /// This is what makes the window non-starvable. Resuming a `blake2_128` walk from a stored cursor
    /// would look equivalent and is not: the cursor is public, hash position is chosen offline, and an
    /// attacker who keeps minting credentials into the gap between the cursor and a victim keeps the
    /// cursor from ever reaching it. Arrival order is not something an attacker can grind.
    #[test]
    fn a_bind_flood_cannot_move_an_account_already_in_the_rotation() {
        sp_io::TestExternalities::default().execute_with(|| {
            let cap = max_scanned();
            let (victim_cred, victim) = bind(0);
            let before = pallet_cogno_gate::ScanSlotOf::<Runtime>::get(&victim);

            // Ten windows' worth of fresh binds, which is what ~1,000 accounts can do in a few blocks
            // for free through the bare-unsigned `link_stake_signed`.
            for i in 1..=(cap * 10) {
                bind(i);
            }

            assert_eq!(
                pallet_cogno_gate::ScanSlotOf::<Runtime>::get(&victim),
                before,
                "a bind flood moved an existing account's rotation slot",
            );
            // And it is still reached in the first window, because it was there first.
            pallet_cardano_observer::ScanCursor::<Runtime>::put(0);
            assert!(BoundStakeCreds::bound_stake_credentials().contains(&victim_cred));
        });
    }

    /// The `derive_call` contract, which is the other half of the change: an account the window has not
    /// reached yet reads as `Deferred`, so its basis row is HELD rather than cleared.
    ///
    /// Getting this wrong is not a slow answer but a wrong one. The node reads db-sync only for the
    /// window, so out-of-window accounts are absent from `stake_entries` — and the pre-220 rule read
    /// absence as "stake went to zero", which under a window would zero most of the ledger every block.
    #[test]
    fn an_account_outside_the_window_is_deferred_not_cleared() {
        sp_io::TestExternalities::default().execute_with(|| {
            let cap = max_scanned();
            bind_many(cap * 2);
            let (_, far) = pair(cap * 2 - 1);
            let (_, near) = pair(0);

            assert_eq!(
                GateScanWindow::coverage(0, cap, &near),
                ScanCoverage::Covered,
                "an account inside the window must be Covered — absence from the read is real there",
            );
            assert_eq!(
                GateScanWindow::coverage(0, cap, &far),
                ScanCoverage::Deferred,
                "an account the window has not reached must be Deferred, never Covered — Covered \
                 would zero its voting power on a read that never looked at it",
            );
        });
    }

    /// The escape hatch that stops a held row becoming a permanent one. An account whose bind is gone
    /// has left the rotation, so no future window can ever cover it — holding would be for ever, and
    /// `derive_call` clears on sight instead.
    ///
    /// The spec-217 test this replaces (`a_revoked_bind_is_not_pinned_back_into_scope`) asserted the
    /// mirror image of the same requirement against the old mechanism: an unbound credential had to
    /// stay OUT of the scan, precisely so that absence would clear its basis row.
    #[test]
    fn a_revoked_account_reads_as_absent_so_its_basis_row_is_cleared() {
        sp_io::TestExternalities::default().execute_with(|| {
            let cap = max_scanned();
            let (cred, who) = bind(0);
            bind_many(4);
            assert_eq!(GateScanWindow::coverage(0, cap, &who), ScanCoverage::Covered);

            // What `do_revoke` does to the rotation.
            pallet_cogno_gate::Pallet::<Runtime>::leave_rotation(&who);
            pallet_cogno_gate::AccountOfStakeCred::<Runtime>::remove(cred);

            assert_eq!(
                GateScanWindow::coverage(0, cap, &who),
                ScanCoverage::Absent,
                "a torn-down account must read as Absent — Deferred would hold its weight for ever, \
                 because no window will ever cover it again",
            );
            assert!(!BoundStakeCreds::bound_stake_credentials().contains(&cred));
        });
    }

    /// The slot table stays DENSE across teardowns, which is what stops the sweep length ratcheting
    /// with accounts-ever-bound instead of accounts-bound-now. A hole would be a permanent tax on
    /// coverage latency that no amount of pruning could undo.
    #[test]
    fn a_teardown_keeps_the_slot_table_dense() {
        sp_io::TestExternalities::default().execute_with(|| {
            let accounts: Vec<AccountId> = (0..8).map(|i| bind(i).1).collect();
            assert_eq!(pallet_cogno_gate::ScanSlotCount::<Runtime>::get(), 8);

            // Tear down from the middle, the end and the start — the three cases the swap-remove has.
            for who in [&accounts[3], &accounts[7], &accounts[0]] {
                pallet_cogno_gate::Pallet::<Runtime>::leave_rotation(who);
            }

            let count = pallet_cogno_gate::ScanSlotCount::<Runtime>::get();
            assert_eq!(count, 5);
            let mut seen = BTreeSet::new();
            for slot in 0..count {
                let who = pallet_cogno_gate::AccountAtScanSlot::<Runtime>::get(slot)
                    .expect("the slot table has a hole below its count");
                assert_eq!(
                    pallet_cogno_gate::ScanSlotOf::<Runtime>::get(&who),
                    Some(slot),
                    "the two rotation maps are not each other's inverse",
                );
                assert!(seen.insert(who), "two slots hold the same account");
            }
            // Nothing above the count is left readable, or a later `join_rotation` would collide.
            assert!(pallet_cogno_gate::AccountAtScanSlot::<Runtime>::get(count).is_none());
        });
    }

    /// The window wraps, and an account at the start of the table is reachable from a cursor near the
    /// end. A range test against an unwrapped `cursor + budget` upper bound passes every other
    /// assertion in this module and silently excludes exactly these accounts — the node would scan
    /// them while `derive_call` judged them out of scope, which reads as "held" for ever.
    #[test]
    fn the_window_wraps_around_the_end_of_the_rotation() {
        sp_io::TestExternalities::default().execute_with(|| {
            let count = 10u32;
            let creds = bind_many(count);
            let budget = 4u32;

            // From slot 8: slots 8, 9, 0, 1.
            let covered: BTreeSet<[u8; 28]> =
                pallet_cogno_gate::Pallet::<Runtime>::stake_credentials_of(
                    &pallet_cogno_gate::Pallet::<Runtime>::scan_window(8, budget),
                )
                .into_iter()
                .collect();
            let want: BTreeSet<[u8; 28]> = [creds[8], creds[9], creds[0], creds[1]].into();
            assert_eq!(covered, want, "the window did not wrap");

            let (_, wrapped_account) = pair(0);
            assert!(pallet_cogno_gate::Pallet::<Runtime>::slot_in_window(
                0, 8, budget
            ));
            assert!(!pallet_cogno_gate::Pallet::<Runtime>::slot_in_window(
                4, 8, budget
            ));
            assert_eq!(
                GateScanWindow::coverage(8, budget, &wrapped_account),
                ScanCoverage::Covered,
            );
            // And the cursor advance wraps with it.
            assert_eq!(GateScanWindow::advance(8, budget), 2);
        });
    }

    /// The account-granularity property, and the reason the rotation is over ACCOUNTS rather than over
    /// credentials. All four db-sync arrays come from ONE window, so an account is WHOLLY in scope or
    /// WHOLLY out of it.
    ///
    /// `RoleSink::set_roles` is a whole-set overwrite. An account seen with only some of its
    /// credentials in scope would be written back having lost the rest of its badges — and a badge
    /// carries governance-poll chamber weight that `close_poll` freezes permanently. Rotating over
    /// credentials would need a cross-window merge to avoid that; rotating over accounts makes the
    /// question not arise.
    #[test]
    fn one_window_scopes_every_credential_an_account_holds() {
        sp_io::TestExternalities::default().execute_with(|| {
            let budget = max_scanned();
            let (stake_cred, who) = bind(0);
            let calidus = [0x51u8; 28];
            let drep = [0xD2u8; 28];
            pallet_cardano_roles::RoleClaimOf::<Runtime>::insert(&who, RoleKind::Spo, calidus);
            pallet_cardano_roles::RoleCredIndex::<Runtime>::insert(RoleKind::Spo, calidus, &who);
            pallet_cardano_roles::RoleClaimOf::<Runtime>::insert(&who, RoleKind::DRep, drep);
            pallet_cardano_roles::RoleCredIndex::<Runtime>::insert(RoleKind::DRep, drep, &who);
            // Push it out of reach of a one-slot window.
            bind_many(4);

            // Cursor at its own slot: every axis carries it.
            pallet_cardano_observer::ScanCursor::<Runtime>::put(0);
            assert!(BoundStakeCreds::bound_stake_credentials().contains(&stake_cred));
            assert!(BoundRoleCreds::claimed_calidus().contains(&calidus));
            assert!(BoundRoleCreds::claimed_dreps().contains(&drep));

            // A window that excludes it excludes it on EVERY axis — no axis can see half an account.
            // The other accounts in that window still contribute their own credentials, which is why
            // this checks for `who`'s three specifically rather than for an empty array.
            let elsewhere = pallet_cogno_gate::Pallet::<Runtime>::scan_window(1, 1);
            assert!(!elsewhere.contains(&who));
            assert!(
                !pallet_cogno_gate::Pallet::<Runtime>::stake_credentials_of(&elsewhere)
                    .contains(&stake_cred)
                    && !pallet_cardano_roles::Pallet::<Runtime>::claimed_credentials_of(
                        RoleKind::Spo,
                        &elsewhere
                    )
                    .contains(&calidus)
                    && !pallet_cardano_roles::Pallet::<Runtime>::claimed_credentials_of(
                        RoleKind::DRep,
                        &elsewhere
                    )
                    .contains(&drep),
                "an account was partially in scope — the role sink's whole-set overwrite would drop \
                 the badges the window missed, and a close_poll in that block would freeze the loss",
            );
            assert_eq!(GateScanWindow::coverage(1, 1, &who), ScanCoverage::Deferred);
            let _ = budget;
        });
    }

    /// A duplicate in the window buys ONE credential, never two. The db-sync array is bounded by the
    /// window size, so a repeat must not be a way past it. (The spec-217 suite tested the same rule
    /// against the pin's two overlapping sources; the rule outlived the mechanism.)
    #[test]
    fn a_repeated_account_does_not_take_two_slots_in_the_array() {
        sp_io::TestExternalities::default().execute_with(|| {
            let (cred, who) = bind(0);
            assert_eq!(
                pallet_cogno_gate::Pallet::<Runtime>::stake_credentials_of(&[
                    who.clone(),
                    who.clone(),
                    who
                ]),
                vec![cred],
            );
        });
    }

    /// An empty rotation is not a special case anywhere: no window, no coverage, a cursor that does not
    /// move, and no division by zero in the sweep arithmetic. This is `--dev` and a fresh genesis.
    #[test]
    fn an_empty_rotation_is_inert() {
        sp_io::TestExternalities::default().execute_with(|| {
            let cap = max_scanned();
            assert!(pallet_cogno_gate::Pallet::<Runtime>::scan_window(0, cap).is_empty());
            assert_eq!(GateScanWindow::advance(0, cap), 0);
            assert_eq!(GateScanWindow::advance(99, cap), 0);
            assert_eq!(
                pallet_cogno_gate::Pallet::<Runtime>::scan_sweep_blocks(cap),
                0
            );
            let (_, nobody) = pair(0);
            assert_eq!(
                GateScanWindow::coverage(0, cap, &nobody),
                ScanCoverage::Absent
            );
        });
    }

    /// A ledger smaller than one window is covered in a single block and the cursor holds at 0, so the
    /// live chain's behaviour is byte-identical to what it was before the window existed. Worth pinning
    /// explicitly: it is the case the whole live network runs in, and a regression here would be
    /// invisible in the tests above (which all deliberately overflow the window).
    #[test]
    fn a_ledger_smaller_than_the_window_behaves_exactly_as_before() {
        sp_io::TestExternalities::default().execute_with(|| {
            let cap = max_scanned();
            let creds: BTreeSet<[u8; 28]> = bind_many(13).into_iter().collect();
            pallet_cardano_observer::ScanCursor::<Runtime>::put(0);

            let scanned: BTreeSet<[u8; 28]> = BoundStakeCreds::bound_stake_credentials()
                .into_iter()
                .collect();
            assert_eq!(scanned, creds, "the whole ledger fits in one window");
            assert_eq!(
                GateScanWindow::advance(0, cap),
                0,
                "the cursor must stay put when one window covers everything",
            );
            assert_eq!(
                pallet_cogno_gate::Pallet::<Runtime>::scan_sweep_blocks(cap),
                1
            );
            for i in 0..13 {
                assert_eq!(
                    GateScanWindow::coverage(0, cap, &pair(i).1),
                    ScanCoverage::Covered,
                );
            }
        });
    }
}

#[cfg(test)]
mod role_apply_tests {
    use super::*;
    use pallet_cardano_observer::RoleSink;
    use pallet_cardano_roles::{RoleKind, MAX_OBSERVED_ROLES_PER_ACCOUNT};

    /// The reserve, expressed against the CAP rather than a literal, so raising the cap does not
    /// silently turn these into tests of something else.
    const CAP: usize = MAX_OBSERVED_ROLES_PER_ACCOUNT as usize;
    const RESERVE: usize = 4;

    /// A distinct 28-byte credential per index (`[i; 28]` runs out at 256, and the cap does not).
    fn cred(i: usize) -> [u8; 28] {
        let mut c = [0u8; 28];
        c[..8].copy_from_slice(&(i as u64).to_le_bytes());
        c
    }

    #[test]
    fn truncation_keeps_non_spo_badges_and_drops_surplus_pools() {
        sp_io::TestExternalities::default().execute_with(|| {
            let who = AccountId::from([7u8; 32]);
            // The canonical order puts every SPO entry first: enough pools to fill the cap on their
            // own, then the operator's dRep and CC badges. A single-pass fill dropped both badges.
            let mut roles: alloc::vec::Vec<(u8, [u8; 28], u128)> =
                (0..CAP).map(|i| (0u8, cred(i), 1u128)).collect();
            roles.push((1, [0xD0; 28], 5));
            roles.push((2, [0xC0; 28], 0));
            RoleApply::set_roles(&who, &roles);
            let stored = pallet_cardano_roles::Pallet::<Runtime>::observed_roles(&who);
            assert_eq!(stored.len(), CAP, "filled to the cap");
            // The non-SPO badges survive (filled first), in slice order, ahead of the pools …
            assert_eq!(stored[0].kind, RoleKind::DRep);
            assert_eq!(stored[1].kind, RoleKind::Committee);
            // … and only the surplus SPO pools were dropped.
            assert_eq!(
                stored.iter().filter(|r| r.kind == RoleKind::Spo).count(),
                CAP - 2
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
            // Enough pools to fill the cap alone, plus twice the reserve in dRep entries. Nothing in
            // `RoleSink`'s signature forbids this; an uncapped first pass would keep all of them and
            // drop every pool.
            let mut roles: alloc::vec::Vec<(u8, [u8; 28], u128)> =
                (0..CAP).map(|i| (0u8, cred(i), 1u128)).collect();
            roles.extend((0..RESERVE * 2).map(|i| (1u8, cred(1_000 + i), 5u128)));
            RoleApply::set_roles(&who, &roles);
            let stored = pallet_cardano_roles::Pallet::<Runtime>::observed_roles(&who);
            assert_eq!(stored.len(), CAP, "filled to the cap");
            assert_eq!(
                stored.iter().filter(|r| r.kind == RoleKind::DRep).count(),
                RESERVE,
                "the non-SPO prefix is capped at the reserve"
            );
            assert_eq!(
                stored.iter().filter(|r| r.kind == RoleKind::Spo).count(),
                CAP - RESERVE,
                "every remaining slot still goes to the pools"
            );
        });
    }

    /// The spec-217 raise, stated as the case it exists for: a real mSPO. Live preprod already holds a
    /// credential owning 17 pools and mainnet mSPOs run 20-30, all of which were truncated at the old
    /// cap of 16 — and the truncation cost chamber WEIGHT and the participation COUNT, not just badges.
    /// Fails against the old cap.
    #[test]
    fn a_thirty_pool_mspo_keeps_every_pool_and_both_badges() {
        sp_io::TestExternalities::default().execute_with(|| {
            let who = AccountId::from([11u8; 32]);
            let mut roles: alloc::vec::Vec<(u8, [u8; 28], u128)> =
                (0..30).map(|i| (0u8, cred(i), 1u128)).collect();
            roles.push((1, [0xD0; 28], 5));
            roles.push((2, [0xC0; 28], 0));

            RoleApply::set_roles(&who, &roles);

            let stored = pallet_cardano_roles::Pallet::<Runtime>::observed_roles(&who);
            assert_eq!(
                stored.len(),
                32,
                "a 30-pool mSPO with a dRep and a CC badge must not be truncated",
            );
            assert_eq!(
                stored.iter().filter(|r| r.kind == RoleKind::Spo).count(),
                30,
                "every pool has to count: poll_chamber_weights sums their delegated stake and \
                 close_poll freezes the total permanently",
            );
        });
    }
}

/// The claimed role credentials, for the node-side IDP (via the `CardanoObserverApi`): the claim of
/// every account in this block's scan window that holds one for `role`.
///
/// Same rotation, same window, same block as the stake array — which is what makes an account wholly in
/// or wholly out of scope. That property is load-bearing HERE more than anywhere: `RoleSink::set_roles`
/// is a whole-set overwrite, so an account seen with only some of its credentials in scope would be
/// written back having lost the rest of its badges, and a badge carries governance-poll chamber weight
/// that `close_poll` can freeze permanently.
///
/// The spec-217 `pinned` pre-pass is gone with the prefix it protected: nothing can be evicted from a
/// window, so nothing needs pinning. The `SpoOwner` free path still rides `BoundStakeCreds` (its
/// credentials ARE stake credentials — the role SQL scopes its `owners` CTE by the stake array), and
/// since both arrays are now built from the same window, an mSPO's pool badges and its voting power
/// come into scope together instead of one axis being able to drop the other.
pub struct BoundRoleCreds;
impl pallet_cardano_observer::BoundRoleCredentials for BoundRoleCreds {
    fn claimed_calidus() -> alloc::vec::Vec<[u8; 28]> {
        pallet_cardano_roles::Pallet::<Runtime>::claimed_credentials_of(
            pallet_cardano_roles::RoleKind::Spo,
            &scan_window_accounts(),
        )
    }
    fn claimed_dreps() -> alloc::vec::Vec<[u8; 28]> {
        pallet_cardano_roles::Pallet::<Runtime>::claimed_credentials_of(
            pallet_cardano_roles::RoleKind::DRep,
            &scan_window_accounts(),
        )
    }
    fn claimed_committee() -> alloc::vec::Vec<[u8; 28]> {
        pallet_cardano_roles::Pallet::<Runtime>::claimed_credentials_of(
            pallet_cardano_roles::RoleKind::Committee,
            &scan_window_accounts(),
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
    /// The most targets one committee batch-revoke motion may carry, shared by `CognoGate::revoke_many`
    /// and `CardanoRoles::revoke_role_many` so the two cleanup verbs can never be sized apart.
    ///
    /// The binding ceiling is `pallet-collective`'s `MaxProposalWeight` (1 s of ref_time), NOT the
    /// block's Normal `max_extrinsic` — a proposal over that bound is rejected at PROPOSE, so an
    /// oversized batch is a call nobody can ever use rather than one that fails late. At the declared
    /// per-target weights that ceiling is in the hundreds, so 64 leaves roughly an order of magnitude
    /// of headroom — deliberately the same relationship `MaxClosePage = 64` has to
    /// `MAX_CLOSE_PAGE_CEILING = 301`. It is also ~5x the entire live chain's bound population, so the
    /// bound is not the thing that will limit a real cleanup.
    ///
    /// Sizing it larger costs more than it looks: `ProposalOf` stores the WHOLE encoded call with
    /// `MaxProposals = 100` and no proposal deposit, so the bound multiplies worst-case committee
    /// state for no benefit. `revoke_many_batch_fits_a_committee_motion` asserts the fit, and
    /// `pallet_cogno_gate::benchmarking::MAX_BATCH_TARGETS` must move with this.
    pub const MaxBatchTargets: u32 = 64;
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
    // up in ~40 minutes (391 blocks x 6 s), once. It is not on any critical path. On the live chain the
    // migration re-derives 20 rows, which is one block.
    //
    // ⚠ THE FITTED BASE IS NOISE AND SHOULD NOT BE READ AS A MEASUREMENT. `frame-benchmarking` varies one
    // `Linear` component at a time with the OTHERS HELD AT THEIR MAXIMUM, so with three components there
    // is no sample anywhere near the origin and the intercept is pure extrapolation. Three consecutive
    // runs of identical code on a quiet machine put it at 415 µs, 36 µs and 13 µs — a 30x spread on a term
    // that contributes 0.4 ms to a 230 ms worst case, i.e. nothing. The SLOPES are what this benchmark
    // measures, and those are stable to a few percent across the same runs (~21 / ~14 / ~12 µs per vault /
    // stake / role change). An earlier comment here read the intercept's movement as a real improvement;
    // it was not one, and the same caution applies to the next person who sees it move.
    //
    // The figures above are dominated by DB weight rather than by compute in any case: at three full
    // pages the call declares 1,544 reads and 1,799 writes, which is 218 ms of the 230.
    //
    // ⚠ RAISING or LOWERING this is safe in a way the old `MaxObserved` was not. Lowering it used to be a
    // brick vector (the clamp bases were `BoundedVec<_, MaxObserved>`, so a live vec longer than a lowered
    // bound failed to decode and `ValueQuery` handed back an EMPTY basis, stranding the weight of every
    // account that had since unlocked). The bases are StorageMaps now — no length prefix to overrun, every
    // row decodes on its own — so this bound touches only how fast a change set drains.
    type MaxChangesPerBlock = ConstU32<256>;
    // Max observed roles per ACCOUNT — a per-identity bound, never a population one.
    //
    // EQUAL to `pallet_cardano_roles::MAX_OBSERVED_ROLES_PER_ACCOUNT` since spec 217, where it used to be
    // double it. That inverts which layer cuts — the observer's `bounded_roles` now reaches its bound
    // first and the sink's truncation never acts — and that is safe here only because BOTH layers reserve
    // the non-SPO slots (see the ⚠ below and `Pallet::bound_observed_roles`). The trade is deliberate:
    // headroom bought nothing at 16, because 16 was itself below what a real mSPO needs, so the badges
    // the headroom protected were being dropped anyway one layer down.
    //
    // ⚠ Sizing does NOT make the observer's own cut safe, and it is not what makes it safe. An account
    // with more than 32 role entries reaches this bound however generous it is, and the canonical role
    // order puts every SPO entry ahead of every dRep/CC one — so a first-N cut here would drop exactly the
    // badges the sink's two-pass reserve exists to protect, one layer upstream of where that fix lives.
    // `Pallet::bounded_roles` therefore reserves non-SPO slots itself. This value only decides how often
    // either reserve has to act.
    type MaxRolesPerAccount = ConstU32<MAX_ROLES_PER_ACCOUNT>;
    // The cap on the per-block credential SCANS that scope the node's db-sync query, and on the read-side
    // observed-account joins. NOT a bound on the observation — see the pallet's `MaxScanned` docs. It kept
    // its 1024 value across the spec-215 rewrite because its reason is unchanged: `link_stake_signed` and
    // `claim_role_signed` are feeless bare-unsigned calls, so an unbounded scan of the maps they grow is a
    // free way to enlarge every node's per-block work until the db-sync query blows its timeout.
    //
    // ⚠ IT IS NO LONGER A CEILING ON ANY AXIS. Spec 220 made the scan a rotating WINDOW over
    // cogno-gate's slot table rather than a hash-ordered PREFIX of it, so a credential past the cap is
    // scanned a few blocks later instead of never. It is a work-per-block knob and nothing else, and
    // `ObserverConfig::scan_sweep_blocks` is what says how long "a few blocks later" is.
    //
    // The two paragraphs this replaces described the pre-220 world and are kept in summary because the
    // reasoning is what justifies the shape: the scan is the SCOPE of the node's read, so a credential
    // outside it is absent from the observation, which a naive `derive_call` could not tell apart from
    // "the stake went to zero" and applied by ZEROING that account. Iteration was by hashed key and
    // `blake2_128` is grindable offline, so a feeless bind flood could evict a chosen account's weight
    // on purpose. Spec 217 pinned the already-credited set against the eviction half; spec 220 retired
    // the pin outright by teaching `derive_call` the scope, so an out-of-window basis row is HELD.
    //
    // ⚠ Spec 219 REMOVED the hard ceiling that used to sit here. `close_poll` paged its tally and no
    // longer declares `6 × MaxObservedAccounts` DB reads, so raising this can no longer make the feeless
    // close undispatchable and no longer decides whether a poll can be finalized at all. What remains is
    // a read-latency cost: `MaxObservedAccounts` (pallet-microblog) is still an alias of it, and the two
    // `.take(cap)` joins above still bound a dozen unmetered `state_call` read paths that rebuild
    // `staker_weights()` per call. Raising it also still changes the LIVE poll tally values those joins
    // serve — but no longer the FROZEN ones, which now count every voter.
    type MaxScanned = ConstU32<MAX_SCANNED>;
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
    // The rotating scan window (spec 220): cogno-gate's account rotation, read from this pallet's own
    // `ScanCursor`. One window scopes all four db-sync credential arrays AND `derive_call`'s
    // absence-means-cleared test, which is what keeps the two from ever disagreeing.
    type ScanWindow = GateScanWindow;
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
