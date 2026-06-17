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

impl pallet_talk_stake::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type SetStakeOrigin = EnsureRoot<u64>;
	type WeightInfo = ();
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
	type ForceOrigin = EnsureRoot<u64>;
	type IdentityGate = MockIdentityGate;
	type WeightInfo = ();
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
