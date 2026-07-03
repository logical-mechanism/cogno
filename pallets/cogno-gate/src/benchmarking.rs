//! Benchmarking for `pallet-cogno-gate` (DR-05).
//!
//! `link_identity_signed` (the permissionless D1 self-proof) and `revoke` (`FollowerOrigin`-gated)
//! are benchmarked at their **worst case**: `link_identity_signed` over a REAL `MeshWallet.signData`
//! fixture so it exercises the full on-chain verify (`ed25519_verify` + 2× blake2 + the bounded
//! CBOR/address/payload parse) on top of `do_bind`'s reads/writes, and `revoke` after a prior bind
//! (so it actually removes the maps + tombstones). The `revoke` origin is taken via
//! `try_successful_origin`, correct under both `EnsureRoot` (v1 dev) and the DR-07
//! `EitherOfDiverse<EnsureRoot, k-of-t>` widen.

use super::*;
use crate::Pallet as CognoGate;
use codec::Decode;
use frame_benchmarking::v2::*;
use frame_support::sp_runtime::traits::Zero;
use frame_support::{
    traits::{ConstU32, EnsureOrigin},
    BoundedVec,
};
use frame_system::{pallet_prelude::BlockNumberFor, RawOrigin};

// A REAL `MeshWallet.signData` CIP-8 bind fixture (`app/scripts/m2-cip8-fixture.mjs`) — the same
// cross-impl vector locked in `cip8/tests.rs`. The COSE_Sign1 + COSE_Key verify against the genesis
// below for the `account` the payload commits, on network 0 (testnet). Used so the benchmark measures
// the true `ed25519_verify` + hashing + parse cost, not a stub.
const SIG_HEX: &str = "845869a3012704582073fea80d424276ad0978d4fe5310e8bc2d485f5f6bb3bf87612989f112ad5a7d67616464726573735839009493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dca166686173686564f458cc636f676e6f2d636861696e2f62696e642f76313b67656e657369733d323761663338353730616230373261326137383233326664663436616335653935376561613463343461356339326430366235363435353862666232656431363b6163636f756e743d333033356361336134626436306335356635313035626231386663373636613630333634643032323666373230666665336665333364323964363633313033343b6e6f6e63653d616261626162616261626162616261626162616261626162616261626162616258400cdf9b33e4179a29995b0d0d96fb770c58b54ed570ede16df0d32b2e904efa7687ee2efa0bbc6840ecab99a6c6e20992f1916f41e4ca6b28b4d5b103234cf00e";
const KEY_HEX: &str =
    "a401010327200621582073fea80d424276ad0978d4fe5310e8bc2d485f5f6bb3bf87612989f112ad5a7d";
const GENESIS_HEX: &str = "27af38570ab072a2a78232fdf46ac5e957eaa4c44a5c92d06b564558bfb2ed16";

/// Decode an ASCII-hex constant to bytes (benchmark setup only — the inputs are trusted constants).
fn hx(s: &str) -> alloc::vec::Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("valid hex"))
        .collect()
}

#[benchmarks]
mod benchmarks {
    use super::*;

    #[benchmark]
    fn link_identity_signed() -> Result<(), BenchmarkError> {
        // Pin BlockHash[0] to the fixture genesis so the in-call anti-cross-chain check passes.
        let genesis = <T as frame_system::Config>::Hash::decode(&mut &hx(GENESIS_HEX)[..])
            .map_err(|_| BenchmarkError::Stop("genesis decode"))?;
        frame_system::BlockHash::<T>::insert(BlockNumberFor::<T>::zero(), genesis);

        let cose_sign1: BoundedVec<u8, ConstU32<512>> = hx(SIG_HEX)
            .try_into()
            .map_err(|_| BenchmarkError::Stop("sig too long"))?;
        let cose_key: BoundedVec<u8, ConstU32<128>> = hx(KEY_HEX)
            .try_into()
            .map_err(|_| BenchmarkError::Stop("key too long"))?;
        // FEELESS + unsigned: no fee payer / no signing account — the CIP-8 proof is the authorization
        // and the bound account is the one the PROOF commits (`ensure_none`). The benchmark dispatches
        // with `RawOrigin::None`, exactly as the block author applies the bare extrinsic.
        let thread = alloc::vec![0u8; 10]; // worst case: also writes ThreadOf

        #[extrinsic_call]
        _(RawOrigin::None, cose_sign1, cose_key, Some(thread));

        // The proof's committed account is now bound (verify → genesis → do_bind all ran).
        assert_eq!(AccountOf::<T>::iter().count(), 1);
        Ok(())
    }

    #[benchmark]
    fn revoke() -> Result<(), BenchmarkError> {
        let account: T::AccountId = whitelisted_caller();
        let identity: IdentityHash = [2u8; 32];
        // Seed a binding (with a thread pointer) to revoke, via the shared bind body (no origin check).
        CognoGate::<T>::do_bind(&account, identity, Some(alloc::vec![0u8; 10]))
            .map_err(|_| BenchmarkError::Stop("do_bind setup failed"))?;
        let origin =
            T::FollowerOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;

        #[extrinsic_call]
        _(origin as T::RuntimeOrigin, account.clone());

        assert!(!PkhOf::<T>::contains_key(&account));
        Ok(())
    }

    impl_benchmark_test_suite!(CognoGate, crate::mock::new_test_ext(), crate::mock::Test);
}
