//! Unit tests for `pallet-cardano-observer` — the inherent verification semantics + the Mandatory
//! `observe` dispatchable (monotonicity, stability bound, MaxStakeWeight skip, account resolution,
//! weight application, unlock clamp).

use crate::mock::*;
use crate::{
    BeaconName, CardanoObservation, CardanoRef, Error, Event, InherentError, RoleEntry, RoleSource,
    INHERENT_IDENTIFIER,
};
use frame_support::{
    assert_noop, assert_ok,
    inherent::{InherentData, IsFatalError, ProvideInherent},
    traits::OnInitialize,
    BoundedVec,
};

const ALICE: AccountId = 1;
const BOB: AccountId = 2;
const A: BeaconName = [0xAA; 32];
const B: BeaconName = [0xBB; 32];
const S1: crate::StakeCredential = [0xC1; 28];
const S2: crate::StakeCredential = [0xC2; 28];

/// A placeholder input commitment for the application/dispatchable tests. The commitment is only
/// load-bearing in `check_inherent` (the Mandatory dispatchable carries-but-ignores it), exercised by
/// the dedicated taxonomy tests below with `COMMIT` vs `COMMIT2`.
const COMMIT: [u8; 32] = [0u8; 32];
/// A DIFFERENT input commitment — "the importer saw different raw Cardano data".
const COMMIT2: [u8; 32] = [0x99u8; 32];

fn cref(slot: u64) -> CardanoRef {
    CardanoRef {
        slot,
        block_hash: [0u8; 32],
    }
}

fn entries(
    items: &[(BeaconName, u128)],
) -> BoundedVec<(BeaconName, u128), <Test as crate::Config>::MaxObserved> {
    BoundedVec::try_from(items.to_vec()).expect("within MaxObserved")
}

fn stk(
    items: &[(crate::StakeCredential, u128)],
) -> BoundedVec<(crate::StakeCredential, u128), <Test as crate::Config>::MaxObserved> {
    BoundedVec::try_from(items.to_vec()).expect("within MaxObserved")
}
fn no_stake() -> BoundedVec<(crate::StakeCredential, u128), <Test as crate::Config>::MaxObserved> {
    BoundedVec::new()
}
fn no_roles() -> BoundedVec<crate::RoleEntry, <Test as crate::Config>::MaxObserved> {
    BoundedVec::new()
}

fn put_obs(id: &mut InherentData, obs: &CardanoObservation) {
    id.put_data(INHERENT_IDENTIFIER, obs)
        .expect("encode observation");
}

/// Enforce mode is the DEFAULT (`EnforceWeight` defaults to `true`), so this is now a no-op made explicit
/// for the application tests — they assert on the `WeightSink`. Kept as a marker of intent.
fn enforce() {
    assert_ok!(CardanoObserver::set_enforcement(
        RuntimeOrigin::root(),
        true
    ));
}
/// FREEZE weight (the emergency-revert state): the read is still verified, but no weight is applied.
fn freeze() {
    assert_ok!(CardanoObserver::set_enforcement(
        RuntimeOrigin::root(),
        false
    ));
}

// ── ProvideInherent (create_inherent / check_inherent) ─────────────────────────────────────────────

#[test]
fn create_inherent_builds_the_observe_call_from_node_data() {
    new_test_ext().execute_with(|| {
        let obs = CardanoObservation {
            reference: cref(1000),
            inputs_commitment: COMMIT2,
            entries: vec![(A, 200_000_000), (B, 300_000_000)],
            stake_entries: vec![(S1, 700_000_000)],
            role_entries: vec![],
        };
        let mut id = InherentData::new();
        put_obs(&mut id, &obs);
        let call =
            <CardanoObserver as ProvideInherent>::create_inherent(&id).expect("inherent produced");
        match call {
            crate::Call::observe {
                reference,
                inputs_commitment,
                entries,
                stake_entries,
                role_entries: _,
            } => {
                assert_eq!(reference, cref(1000));
                assert_eq!(
                    inputs_commitment, COMMIT2,
                    "the node's input commitment is carried into the call"
                );
                assert_eq!(entries.to_vec(), vec![(A, 200_000_000), (B, 300_000_000)]);
                assert_eq!(
                    stake_entries.to_vec(),
                    vec![(S1, 700_000_000)],
                    "stake entries are carried into the call too"
                );
            }
            _ => panic!("expected observe call"),
        }
    });
}

#[test]
fn create_inherent_absent_data_is_none() {
    new_test_ext().execute_with(|| {
        // No data under our identifier ⇒ no inherent this block (legal; is_inherent_required = Ok(None)).
        let id = InherentData::new();
        assert!(<CardanoObserver as ProvideInherent>::create_inherent(&id).is_none());
    });
}

#[test]
fn check_inherent_matches_local_read() {
    new_test_ext().execute_with(|| {
        let obs = CardanoObservation {
            reference: cref(1000),
            inputs_commitment: COMMIT,
            entries: vec![(A, 200_000_000)],
            stake_entries: vec![],
            role_entries: vec![],
        };
        let mut id = InherentData::new();
        put_obs(&mut id, &obs);
        let call = crate::Call::<Test>::observe {
            reference: cref(1000),
            inputs_commitment: COMMIT,
            entries: entries(&[(A, 200_000_000)]),
            stake_entries: no_stake(),
            role_entries: no_roles(),
        };
        assert!(<CardanoObserver as ProvideInherent>::check_inherent(&call, &id).is_ok());
    });
}

