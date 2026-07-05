//! Unit tests for `pallet-governance-fuel`: the `GrantOrigin` gate, `set_allowance` (upsert + immediate
//! top-up + caps), `revoke` (drop allowance + claw-back/reap, idempotent), and the regeneration hook
//! (period-gated refill toward the standing allowance).

use crate::{mock::*, Allowances, Error, Event, TotalMinted, TotalRevoked};
use frame_support::{
    assert_noop, assert_ok,
    traits::{
        fungible::{Inspect, Mutate},
        tokens::{Fortitude, Precision, Preservation},
        Hooks,
    },
};
use sp_runtime::traits::BadOrigin;

const ED: u64 = 1_000;
const MAX: u64 = 1_000_000;

/// Current native balance of `who`.
fn bal(who: u64) -> u64 {
    <Balances as Inspect<u64>>::balance(&who)
}

/// Simulate `who` spending `amount` of fuel on admin fees (an Expendable best-effort burn).
fn spend(who: u64, amount: u64) {
    let _ = <Balances as Mutate<u64>>::burn_from(
        &who,
        amount,
        Preservation::Expendable,
        Precision::BestEffort,
        Fortitude::Force,
    )
    .expect("burn for test spend");
}

/// Return the stored allowance ceiling for `who`, if any.
fn allowance_of(who: u64) -> Option<u64> {
    Allowances::<Test>::get()
        .into_iter()
        .find(|(a, _)| *a == who)
        .map(|(_, m)| m)
}

// ── origin gating ────────────────────────────────────────────────────────────────────────────────

#[test]
fn set_allowance_requires_grant_origin() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            GovernanceFuel::set_allowance(RuntimeOrigin::signed(1), 2, MAX),
            BadOrigin
        );
        assert_noop!(
            GovernanceFuel::set_allowance(RuntimeOrigin::none(), 2, MAX),
            BadOrigin
        );
        // No state change on a rejected call.
        assert!(Allowances::<Test>::get().is_empty());
        assert_eq!(bal(2), 0);
        assert_eq!(TotalMinted::<Test>::get(), 0);
    });
}

#[test]
fn revoke_requires_grant_origin() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            GovernanceFuel::revoke(RuntimeOrigin::signed(1), 2),
            BadOrigin
        );
        assert_noop!(GovernanceFuel::revoke(RuntimeOrigin::none(), 2), BadOrigin);
    });
}

// ── set_allowance ────────────────────────────────────────────────────────────────────────────────

#[test]
fn set_allowance_mints_to_ceiling_and_records() {
    new_test_ext().execute_with(|| {
        assert_ok!(GovernanceFuel::set_allowance(RuntimeOrigin::root(), 2, MAX));
        assert_eq!(bal(2), MAX);
        assert_eq!(allowance_of(2), Some(MAX));
        assert_eq!(TotalMinted::<Test>::get(), MAX);
        System::assert_has_event(
            Event::AllowanceSet {
                who: 2,
                max: MAX,
                minted: MAX,
            }
            .into(),
        );
    });
}

#[test]
fn set_allowance_is_a_topup_toward_the_new_ceiling() {
    new_test_ext().execute_with(|| {
        // Start below MAX, spend (staying above ED so the account survives), then raise the ceiling —
        // the second `set_allowance` mints only the shortfall up to the new max.
        assert_ok!(GovernanceFuel::set_allowance(RuntimeOrigin::root(), 2, 500_000));
        assert_eq!(bal(2), 500_000);
        spend(2, 100_000);
        assert_eq!(bal(2), 400_000);
        assert_ok!(GovernanceFuel::set_allowance(RuntimeOrigin::root(), 2, MAX));
        assert_eq!(bal(2), MAX);
        assert_eq!(allowance_of(2), Some(MAX));
        // TotalMinted = 500_000 (first) + (MAX - 400_000) shortfall on the raise = MAX + 100_000.
        assert_eq!(TotalMinted::<Test>::get(), MAX + 100_000);
    });
}

#[test]
fn set_allowance_at_or_below_current_balance_mints_nothing() {
    new_test_ext().execute_with(|| {
        assert_ok!(GovernanceFuel::set_allowance(RuntimeOrigin::root(), 2, MAX));
        // Re-setting to the same ceiling while already at max mints 0.
        assert_ok!(GovernanceFuel::set_allowance(RuntimeOrigin::root(), 2, MAX));
        assert_eq!(bal(2), MAX);
        assert_eq!(TotalMinted::<Test>::get(), MAX);
        System::assert_has_event(
            Event::AllowanceSet {
                who: 2,
                max: MAX,
                minted: 0,
            }
            .into(),
        );
    });
}

