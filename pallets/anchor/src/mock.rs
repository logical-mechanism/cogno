//! Test mock runtime for `pallet-anchor`.

use crate as pallet_anchor;
use frame_support::derive_impl;
use frame_system::EnsureRoot;
use sp_runtime::BuildStorage;

type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
	pub enum Test {
		System: frame_system,
		Anchor: pallet_anchor,
	}
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
}

impl pallet_anchor::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	// In the mock the relayer ack authority is root (mirrors the v1 dev sudo escape hatch, DR-07).
	type AnchorOrigin = EnsureRoot<u64>;
	type WeightInfo = ();
}

/// Build a genesis storage for tests.
pub fn new_test_ext() -> sp_io::TestExternalities {
	let mut ext: sp_io::TestExternalities = frame_system::GenesisConfig::<Test>::default()
		.build_storage()
		.unwrap()
		.into();
	// Events are only collected from block 1 onward.
	ext.execute_with(|| System::set_block_number(1));
	ext
}