#[test]
fn check_inherent_mismatch_is_fatal() {
    new_test_ext().execute_with(|| {
        // The importer's own read differs from the author's claim AND the input commitments differ (the
        // author saw DIFFERENT Cardano data) ⇒ Mismatch (FATAL → block rejected).
        let local = CardanoObservation {
            reference: cref(1000),
            inputs_commitment: COMMIT,
            entries: vec![(A, 200_000_000)],
            stake_entries: vec![],
            role_entries: vec![],
        };
        let mut id = InherentData::new();
        put_obs(&mut id, &local);
        let lying_call = crate::Call::<Test>::observe {
            reference: cref(1000),
            inputs_commitment: COMMIT2,
            entries: entries(&[(A, 999_000_000)]),
            stake_entries: no_stake(),
            role_entries: no_roles(),
        };
        let err =
            <CardanoObserver as ProvideInherent>::check_inherent(&lying_call, &id).unwrap_err();
        assert!(matches!(err, InherentError::Mismatch));
        assert!(
            err.is_fatal_error(),
            "Mismatch must be fatal (reject the block)"
        );

        // A differing reference is also a mismatch (regardless of the commitment — the reference is a pure
        // function of the parent, so a differing slot is always a data disagreement).
        let wrong_ref = crate::Call::<Test>::observe {
            reference: cref(1001),
            inputs_commitment: COMMIT,
            entries: entries(&[(A, 200_000_000)]),
            stake_entries: no_stake(),
            role_entries: no_roles(),
        };
        assert!(matches!(
            <CardanoObserver as ProvideInherent>::check_inherent(&wrong_ref, &id).unwrap_err(),
            InherentError::Mismatch
        ));
    });
}

#[test]
fn check_inherent_compute_diverged_when_same_inputs_different_output() {
    new_test_ext().execute_with(|| {
        // SAME reference + SAME input commitment (both nodes agreed on the raw Cardano candidate set) but
        // DIFFERENT reduced entries ⇒ ComputeDiverged: the reduction itself diverged (a determinism bug /
        // binary version skew), NOT a data disagreement. FATAL but reported distinctly from Mismatch.
        let local = CardanoObservation {
            reference: cref(1000),
            inputs_commitment: COMMIT,
            entries: vec![(A, 200_000_000)],
            stake_entries: vec![],
            role_entries: vec![],
        };
        let mut id = InherentData::new();
        put_obs(&mut id, &local);
        let diverged_call = crate::Call::<Test>::observe {
            reference: cref(1000),
            inputs_commitment: COMMIT,
            entries: entries(&[(A, 999_000_000)]),
            stake_entries: no_stake(),
            role_entries: no_roles(),
        };
        let err =
            <CardanoObserver as ProvideInherent>::check_inherent(&diverged_call, &id).unwrap_err();
        assert!(
            matches!(err, InherentError::ComputeDiverged),
            "same inputs, different output ⇒ ComputeDiverged"
        );
        assert!(
            err.is_fatal_error(),
            "ComputeDiverged must be fatal (a divergent reduction must not be consensus-pinned)"
        );
    });
}

#[test]
fn check_inherent_accepts_when_entries_agree_despite_commitment_diff() {
    new_test_ext().execute_with(|| {
        // The reduced OUTPUTS agree (same reference + same entries) but the input commitments DIFFER — e.g.
        // two honest nodes whose raw candidate sets differ only in UTxOs the reduction drops (too-fresh /
        // spent). The commitment must NEVER reject on its own: outputs agree ⇒ accept.
        let local = CardanoObservation {
            reference: cref(1000),
            inputs_commitment: COMMIT,
            entries: vec![(A, 200_000_000)],
            stake_entries: vec![],
            role_entries: vec![],
        };
        let mut id = InherentData::new();
        put_obs(&mut id, &local);
        let call = crate::Call::<Test>::observe {
            reference: cref(1000),
            inputs_commitment: COMMIT2,
            entries: entries(&[(A, 200_000_000)]),
            stake_entries: no_stake(),
            role_entries: no_roles(),
        };
        assert!(
            <CardanoObserver as ProvideInherent>::check_inherent(&call, &id).is_ok(),
            "agreeing entries must be accepted even when the input commitments differ",
        );
    });
}

