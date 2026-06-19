//! Test mock runtime for `pallet-cardano-observer`.
//!
//! The cross-pallet collaborators are mocked via thread-local fixtures so the pallet's pure
//! verification/application logic is testable in isolation: `MockBeacons` (cogno-gate `AccountOf`),
//! `MockSink` (the talk-stake + microblog weight/capacity adapter), and `MockTime` (the block clock).

use crate as pallet_cardano_observer;
use crate::{BeaconResolver, WeightSink};
use core::time::Duration;
use frame_support::{
	derive_impl, parameter_types,
	traits::{ConstU128, ConstU32, ConstU64, UnixTime},
};
use sp_runtime::BuildStorage;
use std::cell::RefCell;
use std::collections::BTreeMap;

type Block = frame_system::mocking::MockBlock<Test>;
pub type AccountId = u64;

frame_support::construct_runtime!(
	pub enum Test {
		System: frame_system,
		CardanoObserver: pallet_cardano_observer,
	}
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
}

thread_local! {
	static BINDINGS: RefCell<BTreeMap<[u8; 32], AccountId>> = RefCell::new(BTreeMap::new());
	static WEIGHTS: RefCell<BTreeMap<AccountId, u128>> = RefCell::new(BTreeMap::new());
	static NOW_SECS: RefCell<u64> = RefCell::new(0);
}

/// cogno-gate `AccountOf` stand-in.
pub struct MockBeacons;
impl BeaconResolver<AccountId> for MockBeacons {
	fn resolve(beacon: &[u8; 32]) -> Option<AccountId> {
		BINDINGS.with(|b| b.borrow().get(beacon).copied())
	}
}
/// Bind a beacon to an account (the cogno-gate `link_identity` fixture).
pub fn bind(beacon: [u8; 32], who: AccountId) {
	BINDINGS.with(|b| {
		b.borrow_mut().insert(beacon, who);
	});
}

/// talk-stake + microblog weight/capacity adapter stand-in — records the last weight per account.
pub struct MockSink;
impl WeightSink<AccountId> for MockSink {
	fn set_weight(who: &AccountId, weight: u128) {
		WEIGHTS.with(|w| {
			w.borrow_mut().insert(*who, weight);
		});
	}
}
/// The weight last written for `who` (0 if never written).
pub fn weight_of(who: AccountId) -> u128 {
	WEIGHTS.with(|w| w.borrow().get(&who).copied().unwrap_or(0))
}
/// Whether `set_weight` was ever called for `who` (distinguishes "skipped" from "set to 0").
pub fn was_written(who: AccountId) -> bool {
	WEIGHTS.with(|w| w.borrow().contains_key(&who))
}

/// The block clock stand-in (`pallet_timestamp` in the real runtime).
pub struct MockTime;
impl UnixTime for MockTime {
	fn now() -> Duration {
		Duration::from_secs(NOW_SECS.with(|n| *n.borrow()))
	}
}
pub fn set_now_secs(s: u64) {
	NOW_SECS.with(|n| *n.borrow_mut() = s);
}

// Mock anchor (preprod-shaped) + bounds.
pub const SHELLEY_START_UNIX: u64 = 1_655_769_600;
pub const SHELLEY_START_SLOT: u64 = 86_400;
pub const STABILITY_SLOTS: u64 = 1_000; // small for the mock
pub const MIN_LOCK: u128 = 100_000_000;
pub const MAX_STAKE_WEIGHT: u128 = 45_000_000_000_000_000;

parameter_types! {
	// A dummy 28-byte policy id for the mock (the real one is the live vault hash in the runtime).
	pub const MockVaultPolicyId: [u8; 28] = [0u8; 28];
}

impl pallet_cardano_observer::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type MaxObserved = ConstU32<64>;
	type MaxStakeWeight = ConstU128<MAX_STAKE_WEIGHT>;
	type MinLock = ConstU128<MIN_LOCK>;
	type StabilitySlots = ConstU64<STABILITY_SLOTS>;
	type ShelleyStartUnix = ConstU64<SHELLEY_START_UNIX>;
	type ShelleyStartSlot = ConstU64<SHELLEY_START_SLOT>;
	type VaultPolicyId = MockVaultPolicyId;
	type BeaconResolver = MockBeacons;
	type WeightSink = MockSink;
	// Root-only in the mock (the runtime uses the 3-of-5 AuthorityOrigin); enough to exercise the gate.
	type EnforceOrigin = frame_system::EnsureRoot<AccountId>;
	type UnixTime = MockTime;
	type WeightInfo = ();
}

/// A "now" well past the Shelley anchor (so the stability bound is active) — the corresponding Cardano
/// slot is `SHELLEY_START_SLOT + ELAPSED`, and the max legitimate reference is that minus `STABILITY_SLOTS`.
pub const ELAPSED_SECS: u64 = 1_000_000;
pub const NOW_SECS_DEFAULT: u64 = SHELLEY_START_UNIX + ELAPSED_SECS;
/// = cardano_slot(now) − STABILITY_SLOTS, the boundary the `ReferenceTooFresh` check uses.
pub const MAX_REFERENCE: u64 = SHELLEY_START_SLOT + ELAPSED_SECS - STABILITY_SLOTS;

pub fn new_test_ext() -> sp_io::TestExternalities {
	// Reset thread-local fixtures so tests don't leak state into each other.
	BINDINGS.with(|b| b.borrow_mut().clear());
	WEIGHTS.with(|w| w.borrow_mut().clear());
	set_now_secs(NOW_SECS_DEFAULT);
	frame_system::GenesisConfig::<Test>::default()
		.build_storage()
		.unwrap()
		.into()
}
