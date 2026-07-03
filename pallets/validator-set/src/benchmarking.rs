//! Benchmarking for `pallet-validator-set` (DR-05).
//!
//! `add_validator` / `remove_validator` are each one `Validators` StorageValue read + write behind
//! the gated `AddRemoveOrigin`. The origin is obtained via `try_successful_origin` so the benchmark
//! is correct whether the runtime wires `EnsureRoot` (v1 dev) or the M5 `EitherOfDiverse<EnsureRoot,
//! EnsureProportionAtLeast<FollowerCommittee, 3, 5>>`. `remove_validator` seeds `MinAuthorities + 1`
//! validators first so the removal stays above the floor (the worst case: a full retain scan).

use super::*;
#[allow(unused)]
use crate::Pallet as ValidatorSet;
use frame_benchmarking::v2::*;
use frame_support::traits::EnsureOrigin;

const SEED: u32 = 0;

#[benchmarks]
mod benchmarks {
    use super::*;

    #[benchmark]
    fn add_validator() -> Result<(), BenchmarkError> {
        let origin =
            T::AddRemoveOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;
        let validator: T::ValidatorId = account("validator", 0, SEED);

        #[extrinsic_call]
        _(origin as T::RuntimeOrigin, validator.clone());

        assert!(Validators::<T>::get().contains(&validator));
        Ok(())
    }

    #[benchmark]
    fn remove_validator() -> Result<(), BenchmarkError> {
        let origin =
            T::AddRemoveOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;
        // Seed MinAuthorities + 1 validators so removing one leaves exactly MinAuthorities (the
        // removal passes the floor check, and the retain scans the full set — the worst case).
        let min = T::MinAuthorities::get();
        let raw: Vec<T::ValidatorId> = (0..=min).map(|i| account("validator", i, SEED)).collect();
        let target = raw[0].clone();
        let validators: BoundedVec<T::ValidatorId, T::MaxValidators> = raw
            .try_into()
            .expect("MinAuthorities + 1 must be <= MaxValidators for this benchmark");
        Validators::<T>::put(validators);

        #[extrinsic_call]
        _(origin as T::RuntimeOrigin, target.clone());

        assert!(!Validators::<T>::get().contains(&target));
        Ok(())
    }

    impl_benchmark_test_suite!(ValidatorSet, crate::mock::new_test_ext(), crate::mock::Test);
}