#[test]
fn check_inherent_rejects_a_forged_sealed_block_hash_anchor() {
    new_test_ext().execute_with(|| {
        // `block_hash` is the SEALED stable-block
        // anchor (the latest stable Cardano block ≤ the reference), re-validated cross-node — NOT the old
        // node-local tip diagnostic. The importer agrees on the SLOT, the entries, and the input commitment
        // but the author sealed a DIFFERENT block_hash (a forged / regressing / wrong stable block). A
        // caught-up importer (which HAS a local read) must FATALLY reject this as a Mismatch — the header-
        // sealed anchor is importer-re-validated. (A BEHIND importer never reaches here: its IDP abstains →
        // CannotVerify, see `check_inherent_cannot_verify_when_local_source_behind_is_non_fatal`.)
        let local = CardanoObservation {
            reference: CardanoRef {
                slot: 1000,
                block_hash: [0x11; 32],
            },
            inputs_commitment: COMMIT,
            entries: vec![(A, 200_000_000)],
            stake_entries: vec![],
            role_entries: vec![],
        };
        let mut id = InherentData::new();
        put_obs(&mut id, &local);
        let forged = crate::Call::<Test>::observe {
            reference: CardanoRef {
                slot: 1000,
                block_hash: [0x22; 32],
            }, // forged anchor, same slot + entries
            inputs_commitment: COMMIT,
            entries: entries(&[(A, 200_000_000)]),
            stake_entries: no_stake(),
            role_entries: no_roles(),
        };
        let err = <CardanoObserver as ProvideInherent>::check_inherent(&forged, &id).unwrap_err();
        assert!(
			matches!(err, InherentError::Mismatch),
			"a forged sealed block_hash anchor (differing from the importer's stable block) ⇒ Mismatch",
		);
        assert!(
            err.is_fatal_error(),
            "a forged anchor must be fatal (reject the block)"
        );

        // The matching anchor (same slot + block_hash + entries) is still accepted.
        let honest = crate::Call::<Test>::observe {
            reference: CardanoRef {
                slot: 1000,
                block_hash: [0x11; 32],
            },
            inputs_commitment: COMMIT,
            entries: entries(&[(A, 200_000_000)]),
            stake_entries: no_stake(),
            role_entries: no_roles(),
        };
        assert!(<CardanoObserver as ProvideInherent>::check_inherent(&honest, &id).is_ok());
    });
}

#[test]
fn check_inherent_cannot_verify_when_local_source_behind_is_non_fatal() {
    new_test_ext().execute_with(|| {
        // The importer has NO local observation (its Cardano source is behind/down) ⇒ CannotVerify,
        // NON-FATAL: accept without verifying (never fork because YOUR follower lags).
        let id = InherentData::new(); // no data
        let call = crate::Call::<Test>::observe {
            reference: cref(1000),
            inputs_commitment: COMMIT,
            entries: entries(&[(A, 200_000_000)]),
            stake_entries: no_stake(),
            role_entries: no_roles(),
        };
        let err = <CardanoObserver as ProvideInherent>::check_inherent(&call, &id).unwrap_err();
        assert!(matches!(err, InherentError::CannotVerify));
        assert!(
            !err.is_fatal_error(),
            "CannotVerify must be NON-fatal (accept, don't fork on a slow node)"
        );
    });
}

#[test]
fn observe_call_is_recognised_as_an_inherent() {
    let call = crate::Call::<Test>::observe {
        reference: cref(1),
        inputs_commitment: COMMIT,
        entries: entries(&[]),
        stake_entries: no_stake(),
        role_entries: no_roles(),
    };
    assert!(<CardanoObserver as ProvideInherent>::is_inherent(&call));
}

// ── the Mandatory observe dispatchable (ENFORCE mode — weight is applied) ───────────────────────────

#[test]
fn observe_applies_weight_to_bound_accounts_and_skips_unbound() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind(A, ALICE); // B is observed but NOT bound

        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 1),
            COMMIT,
            entries(&[(A, 200_000_000), (B, 500_000_000)]),
            no_stake(),
            no_roles(),
        ));
        assert_eq!(
            weight_of(ALICE),
            200_000_000,
            "bound A credited at its lovelace"
        );
        assert!(
            !was_written(BOB),
            "unbound B is skipped (bind precedes weight)"
        );
        System::assert_has_event(
            Event::ObservationApplied {
                reference_slot: MAX_REFERENCE - 1,
                credited: 1,
                cleared: 0,
                skipped: 0,
                enforced: true,
            }
            .into(),
        );
    });
}

#[test]
fn observe_applies_min_lock_floor() {
    new_test_ext().execute_with(|| {
        enforce();
        bind(A, ALICE);
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 1),
            COMMIT,
            entries(&[(A, MIN_LOCK - 1)]),
            no_stake(),
            no_roles(),
        ));
        assert_eq!(weight_of(ALICE), 0, "below MIN_LOCK ⇒ weight 0");
    });
}

#[test]
fn observe_skips_over_max_stake_weight_without_bricking_the_block() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind(A, ALICE);
        bind(B, BOB);
        // A is fine; B is absurdly large (> MaxStakeWeight) ⇒ B is SKIPPED, the call still succeeds and
        // the skip is COUNTED in the event (so it can't be silently mis-read as agreement).
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 1),
            COMMIT,
            entries(&[(A, 200_000_000), (B, MAX_STAKE_WEIGHT + 1)]),
            no_stake(),
            no_roles(),
        ));
        assert_eq!(weight_of(ALICE), 200_000_000, "A still credited");
        assert!(
            !was_written(BOB),
            "the over-cap entry is skipped, not consensus-pinned (block not bricked)"
        );
        System::assert_has_event(
            Event::ObservationApplied {
                reference_slot: MAX_REFERENCE - 1,
                credited: 1,
                cleared: 0,
                skipped: 1,
                enforced: true,
            }
            .into(),
        );
    });
}

