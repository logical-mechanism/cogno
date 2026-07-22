//! Test mock runtime for `pallet-cardano-observer`.
//!
//! The cross-pallet collaborators are mocked via thread-local fixtures so the pallet's pure
//! verification/application logic is testable in isolation: `MockBeacons` (cogno-gate `AccountOf`),
//! `MockSink` (the talk-stake + microblog weight/capacity adapter), and `MockTime` (the block clock).

use crate as pallet_cardano_observer;
use crate::{BeaconResolver, StakeResolver, VotingPowerSink, WeightSink};
use core::time::Duration;
use frame_support::{
    derive_impl, parameter_types,
    traits::{ConstU128, ConstU32, ConstU64, UnixTime},
};
use sp_runtime::BuildStorage;
use std::cell::RefCell;
use std::collections::BTreeMap;

type Block = frame_system::mocking::MockBlock<Test>;
pub type AccountId = u64;

frame_support::construct_runtime!(
    pub enum Test {
        System: frame_system,
        CardanoObserver: pallet_cardano_observer,
    }
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
    type Block = Block;
}

/// The observed-role record a `MockRoleSink::set_roles` records: `(role_kind_index, display_id,
/// chamber_weight)` triples (spec 207).
type ObservedRoleRec = Vec<(u8, [u8; 28], u128)>;

thread_local! {
    static BINDINGS: RefCell<BTreeMap<[u8; 32], AccountId>> = const { RefCell::new(BTreeMap::new()) };
    static WEIGHTS: RefCell<BTreeMap<AccountId, u128>> = const { RefCell::new(BTreeMap::new()) };
    static STAKE_BINDINGS: RefCell<BTreeMap<[u8; 28], AccountId>> = const { RefCell::new(BTreeMap::new()) };
    static VOTING_POWERS: RefCell<BTreeMap<AccountId, u128>> = const { RefCell::new(BTreeMap::new()) };
    static ROLE_BINDINGS: RefCell<BTreeMap<[u8; 28], AccountId>> = const { RefCell::new(BTreeMap::new()) };
    static OBSERVED_ROLES: RefCell<BTreeMap<AccountId, ObservedRoleRec>> = const { RefCell::new(BTreeMap::new()) };
    static NOW_SECS: RefCell<u64> = const { RefCell::new(0) };
}

/// cogno-gate `AccountOf` stand-in.
pub struct MockBeacons;
impl BeaconResolver<AccountId> for MockBeacons {
    fn resolve(beacon: &[u8; 32]) -> Option<AccountId> {
        BINDINGS.with(|b| b.borrow().get(beacon).copied())
    }
}
/// Bind a beacon to an account (the cogno-gate `link_identity` fixture).
pub fn bind(beacon: [u8; 32], who: AccountId) {
    BINDINGS.with(|b| {
        b.borrow_mut().insert(beacon, who);
    });
}

/// talk-stake + microblog weight/capacity adapter stand-in — records the last weight per account.
pub struct MockSink;
impl WeightSink<AccountId> for MockSink {
    fn set_weight(who: &AccountId, weight: u128) {
        WEIGHTS.with(|w| {
            w.borrow_mut().insert(*who, weight);
        });
    }
}
/// The weight last written for `who` (0 if never written).
pub fn weight_of(who: AccountId) -> u128 {
    WEIGHTS.with(|w| w.borrow().get(&who).copied().unwrap_or(0))
}
/// Whether `set_weight` was ever called for `who` (distinguishes "skipped" from "set to 0").
pub fn was_written(who: AccountId) -> bool {
    WEIGHTS.with(|w| w.borrow().contains_key(&who))
}

/// cogno-gate `AccountOfStakeCred` stand-in (stake credential → bound account).
pub struct MockStakeResolver;
impl StakeResolver<AccountId> for MockStakeResolver {
    fn resolve(stake_cred: &[u8; 28]) -> Option<AccountId> {
        STAKE_BINDINGS.with(|b| b.borrow().get(stake_cred).copied())
    }
}
/// Bind a stake credential to an account (the cogno-gate `link_stake_signed` fixture).
pub fn bind_stake(stake_cred: [u8; 28], who: AccountId) {
    STAKE_BINDINGS.with(|b| {
        b.borrow_mut().insert(stake_cred, who);
    });
}

