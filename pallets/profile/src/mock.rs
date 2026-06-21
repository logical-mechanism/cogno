//! Test mock runtime for `pallet-profile`.
//!
//! The pallet only needs `frame_system` + its own identity-gate trait. The gate is satisfied by a
//! local [`MockIdentityGate`] (allow-all-but-denied), so the Microblog pallet itself is NOT wired
//! into the mock — only the `IsAllowed` trait it defines.

use crate as pallet_profile;
use core::cell::RefCell;
use frame_support::{derive_impl, traits::ConstU32};
use sp_runtime::BuildStorage;

type Block = frame_system::mocking::MockBlock<Test>;

thread_local! {
	/// Accounts explicitly denied by the mock identity gate. Empty ⇒ allow all.
	static GATE_DENIED: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
}

/// Mock identity gate: allows everyone except accounts passed to [`deny_identity`].
pub struct MockIdentityGate;
impl pallet_microblog::IsAllowed<u64> for MockIdentityGate {
	fn is_allowed(who: &u64) -> bool {
		GATE_DENIED.with(|d| !d.borrow().contains(who))
	}

	#[cfg(feature = "runtime-benchmarks")]
	fn benchmark_set_allowed(_who: &u64) {}
}

/// Deny `who` at the mock identity gate (to exercise the `NotAllowed` path).
pub fn deny_identity(who: u64) {
	GATE_DENIED.with(|d| d.borrow_mut().push(who));
}

frame_support::construct_runtime!(
	pub enum Test {
		System: frame_system,
		Profile: pallet_profile,
	}
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
}

impl pallet_profile::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type IdentityGate = MockIdentityGate;
	type MaxName = ConstU32<64>;
	type MaxBio = ConstU32<256>;
	type MaxAvatar = ConstU32<128>;
	type WeightInfo = ();
}

/// Build a genesis storage for tests.
pub fn new_test_ext() -> sp_io::TestExternalities {
	GATE_DENIED.with(|d| d.borrow_mut().clear());
	frame_system::GenesisConfig::<Test>::default()
		.build_storage()
		.unwrap()
		.into()
}
