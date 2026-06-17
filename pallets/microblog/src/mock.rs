//! Test mock runtime for `pallet-microblog` (now with the folded talk-capacity meter).

use crate as pallet_microblog;
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
	type WeightInfo = ();
}

/// Build a genesis storage for tests.
pub fn new_test_ext() -> sp_io::TestExternalities {
	frame_system::GenesisConfig::<Test>::default()
		.build_storage()
		.unwrap()
		.into()
}