/// talk-stake `apply_voting_power` adapter stand-in — records the last voting power per account.
pub struct MockVotingPowerSink;
impl VotingPowerSink<AccountId> for MockVotingPowerSink {
    fn set_voting_power(who: &AccountId, weight: u128) {
        VOTING_POWERS.with(|w| {
            w.borrow_mut().insert(*who, weight);
        });
    }
}
/// The voting power last written for `who` (0 if never written).
pub fn voting_power_of(who: AccountId) -> u128 {
    VOTING_POWERS.with(|w| w.borrow().get(&who).copied().unwrap_or(0))
}

/// Role credential → account resolver stand-in (any `RoleSource` resolves via one fixture map — the
/// tests bind a credential once with [`bind_role`]).
pub struct MockRoleResolver;
impl crate::RoleResolver<AccountId> for MockRoleResolver {
    fn resolve(_source: crate::RoleSource, credential: &[u8; 28]) -> Option<AccountId> {
        ROLE_BINDINGS.with(|m| m.borrow().get(credential).copied())
    }
}
/// Bind a role credential to an account for the resolver.
pub fn bind_role(credential: [u8; 28], who: AccountId) {
    ROLE_BINDINGS.with(|m| {
        m.borrow_mut().insert(credential, who);
    });
}

/// Observed-role sink stand-in — records the last `(kind_index, id, chamber_weight)` set written per
/// account.
pub struct MockRoleSink;
impl crate::RoleSink<AccountId> for MockRoleSink {
    fn set_roles(who: &AccountId, roles: &[(u8, [u8; 28], u128)]) {
        OBSERVED_ROLES.with(|m| {
            m.borrow_mut().insert(*who, roles.to_vec());
        });
    }
}
/// The role set last written for `who` (empty if never written / cleared), WEIGHT PROJECTED OUT — the
/// `(kind_index, id)` view the credit/clamp tests assert against.
pub fn observed_roles_of(who: AccountId) -> Vec<(u8, [u8; 28])> {
    OBSERVED_ROLES.with(|m| {
        m.borrow()
            .get(&who)
            .map(|v| v.iter().map(|(k, id, _w)| (*k, *id)).collect())
            .unwrap_or_default()
    })
}
/// The FULL role set last written for `who` (kind_index, id, chamber weight) — for the spec-207
/// chamber-weight flow tests.
pub fn observed_roles_full_of(who: AccountId) -> Vec<(u8, [u8; 28], u128)> {
    OBSERVED_ROLES.with(|m| m.borrow().get(&who).cloned().unwrap_or_default())
}
/// Whether `set_voting_power` was ever called for `who` (distinguishes "skipped" from "set to 0").
pub fn vp_was_written(who: AccountId) -> bool {
    VOTING_POWERS.with(|w| w.borrow().contains_key(&who))
}

/// Benchmark-only setup seam. The runtime's impl writes the real cogno-gate / talk-stake / microblog rows;
/// here it writes the fixture maps those stand in for, so `impl_benchmark_test_suite!` exercises the
/// benchmark bodies as tests.
#[cfg(feature = "runtime-benchmarks")]
pub struct MockBenchSetup;
#[cfg(feature = "runtime-benchmarks")]
impl pallet_cardano_observer::BenchmarkSetup<AccountId> for MockBenchSetup {
    fn bench_bind_beacon(beacon: &[u8; 32], i: u32) {
        bind(*beacon, Self::bench_account(i));
    }
    fn bench_bind_stake_cred(cred: &[u8; 28], i: u32) {
        bind_stake(*cred, Self::bench_account(i));
    }
    fn bench_account(i: u32) -> AccountId {
        i as AccountId
    }
}