#[test]
fn observe_clamps_accounts_that_dropped_out_to_zero() {
    new_test_ext().execute_with(|| {
        enforce();
        bind(A, ALICE);
        bind(B, BOB);
        // Block 1: both A and B locked.
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 10),
            COMMIT,
            entries(&[(A, 200_000_000), (B, 300_000_000)]),
            no_stake(),
            no_roles(),
        ));
        assert_eq!(weight_of(ALICE), 200_000_000);
        assert_eq!(weight_of(BOB), 300_000_000);
        // Block 2: B unlocked (absent now) ⇒ clamped to 0; A persists.
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 5),
            COMMIT,
            entries(&[(A, 200_000_000)]),
            no_stake(),
            no_roles(),
        ));
        assert_eq!(weight_of(ALICE), 200_000_000, "A persists");
        assert_eq!(
            weight_of(BOB),
            0,
            "B (absent now) is clamped to 0 — the unlock path"
        );
    });
}

// ── FROZEN mode (the emergency revert, `set_enforcement(false)`) — verify but DO NOT touch weight ────

#[test]
fn frozen_mode_verifies_but_never_writes_weight() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        freeze(); // emergency revert: default is enforce, so flip it OFF for this test
        bind(A, ALICE);
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 1),
            COMMIT,
            entries(&[(A, 200_000_000)]),
            no_stake(),
            no_roles(),
        ));
        // The WeightSink (talk-stake/microblog) is NEVER called while frozen — weight holds at its last value.
        assert!(
            !was_written(ALICE),
            "frozen mode must NOT apply weight (the read is still verified)"
        );
        // The observation is still processed (counters + event), just not applied.
        System::assert_has_event(
            Event::ObservationApplied {
                reference_slot: MAX_REFERENCE - 1,
                credited: 1,
                cleared: 0,
                skipped: 0,
                enforced: false,
            }
            .into(),
        );
    });
}

#[test]
fn frozen_mode_clamp_still_writes_nothing() {
    new_test_ext().execute_with(|| {
        freeze();
        bind(A, ALICE);
        bind(B, BOB);
        // Both observed while frozen — weight untouched.
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 10),
            COMMIT,
            entries(&[(A, 200_000_000), (B, 300_000_000)]),
            no_stake(),
            no_roles(),
        ));
        assert!(!was_written(BOB));
        // B drops out: the clamp path runs (counter tracked) but the WeightSink is STILL never called.
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 5),
            COMMIT,
            entries(&[(A, 200_000_000)]),
            no_stake(),
            no_roles(),
        ));
        assert!(!was_written(BOB), "no AllowedStake write while frozen");
    });
}

#[test]
fn re_enable_clamps_an_account_that_unlocked_during_a_freeze() {
    // Regression: the clamp basis (`LastObserved`) must be HELD, not advanced, while frozen — otherwise an
    // account that unlocks DURING the freeze is evicted from the basis before it is ever zeroed and stays
    // stale-positive forever after re-enable (posting weight with no backing locked ADA).
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind(A, ALICE);
        bind(B, BOB);
        // Block 1 (enforcing): both A and B locked and credited.
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 20),
            COMMIT,
            entries(&[(A, 200_000_000), (B, 300_000_000)]),
            no_stake(),
            no_roles(),
        ));
        assert_eq!(weight_of(BOB), 300_000_000);

        // Emergency freeze, then B unlocks DURING the freeze (absent from the observation).
        freeze();
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 15),
            COMMIT,
            entries(&[(A, 200_000_000)]),
            no_stake(),
            no_roles(),
        ));
        assert_eq!(
            weight_of(BOB),
            300_000_000,
            "frozen: B's weight is held at its last value (not yet zeroed)"
        );

        // Re-enable: B is still absent. The held basis must still contain B, so it is clamped to 0 now.
        enforce();
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 10),
            COMMIT,
            entries(&[(A, 200_000_000)]),
            no_stake(),
            no_roles(),
        ));
        assert_eq!(
            weight_of(ALICE),
            200_000_000,
            "A persists across the freeze"
        );
        assert_eq!(
            weight_of(BOB),
            0,
            "B, which unlocked mid-freeze, is clamped on re-enable — not stranded stale-positive"
        );
    });
}

#[test]
fn re_enable_clamps_a_stake_cred_that_dropped_out_during_a_freeze() {
    // The voting-power analog of the vault regression above: `LastObservedStake` must be held while frozen.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind_stake(S1, ALICE);
        bind_stake(S2, BOB);
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 20),
            COMMIT,
            entries(&[]),
            stk(&[(S1, 800_000_000), (S2, 300_000_000)]),
            no_roles(),
        ));
        assert_eq!(voting_power_of(BOB), 300_000_000);

        freeze();
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 15),
            COMMIT,
            entries(&[]),
            stk(&[(S1, 800_000_000)]),
            no_roles(),
        ));
        assert_eq!(
            voting_power_of(BOB),
            300_000_000,
            "frozen: BOB's voting power is held"
        );

        enforce();
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 10),
            COMMIT,
            entries(&[]),
            stk(&[(S1, 800_000_000)]),
            no_roles(),
        ));
        assert_eq!(
            voting_power_of(BOB),
            0,
            "the stake cred that unbound mid-freeze is clamped on re-enable"
        );
    });
}

