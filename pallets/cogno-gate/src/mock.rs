//! Test mock runtime for `pallet-cogno-gate`.
//!
//! This is the faithful **integration** mock for M2: it wires the real `CognoGate`,
//! `Microblog`, and `TalkStake` together exactly as the runtime does (microblog's
//! `IdentityGate = CognoGate`, the gate's `OnBind = Microblog`), so the tests exercise the
//! actual `link_identity → is_allowed → post` flow, the `on_first_bind` provider/capacity
//! priming, and the 1:1 enforcement — not stubs.

use crate as pallet_cogno_gate;
use frame_support::{
	derive_impl,
	traits::{ConstU128, ConstU32},
};
use frame_system::EnsureRoot;
use sp_runtime::BuildStorage;

type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
	pub enum Test {
		System: frame_system,
		TalkStake: pallet_talk_stake,
		Microblog: pallet_microblog,
		CognoGate: pallet_cogno_gate,
	}
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
}

impl pallet_talk_stake::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type SetStakeOrigin = EnsureRoot<u64>;
	type MaxStakeWeight = ConstU128<100_000_000>;
	type WeightInfo = ();
}

// Same small, legible capacity constants as the microblog mock.
impl pallet_microblog::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type MaxLength = ConstU32<512>;
	type MaxPostsPerAuthor = ConstU32<8>;
	type CapRatio = ConstU128<10>;
	type RegenPerBlock = ConstU128<1>;
	type Ceiling = ConstU128<5_000>;
	type BaseCost = ConstU128<100>;
	type PerByteCost = ConstU128<1>;
	type ForceOrigin = EnsureRoot<u64>;
	// The REAL gate — this is what makes the mock an integration test.
	type IdentityGate = CognoGate;
	type WeightInfo = ();
}

impl pallet_cogno_gate::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	// Root in the mock mirrors the v1 dev sudo escape hatch (DR-07).
	type FollowerOrigin = EnsureRoot<u64>;
	// The first-bind hook into microblog (primes the capacity row + provider ref).
	type OnBind = Microblog;
	type WeightInfo = ();
}

/// Build a genesis storage for tests.
pub fn new_test_ext() -> sp_io::TestExternalities {
	frame_system::GenesisConfig::<Test>::default()
		.build_storage()
		.unwrap()
		.into()
}
