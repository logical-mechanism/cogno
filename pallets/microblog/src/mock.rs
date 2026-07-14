//! Test mock runtime for `pallet-microblog` (now with the folded talk-capacity meter).

use crate as pallet_microblog;
use core::cell::RefCell;
use frame_support::{
    derive_impl,
    traits::{ConstU128, ConstU32},
};
use frame_system::EnsureRoot;
use sp_runtime::BuildStorage;

type Block = frame_system::mocking::MockBlock<Test>;

thread_local! {
    /// Accounts explicitly denied by the mock identity gate. Empty ⇒ allow all, so the existing
    /// posting tests need no change; a test calls [`deny_identity`] to exercise the `NotAllowed`
    /// branch. The real deny-by-default gate (`link_identity` → `is_allowed`) is integration-
    /// tested faithfully in `pallet-cogno-gate`'s own mock.
    static GATE_DENIED: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
}

/// Mock identity gate: allows everyone except accounts passed to [`deny_identity`].
pub struct MockIdentityGate;
impl pallet_microblog::IsAllowed<u64> for MockIdentityGate {
    fn is_allowed(who: &u64) -> bool {
        GATE_DENIED.with(|d| !d.borrow().contains(who))
    }

    // The mock allows everyone by default, so the benchmark setup hook is a no-op here.
    #[cfg(feature = "runtime-benchmarks")]
    fn benchmark_set_allowed(_who: &u64) {}
}

/// Deny `who` at the mock identity gate (to exercise the `NotAllowed` post path).
pub fn deny_identity(who: u64) {
    GATE_DENIED.with(|d| d.borrow_mut().push(who));
}

/// Mock foreign cost source: prices `System::remark` at 200 micro-capacity units (a stand-in for a
/// real foreign feeless call, e.g. `pallet-profile`'s writes in the runtime). Lets the `ForeignCost`
/// seam — non-microblog calls sharing the one battery, gated at the pool — be unit-tested without
/// wiring a second pallet into this mock.
pub struct MockForeignCost;
impl pallet_microblog::ForeignCapacityCost<RuntimeCall> for MockForeignCost {
    fn cost(call: &RuntimeCall) -> Option<u128> {
        match call {
            RuntimeCall::System(frame_system::Call::remark { .. }) => Some(200),
            _ => None,
        }
    }
}

frame_support::construct_runtime!(
    pub enum Test {
        System: frame_system,
        TalkStake: pallet_talk_stake,
        Microblog: pallet_microblog,
    }
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
    type Block = Block;
}

// talk-stake is a call-less observer-written ledger; the tests drive its `apply_weight` /
// `apply_voting_power` writers directly to set up posting weight + voting power.
impl pallet_talk_stake::Config for Test {
    type RuntimeEvent = RuntimeEvent;
}

// Small, round capacity constants chosen for legible test assertions:
//   cap = min(weight·10, 5_000) ;  rate = weight·1 per block ;  cost = 100 + 1·len bytes
impl pallet_microblog::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type MaxLength = ConstU32<512>;
    // Deliberately small here so the `TooManyPosts` overflow path is cheap to test.
    type MaxPostsPerAuthor = ConstU32<8>;
    type CapRatio = ConstU128<10>;
    type RegenPerBlock = ConstU128<1>;
    type Ceiling = ConstU128<5_000>;
    type BaseCost = ConstU128<100>;
    type PerByteCost = ConstU128<1>;
    // Engagement costs are a fraction of a post (BaseCost 100) so tests can prime small buckets.
    type VoteCost = ConstU128<50>;
    type FollowCost = ConstU128<30>;
    type MaxPollOptions = ConstU32<4>;
    type MaxPollOptionLen = ConstU32<32>;
    type ForceOrigin = EnsureRoot<u64>;
    type IdentityGate = MockIdentityGate;
    type ForeignCost = MockForeignCost;
    type WeightInfo = ();
}

/// The observer's weight sink, reproducing the runtime's `WeightApply` body verbatim
/// (`runtime/src/configs/mod.rs`). The `cardano-observer` inherent is the ONLY writer of weight on a
/// real chain and it goes through that sink, so the capacity tests must drive THIS — not
/// `TalkStake::apply_weight` directly. `apply_weight` alone never touches the capacity row, so a test
/// that calls it directly cannot see a missing settle and will pass while the retro-credit bug is live.
///
/// Keep the two bodies in lockstep: the settle-before-apply order and the `previous != weight` guard are
/// the whole fix.
pub fn observe_weight(who: &u64, weight: u128) {
    let previous = pallet_talk_stake::AllowedStake::<Test>::get(who);
    if previous != weight {
        pallet_microblog::Pallet::<Test>::settle_capacity_at(who, previous);
        pallet_talk_stake::Pallet::<Test>::apply_weight(who, weight);
    }
    pallet_microblog::Pallet::<Test>::on_first_bind(who);
}

/// Build a genesis storage for tests.
pub fn new_test_ext() -> sp_io::TestExternalities {
    // Reset the thread-local gate deny-set so tests on the same thread don't leak into each other.
    GATE_DENIED.with(|d| d.borrow_mut().clear());
    frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap()
        .into()
}