// ── the enforce flag setter ───────────────────────────────────────────────────────────────────────

#[test]
fn set_enforcement_is_gated_by_the_enforce_origin() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // The flag DEFAULTS to true (enforce is the normal state; the observer is the sole writer).
        assert!(
            crate::EnforceWeight::<Test>::get(),
            "EnforceWeight defaults to true"
        );
        // A signed (non-root) caller cannot flip it (EnforceOrigin = EnsureRoot in the mock).
        assert!(CardanoObserver::set_enforcement(RuntimeOrigin::signed(ALICE), false).is_err());
        assert!(
            crate::EnforceWeight::<Test>::get(),
            "flag unchanged after a rejected call"
        );
        // Root can FREEZE it (the emergency revert)…
        assert_ok!(CardanoObserver::set_enforcement(
            RuntimeOrigin::root(),
            false
        ));
        assert!(!crate::EnforceWeight::<Test>::get(), "root froze weight");
        System::assert_last_event(Event::EnforcementSet { enabled: false }.into());
        // …and re-enable.
        assert_ok!(CardanoObserver::set_enforcement(
            RuntimeOrigin::root(),
            true
        ));
        assert!(crate::EnforceWeight::<Test>::get());
    });
}

#[test]
fn set_enforcement_is_not_an_inherent() {
    // Only `observe` may be an inherent (the mutual-exclusion invariant) — the setter is a normal,
    // pool-admissible governance call and must NOT be discriminated as an inherent.
    let call = crate::Call::<Test>::set_enforcement { enabled: true };
    assert!(!<CardanoObserver as ProvideInherent>::is_inherent(&call));
}

#[test]
fn observe_rejects_a_regressing_reference() {
    new_test_ext().execute_with(|| {
        bind(A, ALICE);
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 5),
            COMMIT,
            entries(&[(A, 200_000_000)]),
            no_stake(),
            no_roles(),
        ));
        // A later block proposing an OLDER reference than the chain already holds is rejected.
        assert_noop!(
            CardanoObserver::observe(
                RuntimeOrigin::none(),
                cref(MAX_REFERENCE - 6),
                COMMIT,
                entries(&[(A, 200_000_000)]),
                no_stake(),
                no_roles(),
            ),
            Error::<Test>::ReferenceRegressed
        );
    });
}

#[test]
fn observe_rejects_a_too_fresh_reference() {
    new_test_ext().execute_with(|| {
        bind(A, ALICE);
        // A reference fresher than the stability window allows (closer to `now` than STABILITY_SLOTS).
        assert_noop!(
            CardanoObserver::observe(
                RuntimeOrigin::none(),
                cref(MAX_REFERENCE + 1),
                COMMIT,
                entries(&[(A, 200_000_000)]),
                no_stake(),
                no_roles(),
            ),
            Error::<Test>::ReferenceTooFresh
        );
        // Exactly at the boundary is allowed.
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE),
            COMMIT,
            entries(&[(A, 200_000_000)]),
            no_stake(),
            no_roles(),
        ));
    });
}

#[test]
fn observe_requires_the_none_origin() {
    new_test_ext().execute_with(|| {
        // An inherent must be dispatched with the None origin — a signed caller is rejected (it also
        // can never reach the pool, since is_inherent is true; this is defence-in-depth).
        assert!(CardanoObserver::observe(
            RuntimeOrigin::signed(ALICE),
            cref(MAX_REFERENCE - 1),
            COMMIT,
            entries(&[(A, 200_000_000)]),
            no_stake(),
            no_roles(),
        )
        .is_err());
    });
}

// ── VOTING POWER (epoch_stake) projection — the trustless voting weight ──────────────────────────────

#[test]
fn observe_applies_voting_power_to_bound_stake_creds_and_skips_unbound() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind_stake(S1, ALICE); // S2 is observed but NOT stake-bound
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 1),
            COMMIT,
            entries(&[]),
            stk(&[(S1, 800_000_000), (S2, 999_000_000)]),
            no_roles(),
        ));
        // No MIN_LOCK floor: the full observed stake is the voting power.
        assert_eq!(
            voting_power_of(ALICE),
            800_000_000,
            "bound S1 → ALICE's voting power = its total stake"
        );
        assert!(
            !vp_was_written(BOB),
            "unbound S2 is skipped (bind precedes voting power)"
        );
        System::assert_has_event(
            Event::VotingPowerObserved {
                reference_slot: MAX_REFERENCE - 1,
                credited: 1,
                cleared: 0,
                skipped: 0,
                enforced: true,
            }
            .into(),
        );
    });
}

