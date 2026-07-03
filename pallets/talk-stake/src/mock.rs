//! Test mock runtime for `pallet-talk-stake` — a call-less observer-written ledger, so the mock only
//! wires `RuntimeEvent` and the tests drive the internal `apply_weight` / `apply_voting_power` writers
//! directly (there is no extrinsic, origin, or cap in this pallet any more — the cap/skip lives in the
//! `cardano-observer` inherent that calls these writers).

use crate as pallet_talk_stake;
use frame_support::derive_impl;
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
}

/// Build a genesis storage for tests (no seeded weights by default).
pub fn new_test_ext() -> sp_io::TestExternalities {
    frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap()
        .into()
}

/// Build a genesis storage seeding `(account, allowed_stake, voting_power)` triples (the dev/local
/// genesis path).
pub fn new_test_ext_with_weights(weights: Vec<(u64, u128, u128)>) -> sp_io::TestExternalities {
    let mut t = frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap();
    pallet_talk_stake::GenesisConfig::<Test> {
        initial_weights: weights,
    }
    .assimilate_storage(&mut t)
    .unwrap();
    t.into()
}
