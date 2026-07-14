//! Test mock runtime for `pallet-cogno-gate`.
//!
//! This is the faithful **integration** mock: it wires the real `CognoGate`,
//! `Microblog`, and `TalkStake` together exactly as the runtime does (microblog's
//! `IdentityGate = CognoGate`, the gate's `OnBind = Microblog`), so the tests exercise the
//! actual `link_identity → is_allowed → post` flow, the `on_first_bind` provider/capacity
//! priming, and the 1:1 enforcement — not stubs.

use crate as pallet_cogno_gate;
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
        CognoGate: pallet_cogno_gate,
    }
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
    type Block = Block;
}

// talk-stake is a call-less observer-written ledger (just `RuntimeEvent`); tests drive `apply_weight` /
// `apply_voting_power` directly.
impl pallet_talk_stake::Config for Test {
    type RuntimeEvent = RuntimeEvent;
}

// Same small, legible capacity constants as the microblog mock.
impl pallet_microblog::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type MaxLength = ConstU32<512>;
    type MaxPostsPerAuthor = ConstU32<8>;
    type CapRatio = ConstU128<10>;
    type RegenPerBlock = ConstU128<1>;
    type Ceiling = ConstU128<5_000>;
    type BaseCost = ConstU128<100>;
    type PerByteCost = ConstU128<1>;
    type VoteCost = ConstU128<50>;
    type FollowCost = ConstU128<30>;
    type MaxPollOptions = ConstU32<4>;
    type MaxPollOptionLen = ConstU32<32>;
    type ForceOrigin = EnsureRoot<u64>;
    // The REAL gate — this is what makes the mock an integration test.
    type IdentityGate = CognoGate;
    // No foreign feeless pallets in this integration mock — meter nothing extra.
    type ForeignCost = ();
    type WeightInfo = ();
}

impl pallet_cogno_gate::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    // The mock uses Root for `FollowerOrigin`; the runtime wires the 3-of-5 committee (there is no
    // sudo on-chain). Either way it is an `EnsureOrigin`, so the pallet body is identical.
    type FollowerOrigin = EnsureRoot<u64>;
    // The first-bind hook into microblog (primes the capacity row + provider ref).
    type OnBind = Microblog;
    // Testnet (the live preprod fixtures are network 0).
    type CardanoNetwork = frame_support::traits::ConstU8<0>;
    type WeightInfo = ();
}

/// Build a genesis storage for tests.
pub fn new_test_ext() -> sp_io::TestExternalities {
    frame_system::GenesisConfig::<Test>::default()
        .build_storage()
        .unwrap()
        .into()
}

/// Test helper: drive the shared 1:1 bind body directly. The trusted `link_identity` dispatchable was
/// REMOVED in D1 — the only on-chain bind path is now the permissionless `link_identity_signed` (covered
/// by the `link_identity_signed_*` tests against the real wallet fixture). Tests that just need a
/// *pre-existing* binding (to exercise double-bind / revoke / posting) call this instead of constructing
/// a CIP-8 proof. Arg order mirrors the old `link_identity`: `(identity, account, thread)`.
pub fn bind(
    identity: crate::IdentityHash,
    account: u64,
    thread: Option<Vec<u8>>,
) -> sp_runtime::DispatchResult {
    CognoGate::do_bind(&account, identity, thread)
}

/// Test helper: drive the stake-credential bind body directly (the voting-power anchor). Mirrors
/// [`bind`] for the stake side — tests that just need a pre-existing stake binding call this instead
/// of constructing a stake-key CIP-8 proof. The account must already be payment-bound (`do_bind_stake`
/// enforces `NotPaymentBound`).
pub fn bind_stake(stake_cred: crate::StakeCredential, account: u64) -> sp_runtime::DispatchResult {
    CognoGate::do_bind_stake(&account, stake_cred)
}
