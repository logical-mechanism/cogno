//! Mock runtime for `pallet-validator-set` — System + Balances + ValidatorSet + Session, wired to
//! the pinned SDK's `pallet-session` (the newer `Currency` / `KeyDeposit` / `DisablingStrategy`
//! API). Mirrors `_sdk/substrate/frame/session/src/mock.rs` for those fields. Genesis seats three
//! validators `[1, 2, 3]`.

use crate as pallet_validator_set;
use frame_support::{derive_impl, parameter_types, traits::Get};
use frame_system::EnsureRoot;
use pallet_balances::AccountData;
use sp_runtime::{
	testing::UintAuthorityId,
	traits::OpaqueKeys,
	BuildStorage, KeyTypeId, Perbill, RuntimeAppPublic,
};
use sp_staking::{
	offence::{Kind, Offence},
	SessionIndex,
};

type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
	pub enum Test {
		System: frame_system,
		Balances: pallet_balances,
		ValidatorSet: pallet_validator_set,
		Session: pallet_session,
	}
);

sp_runtime::impl_opaque_keys! {
	pub struct MockSessionKeys {
		pub dummy: UintAuthorityId,
	}
}

impl From<UintAuthorityId> for MockSessionKeys {
	fn from(dummy: UintAuthorityId) -> Self {
		Self { dummy }
	}
}

/// Minimal session handler: it just records the validators it is told about. Enough to exercise
/// `pallet-session`'s genesis + the `SessionManager` wiring without real Aura/GRANDPA keys.
pub struct TestSessionHandler;
impl pallet_session::SessionHandler<u64> for TestSessionHandler {
	const KEY_TYPE_IDS: &'static [KeyTypeId] = &[UintAuthorityId::ID];
	fn on_genesis_session<T: OpaqueKeys>(_validators: &[(u64, T)]) {}
	fn on_new_session<T: OpaqueKeys>(_changed: bool, _v: &[(u64, T)], _q: &[(u64, T)]) {}
	fn on_disabled(_validator_index: u32) {}
}

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
	type AccountData = AccountData<u64>;
}

#[derive_impl(pallet_balances::config_preludes::TestDefaultConfig as pallet_balances::DefaultConfig)]
impl pallet_balances::Config for Test {
	type AccountStore = System;
}

parameter_types! {
	pub const MaxValidators: u32 = 5;
	pub const Period: u64 = 2;
	pub const Offset: u64 = 0;
	pub const MockKeyDeposit: u64 = 0;
}

thread_local! {
	/// `MinAuthorities` is configurable per-test (defaults to 2) so the floor boundary can be
	/// exercised at edge values like 1 (single-validator set) without a second mock runtime.
	static MIN_AUTHORITIES: core::cell::Cell<u32> = const { core::cell::Cell::new(2) };
}

/// `Get<u32>` shim reading the thread-local `MIN_AUTHORITIES`. Set it with [`set_min_authorities`].
pub struct MinAuthorities;
impl Get<u32> for MinAuthorities {
	fn get() -> u32 {
		MIN_AUTHORITIES.with(|m| m.get())
	}
}

/// Override the `MinAuthorities` floor for the current test thread.
pub fn set_min_authorities(min: u32) {
	MIN_AUTHORITIES.with(|m| m.set(min));
}

impl pallet_validator_set::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type AddRemoveOrigin = EnsureRoot<Self::AccountId>;
	type MinAuthorities = MinAuthorities;
	type MaxValidators = MaxValidators;
	type WeightInfo = ();
}

/// A minimal [`Offence`] for testing the dormant `ReportOffence` -> `mark_for_removal` path. Only
/// `offenders()` is consulted by the pallet's impl; the rest return inert values.
pub struct MockOffence {
	pub offenders: Vec<(u64, u64)>,
}

impl Offence<(u64, u64)> for MockOffence {
	const ID: Kind = *b"mock:offline----";
	type TimeSlot = u128;

	fn offenders(&self) -> Vec<(u64, u64)> {
		self.offenders.clone()
	}

	fn session_index(&self) -> SessionIndex {
		0
	}

	fn validator_set_count(&self) -> u32 {
		0
	}

	fn time_slot(&self) -> Self::TimeSlot {
		0
	}

	fn slash_fraction(&self, _offenders_count: u32) -> Perbill {
		Perbill::zero()
	}
}

impl pallet_session::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type ValidatorId = u64;
	type ValidatorIdOf = pallet_validator_set::ValidatorOf<Self>;
	type ShouldEndSession = pallet_session::PeriodicSessions<Period, Offset>;
	type NextSessionRotation = pallet_session::PeriodicSessions<Period, Offset>;
	type SessionManager = ValidatorSet;
	type SessionHandler = TestSessionHandler;
	type Keys = MockSessionKeys;
	type DisablingStrategy = pallet_session::disabling::UpToLimitWithReEnablingDisablingStrategy;
	type WeightInfo = ();
	type Currency = Balances;
	type KeyDeposit = MockKeyDeposit;
}

/// Genesis: three validators `[1, 2, 3]`, each endowed and with registered (mock) session keys.
pub fn new_test_ext() -> sp_io::TestExternalities {
	// Reset the per-thread floor in case a prior test on this thread lowered it.
	set_min_authorities(2);
	let mut t = frame_system::GenesisConfig::<Test>::default().build_storage().unwrap();

	pallet_balances::GenesisConfig::<Test> {
		balances: vec![(1, 1_000), (2, 1_000), (3, 1_000), (4, 1_000)],
		dev_accounts: None,
	}
	.assimilate_storage(&mut t)
	.unwrap();

	pallet_validator_set::GenesisConfig::<Test> { initial_validators: vec![1, 2, 3] }
		.assimilate_storage(&mut t)
		.unwrap();

	let keys: Vec<_> =
		vec![1u64, 2, 3].into_iter().map(|i| (i, i, UintAuthorityId(i).into())).collect();
	pallet_session::GenesisConfig::<Test> { keys, ..Default::default() }
		.assimilate_storage(&mut t)
		.unwrap();

	let mut ext = sp_io::TestExternalities::new(t);
	ext.execute_with(|| System::set_block_number(1));
	ext
}

/// Genesis with a SINGLE validator `[1]` and `MinAuthorities = 1`, so the bottom-of-range floor
/// boundary (removing the last validator -> target 0 < 1) can be exercised directly.
pub fn single_validator_ext() -> sp_io::TestExternalities {
	set_min_authorities(1);
	let mut t = frame_system::GenesisConfig::<Test>::default().build_storage().unwrap();

	pallet_balances::GenesisConfig::<Test> {
		balances: vec![(1, 1_000)],
		dev_accounts: None,
	}
	.assimilate_storage(&mut t)
	.unwrap();

	pallet_validator_set::GenesisConfig::<Test> { initial_validators: vec![1] }
		.assimilate_storage(&mut t)
		.unwrap();

	let keys: Vec<_> = vec![1u64].into_iter().map(|i| (i, i, UintAuthorityId(i).into())).collect();
	pallet_session::GenesisConfig::<Test> { keys, ..Default::default() }
		.assimilate_storage(&mut t)
		.unwrap();

	let mut ext = sp_io::TestExternalities::new(t);
	ext.execute_with(|| System::set_block_number(1));
	ext
}