/// The block clock stand-in (`pallet_timestamp` in the real runtime).
pub struct MockTime;
impl UnixTime for MockTime {
    fn now() -> Duration {
        Duration::from_secs(NOW_SECS.with(|n| *n.borrow()))
    }
}
pub fn set_now_secs(s: u64) {
    NOW_SECS.with(|n| *n.borrow_mut() = s);
}

// Mock anchor (preprod-shaped) + bounds.
pub const SHELLEY_START_UNIX: u64 = 1_655_769_600;
pub const SHELLEY_START_SLOT: u64 = 86_400;
pub const STABILITY_SLOTS: u64 = 1_000; // small for the mock
pub const MIN_LOCK: u128 = 100_000_000;
pub const MAX_STAKE_WEIGHT: u128 = 45_000_000_000_000_000;
/// Blocks without an applied observation before the stall alarm latches (small, so the tests can cross it).
pub const STALL_AFTER: u64 = 10;

parameter_types! {
    // A dummy 28-byte policy id for the mock (the real one is the live vault hash in the runtime).
    pub const MockVaultPolicyId: [u8; 28] = [0u8; 28];
}

impl pallet_cardano_observer::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    // ⚠ Must equal the runtime's `MaxObserved`: it is also the upper bound of the `observe` benchmark's
    // `Linear` components (which need a literal), and `impl_benchmark_test_suite!` runs those bodies
    // against THIS mock. A smaller bound here fails the benchmark's seeding.
    type MaxObserved = ConstU32<1024>;
    type MaxStakeWeight = ConstU128<MAX_STAKE_WEIGHT>;
    type MinLock = ConstU128<MIN_LOCK>;
    type StabilitySlots = ConstU64<STABILITY_SLOTS>;
    type ShelleyStartUnix = ConstU64<SHELLEY_START_UNIX>;
    type ShelleyStartSlot = ConstU64<SHELLEY_START_SLOT>;
    type VaultPolicyId = MockVaultPolicyId;
    type MaxVotingPower = ConstU128<MAX_STAKE_WEIGHT>;
    type StakeEpochLookback = ConstU64<1>;
    type StallAfter = ConstU64<STALL_AFTER>;
    type BeaconResolver = MockBeacons;
    type StakeResolver = MockStakeResolver;
    type WeightSink = MockSink;
    type VotingPowerSink = MockVotingPowerSink;
    type RoleResolver = MockRoleResolver;
    type RoleSink = MockRoleSink;
    // Root-only in the mock (the runtime uses the 3-of-5 AuthorityOrigin); enough to exercise the gate.
    type EnforceOrigin = frame_system::EnsureRoot<AccountId>;
    type UnixTime = MockTime;
    type WeightInfo = ();
    #[cfg(feature = "runtime-benchmarks")]
    type BenchmarkSetup = MockBenchSetup;
}

/// A "now" well past the Shelley anchor (so the stability bound is active) — the corresponding Cardano
/// slot is `SHELLEY_START_SLOT + ELAPSED`, and the max legitimate reference is that minus `STABILITY_SLOTS`.
pub const ELAPSED_SECS: u64 = 1_000_000;
pub const NOW_SECS_DEFAULT: u64 = SHELLEY_START_UNIX + ELAPSED_SECS;
/// = cardano_slot(now) − STABILITY_SLOTS, the boundary the `ReferenceTooFresh` check uses.
pub const MAX_REFERENCE: u64 = SHELLEY_START_SLOT + ELAPSED_SECS - STABILITY_SLOTS;

pub fn new_test_ext() -> sp_io::TestExternalities {
    // Reset thread-local fixtures so tests don't leak state into each other.
    BINDINGS.with(|b| b.borrow_mut().clear());
    WEIGHTS.with(|w| w.borrow_mut().clear());
    STAKE_BINDINGS.with(|b| b.borrow_mut().clear());
    VOTING_POWERS.with(|w| w.borrow_mut().clear());
    set_now_secs(NOW_SECS_DEFAULT);
    frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap()
        .into()
}
