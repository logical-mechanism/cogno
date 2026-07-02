//! Mock runtime for `pallet-governed-upgrade` — System + GovernedUpgrade only. `AuthorityOrigin` is
//! `EnsureRoot` here purely to exercise the origin gate (the real runtime wires the ≥3/5 committee).

use crate as pallet_governed_upgrade;
use frame_support::derive_impl;
use frame_system::EnsureRoot;
use sp_runtime::BuildStorage;

type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
	pub enum Test {
		System: frame_system,
		GovernedUpgrade: pallet_governed_upgrade,
	}
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
}

impl pallet_governed_upgrade::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type AuthorityOrigin = EnsureRoot<Self::AccountId>;
	type WeightInfo = ();
}

pub fn new_test_ext() -> sp_io::TestExternalities {
	let t = frame_system::GenesisConfig::<Test>::default().build_storage().unwrap();
	let mut ext = sp_io::TestExternalities::new(t);
	// Block 1 so deposited events are captured (the genesis block discards them).
	ext.execute_with(|| System::set_block_number(1));
	ext
}
