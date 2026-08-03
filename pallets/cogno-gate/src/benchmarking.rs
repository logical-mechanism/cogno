//! Benchmarking for `pallet-cogno-gate`.
//!
//! `link_identity_signed` (the permissionless self-proof) and `revoke` (`FollowerOrigin`-gated)
//! are benchmarked at their **worst case**: `link_identity_signed` over a REAL `MeshWallet.signData`
//! fixture so it exercises the full on-chain verify (`ed25519_verify` + 2× blake2 + the bounded
//! CBOR/address/payload parse) on top of `do_bind`'s reads/writes, and `revoke` after a prior bind
//! (so it actually removes the maps + tombstones). The `revoke` origin is taken via
//! `try_successful_origin`, so the benchmark is correct for whatever `EnsureOrigin` the runtime wires
//! (in production: the 3-of-5 committee).

use super::*;
use crate::Pallet as CognoGate;
use codec::Decode;
use frame_benchmarking::v2::*;
use frame_support::sp_runtime::traits::Zero;
use frame_support::{
    traits::{ConstU32, EnsureOrigin, Get},
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

/// The upper bound of `revoke_many`'s `Linear` component, and the SINGLE knob for it — the component
/// is declared `Linear<0, MAX_BATCH_TARGETS>`, not `Linear<0, 64>`, so there is no second literal to
/// forget. It MUST equal the runtime's (and the mock's) `MaxBatchTargets`; a `Linear` bound is a const
/// generic, so it can be a named const but NOT `T::MaxBatchTargets::get()`, which is why the coupling
/// has to be asserted at run time rather than checked by the compiler. `revoke_many` asserts it.
///
/// A range short of the real bound fits the per-target slope over less than the batch a committee can
/// actually propose, and the extrapolation past it is unmeasured; a range past it makes the benchmark's
/// seeding fail with a `BoundedVec` overflow.
const MAX_BATCH_TARGETS: u32 = 64;

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

        #[extrinsic_call]
        _(RawOrigin::None, cose_sign1, cose_key);

        // The proof's committed account is now bound (verify → genesis → do_bind all ran).
        assert_eq!(AccountOf::<T>::iter().count(), 1);
        Ok(())
    }

    #[benchmark]
    fn revoke() -> Result<(), BenchmarkError> {
        let account: T::AccountId = whitelisted_caller();
        let identity: IdentityHash = [2u8; 32];
        // Seed a binding to revoke, via the shared bind body (no origin check).
        CognoGate::<T>::do_bind(&account, identity)
            .map_err(|_| BenchmarkError::Stop("do_bind setup failed"))?;
        let origin =
            T::FollowerOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;

        #[extrinsic_call]
        _(origin as T::RuntimeOrigin, account.clone());

        assert!(!PkhOf::<T>::contains_key(&account));
        Ok(())
    }

    /// `n` targets that are ALL bound, each also carrying a stake bind — the worst case, because a
    /// missing target short-circuits before any write and a payment-only target skips the stake
    /// teardown. The component is bounded by [`MAX_BATCH_TARGETS`], which the body asserts equals the
    /// runtime's `MaxBatchTargets` (a `Linear` bound is a const generic, so the compiler cannot).
    #[benchmark]
    fn revoke_many(n: Linear<0, MAX_BATCH_TARGETS>) -> Result<(), BenchmarkError> {
        assert_eq!(
            T::MaxBatchTargets::get(),
            MAX_BATCH_TARGETS,
            "MaxBatchTargets changed: move benchmarking::MAX_BATCH_TARGETS (which bounds revoke_many's component) with it",
        );

        let mut targets: BoundedVec<T::AccountId, T::MaxBatchTargets> = BoundedVec::new();
        for i in 0..n {
            let account = account::<T::AccountId>("target", i, 0);
            let mut identity: IdentityHash = [0u8; 32];
            identity[..4].copy_from_slice(&i.to_be_bytes());
            CognoGate::<T>::do_bind(&account, identity)
                .map_err(|_| BenchmarkError::Stop("do_bind setup failed"))?;
            let mut stake_cred: StakeCredential = [0u8; 28];
            stake_cred[..4].copy_from_slice(&i.to_be_bytes());
            // A distinct nonce per account, so the seeding never trips the replay guard.
            let mut nonce = [0u8; 16];
            nonce[..4].copy_from_slice(&i.to_be_bytes());
            CognoGate::<T>::do_bind_stake(&account, stake_cred, nonce)
                .map_err(|_| BenchmarkError::Stop("do_bind_stake setup failed"))?;
            targets
                .try_push(account)
                .map_err(|_| BenchmarkError::Stop("n exceeds MaxBatchTargets"))?;
        }
        let origin =
            T::FollowerOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;

        #[extrinsic_call]
        _(origin as T::RuntimeOrigin, targets.clone());

        for account in targets.iter() {
            assert!(!PkhOf::<T>::contains_key(account));
        }
        Ok(())
    }

    #[benchmark]
    fn unlink_stake() -> Result<(), BenchmarkError> {
        let account: T::AccountId = whitelisted_caller();
        let identity: IdentityHash = [3u8; 32];
        CognoGate::<T>::do_bind(&account, identity)
            .map_err(|_| BenchmarkError::Stop("do_bind setup failed"))?;
        CognoGate::<T>::do_bind_stake(&account, [4u8; 28], [5u8; 16])
            .map_err(|_| BenchmarkError::Stop("do_bind_stake setup failed"))?;

        #[extrinsic_call]
        _(RawOrigin::Signed(account.clone()));

        assert!(!StakeCredOf::<T>::contains_key(&account));
        // The spent nonce SURVIVES the unlink — that is what makes the original proof single-use.
        assert!(SpentStakeNonce::<T>::contains_key(&account));
        Ok(())
    }

    #[benchmark]
    fn tombstone_stake_cred() -> Result<(), BenchmarkError> {
        let stake_cred: StakeCredential = [6u8; 28];
        let origin =
            T::FollowerOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;

        #[extrinsic_call]
        _(origin as T::RuntimeOrigin, stake_cred);

        assert!(TombstonedStakeCred::<T>::contains_key(stake_cred));
        Ok(())
    }

    impl_benchmark_test_suite!(CognoGate, crate::mock::new_test_ext(), crate::mock::Test);
}
