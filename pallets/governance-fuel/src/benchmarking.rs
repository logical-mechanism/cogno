//! Benchmarking for `pallet-governance-fuel`.
//!
//! `set_allowance` / `revoke` are each a small bounded-list mutate + one `mint_into` / `burn_from`
//! behind the gated `GrantOrigin` (obtained via `try_successful_origin`, so the bench is correct whether
//! the runtime wires the 3-of-5 committee or the mock wires `EnsureRoot`). `regenerate` is linear in the
//! number of funded accounts — seeded to the worst case (every account drained, needing a full top-up).
//! The `Linear` upper bound (64) matches the runtime `MaxFundedAccounts`; the mock sets the same bound.

use super::*;
use crate::Pallet as GovernanceFuel;
use frame_benchmarking::v2::*;
use frame_support::traits::{
    fungible::{Inspect, Mutate},
    EnsureOrigin, Get,
};
use sp_runtime::traits::Zero;

const SEED: u32 = 0;

#[benchmarks]
mod benchmarks {
    use super::*;

    #[benchmark]
    fn set_allowance() -> Result<(), BenchmarkError> {
        let origin =
            T::GrantOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;
        let who: T::AccountId = account("grantee", 0, SEED);
        let max = T::MaxAllowance::get();

        #[extrinsic_call]
        _(origin as T::RuntimeOrigin, who.clone(), max);

        assert_eq!(T::Currency::balance(&who), max);
        Ok(())
    }

    #[benchmark]
    fn revoke() -> Result<(), BenchmarkError> {
        let origin =
            T::GrantOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;
        let who: T::AccountId = account("grantee", 0, SEED);
        // Worst case: a funded account with a full balance + a standing allowance to drop.
        T::Currency::mint_into(&who, T::MaxAllowance::get())?;
        Allowances::<T>::try_mutate(|list| list.try_push((who.clone(), T::MaxAllowance::get())))
            .map_err(|_| BenchmarkError::Stop("allowance list push failed"))?;

        #[extrinsic_call]
        _(origin as T::RuntimeOrigin, who.clone());

        assert!(T::Currency::total_balance(&who).is_zero());
        Ok(())
    }

    // ⚠ The Linear upper bound MUST equal the runtime `MaxFundedAccounts` (currently ConstU32<64>) and the
    // mock's bound — a `Linear` needs a literal, so this can't reference `T::MaxFundedAccounts::get()`. If
    // you raise `MaxFundedAccounts`, raise this 64 too, or the generated `regenerate` weight will
    // under-cover the real (Mandatory) on_initialize loop for the accounts above 64.
    #[benchmark]
    fn regenerate(n: Linear<0, 64>) -> Result<(), BenchmarkError> {
        // Seed n funded accounts, each with a full allowance but ZERO balance — the worst case where
        // every one needs a full top-up mint this tick.
        for i in 0..n {
            let who: T::AccountId = account("grantee", i, SEED);
            Allowances::<T>::try_mutate(|list| list.try_push((who, T::MaxAllowance::get())))
                .map_err(|_| BenchmarkError::Stop("allowance list push failed"))?;
        }

        #[block]
        {
            GovernanceFuel::<T>::do_regenerate();
        }

        Ok(())
    }

    impl_benchmark_test_suite!(
        GovernanceFuel,
        crate::mock::new_test_ext(),
        crate::mock::Test
    );
}