#[test]
fn observe_skips_voting_power_over_max_without_bricking_the_block() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind_stake(S1, ALICE);
        bind_stake(S2, BOB);
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 1),
            COMMIT,
            entries(&[]),
            stk(&[(S1, 800_000_000), (S2, MAX_STAKE_WEIGHT + 1)]),
            no_roles(),
        ));
        assert_eq!(voting_power_of(ALICE), 800_000_000);
        assert!(
            !vp_was_written(BOB),
            "the over-cap stake is skipped (not consensus-pinned, block not bricked)"
        );
        System::assert_has_event(
            Event::VotingPowerObserved {
                reference_slot: MAX_REFERENCE - 1,
                credited: 1,
                cleared: 0,
                skipped: 1,
                enforced: true,
            }
            .into(),
        );
    });
}

#[test]
fn observe_clamps_dropped_stake_creds_to_zero() {
    new_test_ext().execute_with(|| {
        enforce();
        bind_stake(S1, ALICE);
        bind_stake(S2, BOB);
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 10),
            COMMIT,
            entries(&[]),
            stk(&[(S1, 800_000_000), (S2, 300_000_000)]),
            no_roles(),
        ));
        assert_eq!(voting_power_of(ALICE), 800_000_000);
        assert_eq!(voting_power_of(BOB), 300_000_000);
        // S2 drops out (its owner re-delegated / withdrew) ⇒ clamped to 0; S1 persists.
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 5),
            COMMIT,
            entries(&[]),
            stk(&[(S1, 800_000_000)]),
            no_roles(),
        ));
        assert_eq!(voting_power_of(ALICE), 800_000_000, "S1 persists");
        assert_eq!(
            voting_power_of(BOB),
            0,
            "the dropped stake credential is clamped to 0"
        );
    });
}

#[test]
fn frozen_mode_verifies_voting_power_but_never_writes_it() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        freeze(); // emergency revert
        bind_stake(S1, ALICE);
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 1),
            COMMIT,
            entries(&[]),
            stk(&[(S1, 800_000_000)]),
            no_roles(),
        ));
        assert!(
            !vp_was_written(ALICE),
            "frozen mode must NOT apply voting power"
        );
        System::assert_has_event(
            Event::VotingPowerObserved {
                reference_slot: MAX_REFERENCE - 1,
                credited: 1,
                cleared: 0,
                skipped: 0,
                enforced: false,
            }
            .into(),
        );
    });
}

#[test]
fn check_inherent_rejects_differing_stake_entries_as_mismatch() {
    new_test_ext().execute_with(|| {
        // Same reference + same vault entries + same commitment, but the author's stake_entries differ from
        // the importer's epoch_stake read ⇒ a data Mismatch (a DIRECT read has no reduction to diverge).
        let local = CardanoObservation {
            reference: cref(1000),
            inputs_commitment: COMMIT,
            entries: vec![(A, 200_000_000)],
            stake_entries: vec![(S1, 800_000_000)],
            role_entries: vec![],
        };
        let mut id = InherentData::new();
        put_obs(&mut id, &local);
        let lying = crate::Call::<Test>::observe {
            reference: cref(1000),
            inputs_commitment: COMMIT,
            entries: entries(&[(A, 200_000_000)]),
            stake_entries: stk(&[(S1, 999_000_000)]), // different stake read
            role_entries: no_roles(),
        };
        let err = <CardanoObserver as ProvideInherent>::check_inherent(&lying, &id).unwrap_err();
        assert!(
            matches!(err, InherentError::Mismatch),
            "a differing epoch_stake read is a data Mismatch, not ComputeDiverged"
        );
        assert!(err.is_fatal_error());

        // Identical stake_entries (and vault) ⇒ accepted.
        let honest = crate::Call::<Test>::observe {
            reference: cref(1000),
            inputs_commitment: COMMIT,
            entries: entries(&[(A, 200_000_000)]),
            stake_entries: stk(&[(S1, 800_000_000)]),
            role_entries: no_roles(),
        };
        assert!(<CardanoObserver as ProvideInherent>::check_inherent(&honest, &id).is_ok());
    });
}

// ── the on-chain stall alarm (`Stalled` / `LastAppliedAt`) ──────────────────────────────────────────
//
// An observation over `MaxObserved` makes `create_inherent` abstain: the whole inherent drops, the sole
// weight writer freezes chain-wide, and before this alarm the only evidence was a node-side log line. These
// pin the latch's contract — it fires ONCE, it does not fire while observations land, and an upgraded
// chain's history is not read as one long stall.

/// Run `on_initialize` for every block up to `to`, as `Executive` does — before that block's inherents.
fn roll_to(to: u64) {
    let mut n = System::block_number();
    while n < to {
        n += 1;
        System::set_block_number(n);
        CardanoObserver::on_initialize(n);
    }
}

fn stalled_events() -> usize {
    System::events()
        .iter()
        .filter(|r| {
            matches!(
                r.event,
                RuntimeEvent::CardanoObserver(Event::ObservationStalled { .. })
            )
        })
        .count()
}

/// A well-formed observation of a single bound identity, applied at the current block.
fn observe_once(slot: u64) {
    assert_ok!(CardanoObserver::observe(
        RuntimeOrigin::none(),
        cref(slot),
        COMMIT,
        entries(&[(A, 200_000_000)]),
        no_stake(),
        no_roles(),
    ));
}

