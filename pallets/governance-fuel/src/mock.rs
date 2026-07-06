//! Mock runtime for `pallet-governance-fuel` — System + Balances + GovernanceFuel. `GrantOrigin` is
//! `EnsureRoot` here purely to exercise the origin gate (the real runtime wires the ≥3/5 committee). A
//! non-zero existential deposit (1_000) lets the below-ED and reap paths bite; `RegenPeriod = 5` and
//! `MaxFundedAccounts = 64` mirror the runtime shape.

use crate as pallet_governance_fuel;
use frame_support::{derive_impl, parameter_types, traits::ConstU32};
use frame_system::EnsureRoot;
use pallet_balances::AccountData;
use sp_runtime::BuildStorage;

type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
    pub enum Test {
        System: frame_system,
        Balances: pallet_balances,
        GovernanceFuel: pallet_governance_fuel,
    }
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
    type Block = Block;
    type AccountData = AccountData<u64>;
}

parameter_types! {
    pub const ExistentialDeposit: u64 = 1_000;
}

#[derive_impl(pallet_balances::config_preludes::TestDefaultConfig as pallet_balances::DefaultConfig)]
impl pallet_balances::Config for Test {
    type AccountStore = System;
    type ExistentialDeposit = ExistentialDeposit;
}

parameter_types! {
    /// Per-account allowance ceiling for the mock.
    pub const MaxAllowance: u64 = 1_000_000;
    /// Per-account payability floor for the mock — deliberately ABOVE the ED (1_000) so the "an
    /// ED-only grant is rejected" behaviour is exercised.
    pub const MinAllowance: u64 = 2_000;
    /// Regeneration cadence in blocks.
    pub const RegenPeriod: u64 = 5;
}

/// Mock "seated committee member" set: account 99 stands in for a seated member (the real runtime reads
/// `pallet_collective::Members`). Lets the `revoke`-still-seated guard be exercised without a collective.
pub struct SeatedIsNinetyNine;
impl frame_support::traits::Contains<u64> for SeatedIsNinetyNine {
    fn contains(who: &u64) -> bool {
        *who == 99
    }
}

impl pallet_governance_fuel::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type GrantOrigin = EnsureRoot<Self::AccountId>;
    type Seated = SeatedIsNinetyNine;
    type Currency = Balances;
    type MaxAllowance = MaxAllowance;
    type MinAllowance = MinAllowance;
    type MaxFundedAccounts = ConstU32<64>;
    type RegenPeriod = RegenPeriod;
    type WeightInfo = ();
}

pub fn new_test_ext() -> sp_io::TestExternalities {
    let t = frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap();
    let mut ext = sp_io::TestExternalities::new(t);
    // Block 1 so deposited events are captured (the genesis block discards them).
    ext.execute_with(|| System::set_block_number(1));
    ext
}
