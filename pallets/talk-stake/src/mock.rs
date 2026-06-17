//! Test mock runtime for `pallet-talk-stake`.

use crate as pallet_talk_stake;
use frame_support::derive_impl;
use frame_system::EnsureRoot;
use sp_runtime::BuildStorage;

type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
	pub enum Test {
		System: frame_system,
		TalkStake: pallet_talk_stake,
	}
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
}

impl pallet_talk_stake::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	// In the mock the follower authority is root (mirrors the v1 dev sudo escape hatch).
	type SetStakeOrigin = EnsureRoot<u64>;
	type WeightInfo = ();
}

/// Build a genesis storage for tests.
pub fn new_test_ext() -> sp_io::TestExternalities {
	frame_system::GenesisConfig::<Test>::default()
		.build_storage()
		.unwrap()
		.into()
}
