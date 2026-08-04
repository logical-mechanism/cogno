//! Test mock runtime for `pallet-cardano-roles`.
//!
//! Minimal by design: the pallet reuses the cogno-gate CIP-8 verifier as a PURE function and the
//! microblog `IsAllowed` trait, so the mock needs neither pallet instance — only `System` + the
//! pallet, plus a stand-in identity gate. The role-proof crypto is exercised end-to-end against
//! self-constructed ed25519 fixtures (see `tests.rs`).

use crate as pallet_cardano_roles;
use frame_support::{
    derive_impl,
    traits::{ConstU32, ConstU8},
};
use frame_system::EnsureRoot;
use sp_runtime::BuildStorage;

type Block = frame_system::mocking::MockBlock<Test>;

frame_support::construct_runtime!(
    pub enum Test {
        System: frame_system,
        CardanoRoles: pallet_cardano_roles,
    }
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
    type Block = Block;
}

/// Stand-in identity gate: every account is "payment-bound" except account `0` (the mock's
/// "not onboarded" sentinel), so the `NotPaymentBound` path is testable without wiring cogno-gate.
pub struct MockGate;
impl pallet_microblog::IsAllowed<u64> for MockGate {
    fn is_allowed(who: &u64) -> bool {
        *who != 0
    }
    #[cfg(feature = "runtime-benchmarks")]
    fn benchmark_set_allowed(_who: &u64) {}
}

frame_support::parameter_types! {
    /// Every account `forget_role_basis` was called for, in call order (duplicates kept — a double
    /// teardown is a real thing to be able to assert about).
    ///
    /// A RECORDING double rather than `()`, deliberately. This crate cannot see
    /// `pallet-cardano-observer`, so the observer's `LastObservedRoles` basis is invisible to every
    /// test here — and forgetting to clear it is the failure that leaves an account's badge set empty
    /// FOR EVER, because `derive_call`'s forward pass then short-circuits as unchanged. With `()` that
    /// bug is untestable in the pallet that causes it.
    pub storage ForgottenRoleBases: alloc::vec::Vec<u64> = alloc::vec::Vec::new();
}

/// Test double for the observer half of the role teardown: records rather than acts.
pub struct RecordingRoleTeardown;
impl pallet_cardano_roles::OnObservedRolesCleared<u64> for RecordingRoleTeardown {
    fn forget_role_basis(who: &u64) {
        let mut seen = ForgottenRoleBases::get();
        seen.push(*who);
        ForgottenRoleBases::set(&seen);
    }
}

impl pallet_cardano_roles::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    // Root stands in for the 3-of-5 committee (the runtime wires the real FollowerCommittee); either
    // way it is an `EnsureOrigin`, so the pallet body is identical.
    type RoleAuthorityOrigin = EnsureRoot<u64>;
    type IdentityGate = MockGate;
    // Testnet (network 0) — the fixtures build network-0 synthetic enterprise addresses.
    type CardanoNetwork = ConstU8<0>;
    // Small on purpose: the runtime uses 1024, and a mock that matched it could never reach the cap in
    // a test. The cap BEHAVIOUR is what needs covering, not its value.
    type MaxScanned = ConstU32<4>;
    type MaxBatchTargets = ConstU32<64>;
    type OnRoleTeardown = RecordingRoleTeardown;
    type WeightInfo = ();
}

/// Build a genesis storage for tests.
pub fn new_test_ext() -> sp_io::TestExternalities {
    frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap()
        .into()
}