#[test]
fn set_allowance_rejects_above_max_allowance() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            GovernanceFuel::set_allowance(RuntimeOrigin::root(), 2, MAX + 1),
            Error::<Test>::AllowanceExceedsMax
        );
        assert_eq!(bal(2), 0);
        assert!(Allowances::<Test>::get().is_empty());
    });
}

#[test]
fn set_allowance_rejects_below_existential_deposit() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            GovernanceFuel::set_allowance(RuntimeOrigin::root(), 2, ED - 1),
            Error::<Test>::AllowanceBelowExistentialDeposit
        );
        assert_eq!(bal(2), 0);
        assert!(Allowances::<Test>::get().is_empty());
    });
}

#[test]
fn set_allowance_rejects_past_the_funded_bound() {
    new_test_ext().execute_with(|| {
        // Fill the 64-entry bound with cheap ED allowances.
        for who in 0u64..64 {
            assert_ok!(GovernanceFuel::set_allowance(RuntimeOrigin::root(), who, ED));
        }
        assert_noop!(
            GovernanceFuel::set_allowance(RuntimeOrigin::root(), 64, ED),
            Error::<Test>::TooManyFundedAccounts
        );
        // The 65th account got nothing.
        assert_eq!(bal(64), 0);
    });
}

// ── revoke ───────────────────────────────────────────────────────────────────────────────────────

#[test]
fn revoke_drops_allowance_and_claws_back_and_reaps() {
    new_test_ext().execute_with(|| {
        assert_ok!(GovernanceFuel::set_allowance(RuntimeOrigin::root(), 2, MAX));
        assert_eq!(bal(2), MAX);

        assert_ok!(GovernanceFuel::revoke(RuntimeOrigin::root(), 2));
        assert_eq!(bal(2), 0, "account reaped");
        assert_eq!(allowance_of(2), None, "regeneration stopped");
        assert_eq!(TotalRevoked::<Test>::get(), MAX);
        System::assert_has_event(Event::AllowanceRevoked { who: 2, burned: MAX }.into());
    });
}

#[test]
fn revoke_is_idempotent_on_unfunded_account() {
    new_test_ext().execute_with(|| {
        assert_ok!(GovernanceFuel::revoke(RuntimeOrigin::root(), 9));
        assert_eq!(TotalRevoked::<Test>::get(), 0);
        System::assert_has_event(Event::AllowanceRevoked { who: 9, burned: 0 }.into());
    });
}

// ── regeneration hook ──────────────────────────────────────────────────────────────────────────

#[test]
fn regeneration_refills_toward_the_allowance_on_period_boundaries() {
    new_test_ext().execute_with(|| {
        assert_ok!(GovernanceFuel::set_allowance(RuntimeOrigin::root(), 2, MAX));
        spend(2, 600_000);
        assert_eq!(bal(2), MAX - 600_000);
        let minted_before = TotalMinted::<Test>::get();

        // Off-cadence block (RegenPeriod = 5): no refill.
        GovernanceFuel::on_initialize(4);
        assert_eq!(bal(2), MAX - 600_000);
        assert_eq!(TotalMinted::<Test>::get(), minted_before);

        // Cadence boundary: refilled to the ceiling.
        GovernanceFuel::on_initialize(5);
        assert_eq!(bal(2), MAX);
        assert_eq!(TotalMinted::<Test>::get(), minted_before + 600_000);
        System::assert_has_event(
            Event::FuelRegenerated {
                accounts: 1,
                minted: 600_000,
            }
            .into(),
        );
    });
}

#[test]
fn regeneration_ignores_unfunded_and_full_accounts() {
    new_test_ext().execute_with(|| {
        // Funded + already at max ⇒ nothing to mint; unfunded account ⇒ never touched.
        assert_ok!(GovernanceFuel::set_allowance(RuntimeOrigin::root(), 2, MAX));
        let minted_before = TotalMinted::<Test>::get();
        GovernanceFuel::on_initialize(10);
        assert_eq!(bal(2), MAX);
        assert_eq!(bal(3), 0, "unfunded account is never minted");
        assert_eq!(TotalMinted::<Test>::get(), minted_before);
    });
}

#[test]
fn revoked_account_stops_regenerating() {
    new_test_ext().execute_with(|| {
        assert_ok!(GovernanceFuel::set_allowance(RuntimeOrigin::root(), 2, MAX));
        assert_ok!(GovernanceFuel::revoke(RuntimeOrigin::root(), 2));
        // A period boundary must NOT re-fund a revoked account.
        GovernanceFuel::on_initialize(5);
        assert_eq!(bal(2), 0);
    });
}
