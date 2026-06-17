//! Test mock runtime for `pallet-microblog`.

use crate as pallet_microblog;
use frame_support::{derive_impl, traits::ConstU32};
use sp_runtime::BuildStorage;

type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
	pub enum Test {
		System: frame_system,
		Microblog: pallet_microblog,
	}
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
}

impl pallet_microblog::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type MaxLength = ConstU32<512>;
	// Deliberately small here so the `TooManyPosts` overflow path is cheap to test.
	type MaxPostsPerAuthor = ConstU32<8>;
	type WeightInfo = ();
}

/// Build a genesis storage for tests.
pub fn new_test_ext() -> sp_io::TestExternalities {
	frame_system::GenesisConfig::<Test>::default()
		.build_storage()
		.unwrap()
		.into()
}
