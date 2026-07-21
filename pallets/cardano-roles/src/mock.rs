//! Test mock runtime for `pallet-cardano-roles`.
//!
//! Minimal by design: the pallet reuses the cogno-gate CIP-8 verifier as a PURE function and the
//! microblog `IsAllowed` trait, so the mock needs neither pallet instance — only `System` + the
//! pallet, plus a stand-in identity gate. The role-proof crypto is exercised end-to-end against
//! self-constructed ed25519 fixtures (see `tests.rs`).

use crate as pallet_cardano_roles;
use frame_support::{derive_impl, traits::ConstU8};
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

impl pallet_cardano_roles::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    // Root stands in for the 3-of-5 committee (the runtime wires the real FollowerCommittee); either
    // way it is an `EnsureOrigin`, so the pallet body is identical.
    type RoleAuthorityOrigin = EnsureRoot<u64>;
    type IdentityGate = MockGate;
    // Testnet (network 0) — the fixtures build network-0 synthetic enterprise addresses.
    type CardanoNetwork = ConstU8<0>;
    type WeightInfo = ();
}

/// Build a genesis storage for tests.
pub fn new_test_ext() -> sp_io::TestExternalities {
    frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap()
        .into()
}