#[test]
fn stall_alarm_latches_exactly_once_and_clears_on_the_next_observation() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        bind(A, ALICE);
        observe_once(MAX_REFERENCE - 1);
        assert_eq!(crate::LastAppliedAt::<Test>::get(), 1);
        assert!(!crate::Stalled::<Test>::get());

        // A gap of exactly StallAfter is not yet a stall.
        roll_to(1 + STALL_AFTER);
        assert!(!crate::Stalled::<Test>::get());
        assert_eq!(stalled_events(), 0);

        // One block past it, the alarm latches.
        roll_to(1 + STALL_AFTER + 1);
        assert!(crate::Stalled::<Test>::get());
        assert_eq!(stalled_events(), 1);
        System::assert_last_event(
            Event::ObservationStalled {
                last_applied: 1,
                blocks: STALL_AFTER + 1,
            }
            .into(),
        );

        // Latched: every further block is silent. The alarm is a latch, not a per-block event.
        roll_to(1 + STALL_AFTER + 20);
        assert!(crate::Stalled::<Test>::get());
        assert_eq!(
            stalled_events(),
            1,
            "the alarm fires ONCE per episode, not once per block"
        );

        // The next accepted observation clears it and reports the whole gap.
        let now = System::block_number();
        observe_once(MAX_REFERENCE);
        assert!(!crate::Stalled::<Test>::get());
        assert_eq!(crate::LastAppliedAt::<Test>::get(), now);
        System::assert_has_event(Event::ObservationResumed { blocks: now - 1 }.into());
    });
}

#[test]
fn no_alarm_while_observations_keep_landing() {
    new_test_ext().execute_with(|| {
        bind(A, ALICE);
        for n in 1..=(STALL_AFTER * 3) {
            System::set_block_number(n);
            CardanoObserver::on_initialize(n);
            observe_once(MAX_REFERENCE - 1);
        }
        assert!(!crate::Stalled::<Test>::get());
        assert_eq!(stalled_events(), 0);
        assert_eq!(crate::LastAppliedAt::<Test>::get(), STALL_AFTER * 3);
    });
}

#[test]
fn a_zero_clock_anchors_at_the_current_block_instead_of_alarming() {
    new_test_ext().execute_with(|| {
        // The state a chain upgraded INTO this alarm starts in: a high block number, no clock yet.
        System::set_block_number(500_000);
        assert_eq!(crate::LastAppliedAt::<Test>::get(), 0);

        CardanoObserver::on_initialize(500_000);

        assert_eq!(
            crate::LastAppliedAt::<Test>::get(),
            500_000,
            "the stall window opens HERE, not at block 0"
        );
        assert!(
            !crate::Stalled::<Test>::get(),
            "an upgraded chain's history is not a stall"
        );
        assert_eq!(stalled_events(), 0);
    });
}

#[test]
fn a_chain_that_never_observed_does_not_alarm() {
    new_test_ext().execute_with(|| {
        // `--dev`: no db-sync, so the node's IDP returns no data, `create_inherent` abstains on EVERY
        // block, and no observation ever lands. The alarm says "the sole weight writer has STOPPED" — a
        // false statement about a chain where it never started. Roll well past the threshold: silence.
        for n in 1..=(STALL_AFTER * 4) {
            System::set_block_number(n);
            CardanoObserver::on_initialize(n);
        }
        assert!(crate::LastReference::<Test>::get().is_none());
        assert!(
            !crate::Stalled::<Test>::get(),
            "a chain that never observed is not stalled — it never started"
        );
        assert_eq!(stalled_events(), 0, "no dev-run noise, no on-chain alarm");

        // But the FIRST accepted observation arms it for good: from here the alarm has something to lose.
        bind(A, ALICE);
        observe_once(MAX_REFERENCE - 1);
        let armed_at = System::block_number();
        assert!(crate::LastReference::<Test>::get().is_some());

        roll_to(armed_at + STALL_AFTER + 1);
        assert!(
            crate::Stalled::<Test>::get(),
            "once a real observation has landed, a gap past StallAfter IS a stall"
        );
        assert_eq!(stalled_events(), 1);
    });
}

#[test]
fn a_frozen_observation_still_stamps_the_clock() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        freeze();
        bind(A, ALICE);

        // Frozen, the inherent still LANDS every block — it verifies the read cross-node and skips only the
        // weight writes. So the clock keeps advancing and the alarm stays quiet: an emergency weight freeze
        // is a deliberate governance state, not a stalled observer.
        for n in 1..=(STALL_AFTER * 2) {
            System::set_block_number(n);
            CardanoObserver::on_initialize(n);
            observe_once(MAX_REFERENCE - 1);
        }

        assert!(!was_written(ALICE), "frozen: no weight applied");
        assert_eq!(crate::LastAppliedAt::<Test>::get(), STALL_AFTER * 2);
        assert!(!crate::Stalled::<Test>::get());
        assert_eq!(stalled_events(), 0);
    });
}

// ── idempotency + inherent-overrun (the observer boundary) ──────────────────────────────────────────

