//! Test mock runtime for `pallet-talk-stake`.

use crate as pallet_talk_stake;
use frame_support::{derive_impl, traits::ConstU128};
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

/// The mock cap (`MaxStakeWeight`). Exposed so the boundary tests can assert exactly at the
/// cap and at cap + 1 without hard-coding the literal in two places.
pub const MAX_STAKE_WEIGHT: u128 = 100_000_000;

impl pallet_talk_stake::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	// In the mock the follower authority is root (mirrors the v1 dev sudo escape hatch).
	type SetStakeOrigin = EnsureRoot<u64>;
	type MaxStakeWeight = ConstU128<MAX_STAKE_WEIGHT>;
	type WeightInfo = ();
}

/// Build a genesis storage for tests.
pub fn new_test_ext() -> sp_io::TestExternalities {
	frame_system::GenesisConfig::<Test>::default()
		.build_storage()
		.unwrap()
		.into()
}

// ── A second mock runtime whose cap is `u128::MAX` ──────────────────────────────────────────
// Used to prove the `weight <= MaxStakeWeight` ensure! is a *true comparison* against the
// configured constant (not a hidden internal limit): with the cap at the type maximum,
// `u128::MAX` itself must be accepted and there is no representable value that can exceed it.
// Lives in its own module so its `construct_runtime!`-generated aliases (RuntimeOrigin, …)
// do not collide with the primary mock's.
pub mod maxcap {
	use crate as pallet_talk_stake;
	use frame_support::{derive_impl, traits::ConstU128};
	use frame_system::EnsureRoot;
	use sp_runtime::BuildStorage;

	frame_support::construct_runtime!(
		pub enum Test {
			System: frame_system,
			TalkStake: pallet_talk_stake,
		}
	);

	#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
	impl frame_system::Config for Test {
		type Block = frame_system::mocking::MockBlock<Test>;
	}

	impl pallet_talk_stake::Config for Test {
		type RuntimeEvent = RuntimeEvent;
		type SetStakeOrigin = EnsureRoot<u64>;
		type MaxStakeWeight = ConstU128<{ u128::MAX }>;
		type WeightInfo = ();
	}

	/// Build a genesis storage for the `u128::MAX`-cap mock.
	pub fn new_test_ext() -> sp_io::TestExternalities {
		frame_system::GenesisConfig::<Test>::default()
			.build_storage()
			.unwrap()
			.into()
	}
}