/// Re-applying the SAME observation is idempotent at the observer level. A Substrate re-org re-executes
/// the Mandatory `observe`, and re-derivation OVERWRITES the sink to the identical values — it NEVER
/// accumulates. `slot == last.slot` is admitted (the monotonicity guard is `>=`), so an unchanged
/// re-observation is legal and a no-op in effect. Complements talk-stake's downstream idempotency test
/// with the observer-level guarantee.
#[test]
fn re_applying_the_same_observation_is_idempotent() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind(A, ALICE);
        bind_stake(S1, ALICE);
        let slot = MAX_REFERENCE - 5;
        let apply = || {
            CardanoObserver::observe(
                RuntimeOrigin::none(),
                cref(slot),
                COMMIT,
                entries(&[(A, 200_000_000)]),
                stk(&[(S1, 700_000_000)]),
                no_roles(),
            )
        };
        assert_ok!(apply());
        assert_eq!(weight_of(ALICE), 200_000_000);
        assert_eq!(voting_power_of(ALICE), 700_000_000);
        assert_eq!(crate::LastReference::<Test>::get(), Some(cref(slot)));

        // Re-apply the identical reference + entries (the reorg-safe re-derive path).
        assert_ok!(apply());
        assert_eq!(
            weight_of(ALICE),
            200_000_000,
            "re-derive is a pure overwrite, never a sum"
        );
        assert_eq!(voting_power_of(ALICE), 700_000_000);
        assert_eq!(crate::LastReference::<Test>::get(), Some(cref(slot)));
    });
}

/// `create_inherent` abstains — drops the WHOLE inherent — when an observation would exceed `MaxObserved`,
/// rather than truncating it to a partial (fork-inducing) set. This is the silent-freeze PRECONDITION the
/// node's `ObserverOversize` alert and `cogno_observer_observations_oversize_total` metric watch for.
/// `BoundedVec::try_from` succeeds at EXACTLY `MaxObserved` and fails one above it — the boundary is pinned.
#[test]
fn create_inherent_abstains_when_the_observation_overruns_max_observed() {
    new_test_ext().execute_with(|| {
        let max = <<Test as crate::Config>::MaxObserved as frame_support::traits::Get<u32>>::get()
            as usize;
        // Distinct beacons; the value is irrelevant here (create_inherent neither resolves nor floors).
        let beacon = |i: usize| {
            let mut b = [0u8; 32];
            b[..8].copy_from_slice(&(i as u64).to_le_bytes());
            b
        };
        let make = |n: usize| CardanoObservation {
            reference: cref(1000),
            inputs_commitment: COMMIT,
            entries: (0..n).map(|i| (beacon(i), 200_000_000u128)).collect(),
            stake_entries: vec![],
            role_entries: vec![],
        };

        // Exactly MaxObserved fits — the inherent is produced.
        let mut id_ok = InherentData::new();
        put_obs(&mut id_ok, &make(max));
        assert!(<CardanoObserver as ProvideInherent>::create_inherent(&id_ok).is_some());

        // One over the ceiling — the whole inherent is dropped (author abstains, weight freezes).
        let mut id_over = InherentData::new();
        put_obs(&mut id_over, &make(max + 1));
        assert!(
            <CardanoObserver as ProvideInherent>::create_inherent(&id_over).is_none(),
            "an observation exceeding MaxObserved must abstain, not truncate"
        );
    });
}

// ── ROLE observation (spec 206): the observe role loop + unlock clamp ────────────────────────────────

fn roles(
    items: &[(RoleSource, [u8; 28], [u8; 28])],
) -> BoundedVec<RoleEntry, <Test as crate::Config>::MaxObserved> {
    BoundedVec::try_from(
        items
            .iter()
            .map(|(source, credential, id)| RoleEntry {
                source: *source,
                credential: *credential,
                id: *id,
            })
            .collect::<Vec<_>>(),
    )
    .expect("within MaxObserved")
}

#[test]
fn observe_credits_then_clamps_roles() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind(A, ALICE);
        let cal: [u8; 28] = [0xCA; 28];
        let pool: [u8; 28] = [0xF0; 28];
        bind_role(cal, ALICE);
        // Credit: the observed SpoCalidus entry resolves to ALICE and writes SPO(pool) (kind 0).
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 2),
            COMMIT,
            entries(&[(A, 200_000_000)]),
            no_stake(),
            roles(&[(RoleSource::SpoCalidus, cal, pool)]),
        ));
        assert_eq!(observed_roles_of(ALICE), vec![(0u8, pool)]);
        // A later observation WITHOUT the role entry → the unlock clamp clears ALICE's roles.
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 1),
            COMMIT,
            entries(&[(A, 200_000_000)]),
            no_stake(),
            roles(&[]),
        ));
        assert_eq!(observed_roles_of(ALICE), Vec::<(u8, [u8; 28])>::new());
    });
}

#[test]
fn observe_skips_an_unresolved_role_credential() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind(A, ALICE);
        // A role credential that resolves to no account (never bound) is skipped, not an error.
        assert_ok!(CardanoObserver::observe(
            RuntimeOrigin::none(),
            cref(MAX_REFERENCE - 1),
            COMMIT,
            entries(&[(A, 200_000_000)]),
            no_stake(),
            roles(&[(RoleSource::SpoCalidus, [0x11; 28], [0x22; 28])]),
        ));
        assert_eq!(observed_roles_of(ALICE), Vec::<(u8, [u8; 28])>::new());
    });
}
