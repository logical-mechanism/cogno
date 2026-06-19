//! Unit tests for `pallet-cardano-observer` — the inherent verification semantics + the Mandatory
//! `observe` dispatchable (monotonicity, stability bound, MaxStakeWeight skip, account resolution,
//! weight application, unlock clamp).

use crate::mock::*;
use crate::{
	BeaconName, CardanoObservation, CardanoRef, Error, Event, InherentError, INHERENT_IDENTIFIER,
};
use frame_support::{
	assert_noop, assert_ok,
	inherent::{InherentData, IsFatalError, ProvideInherent},
	BoundedVec,
};

const ALICE: AccountId = 1;
const BOB: AccountId = 2;
const A: BeaconName = [0xAA; 32];
const B: BeaconName = [0xBB; 32];

fn cref(slot: u64) -> CardanoRef {
	CardanoRef { slot, block_hash: [0u8; 32] }
}

fn entries(items: &[(BeaconName, u128)]) -> BoundedVec<(BeaconName, u128), <Test as crate::Config>::MaxObserved> {
	BoundedVec::try_from(items.to_vec()).expect("within MaxObserved")
}

fn put_obs(id: &mut InherentData, obs: &CardanoObservation) {
	id.put_data(INHERENT_IDENTIFIER, obs).expect("encode observation");
}

/// Switch the pallet to ENFORCE mode (the verified observation is applied to weight), via the
/// root-gated setter — the application tests run here so they can assert on the `WeightSink`.
fn enforce() {
	assert_ok!(CardanoObserver::set_enforcement(RuntimeOrigin::root(), true));
}
/// The per-account shadow projection the inherent recorded (what it WOULD/DOES apply).
fn shadow_of(who: AccountId) -> u128 {
	crate::ShadowStake::<Test>::get(who)
}

// ── ProvideInherent (create_inherent / check_inherent) ─────────────────────────────────────────────

#[test]
fn create_inherent_builds_the_observe_call_from_node_data() {
	new_test_ext().execute_with(|| {
		let obs = CardanoObservation { reference: cref(1000), entries: vec![(A, 200_000_000), (B, 300_000_000)] };
		let mut id = InherentData::new();
		put_obs(&mut id, &obs);
		let call = <CardanoObserver as ProvideInherent>::create_inherent(&id).expect("inherent produced");
		match call {
			crate::Call::observe { reference, entries } => {
				assert_eq!(reference, cref(1000));
				assert_eq!(entries.to_vec(), vec![(A, 200_000_000), (B, 300_000_000)]);
			},
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
		let obs = CardanoObservation { reference: cref(1000), entries: vec![(A, 200_000_000)] };
		let mut id = InherentData::new();
		put_obs(&mut id, &obs);
		let call = crate::Call::<Test>::observe { reference: cref(1000), entries: entries(&[(A, 200_000_000)]) };
		assert!(<CardanoObserver as ProvideInherent>::check_inherent(&call, &id).is_ok());
	});
}

#[test]
fn check_inherent_mismatch_is_fatal() {
	new_test_ext().execute_with(|| {
		// The importer's own read differs from the author's claim ⇒ Mismatch (FATAL → block rejected).
		let local = CardanoObservation { reference: cref(1000), entries: vec![(A, 200_000_000)] };
		let mut id = InherentData::new();
		put_obs(&mut id, &local);
		let lying_call = crate::Call::<Test>::observe { reference: cref(1000), entries: entries(&[(A, 999_000_000)]) };
		let err = <CardanoObserver as ProvideInherent>::check_inherent(&lying_call, &id).unwrap_err();
		assert!(matches!(err, InherentError::Mismatch));
		assert!(err.is_fatal_error(), "Mismatch must be fatal (reject the block)");

		// A differing reference is also a mismatch.
		let wrong_ref = crate::Call::<Test>::observe { reference: cref(1001), entries: entries(&[(A, 200_000_000)]) };
		assert!(matches!(<CardanoObserver as ProvideInherent>::check_inherent(&wrong_ref, &id).unwrap_err(), InherentError::Mismatch));
	});
}

#[test]
fn check_inherent_ignores_block_hash_diagnostic() {
	new_test_ext().execute_with(|| {
		// The importer's local read agrees on the reference SLOT and the entries but carries a DIFFERENT
		// block_hash (its own Kupo checkpoint-tip — a node-local diagnostic). This must be accepted, never
		// a Mismatch: block_hash is not consensus-load-bearing (only slot + entries are).
		let local = CardanoObservation {
			reference: CardanoRef { slot: 1000, block_hash: [0x11; 32] },
			entries: vec![(A, 200_000_000)],
		};
		let mut id = InherentData::new();
		put_obs(&mut id, &local);
		let call = crate::Call::<Test>::observe {
			reference: CardanoRef { slot: 1000, block_hash: [0x22; 32] }, // different hash, same slot
			entries: entries(&[(A, 200_000_000)]),
		};
		assert!(
			<CardanoObserver as ProvideInherent>::check_inherent(&call, &id).is_ok(),
			"identical slot + entries with a differing block_hash must be accepted"
		);
	});
}

#[test]
fn check_inherent_cannot_verify_when_local_source_behind_is_non_fatal() {
	new_test_ext().execute_with(|| {
		// The importer has NO local observation (its Cardano source is behind/down) ⇒ CannotVerify,
		// NON-FATAL: accept without verifying (never fork because YOUR follower lags).
		let id = InherentData::new(); // no data
		let call = crate::Call::<Test>::observe { reference: cref(1000), entries: entries(&[(A, 200_000_000)]) };
		let err = <CardanoObserver as ProvideInherent>::check_inherent(&call, &id).unwrap_err();
		assert!(matches!(err, InherentError::CannotVerify));
		assert!(!err.is_fatal_error(), "CannotVerify must be NON-fatal (accept, don't fork on a slow node)");
	});
}

#[test]
fn observe_call_is_recognised_as_an_inherent() {
	let call = crate::Call::<Test>::observe { reference: cref(1), entries: entries(&[]) };
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
			entries(&[(A, 200_000_000), (B, 500_000_000)]),
		));
		assert_eq!(weight_of(ALICE), 200_000_000, "bound A credited at its lovelace");
		assert!(!was_written(BOB), "unbound B is skipped (bind precedes weight)");
		System::assert_last_event(Event::ObservationApplied { reference_slot: MAX_REFERENCE - 1, credited: 1, cleared: 0, skipped: 0, enforced: true }.into());
	});
}

#[test]
fn observe_applies_min_lock_floor() {
	new_test_ext().execute_with(|| {
		enforce();
		bind(A, ALICE);
		assert_ok!(CardanoObserver::observe(RuntimeOrigin::none(), cref(MAX_REFERENCE - 1), entries(&[(A, MIN_LOCK - 1)])));
		assert_eq!(weight_of(ALICE), 0, "below MIN_LOCK ⇒ weight 0");
		assert_eq!(shadow_of(ALICE), 0, "the projection also floors to 0");
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
		// the skip is COUNTED in the event (so it can't be mis-read as agreement by the shadow-diff).
		assert_ok!(CardanoObserver::observe(
			RuntimeOrigin::none(),
			cref(MAX_REFERENCE - 1),
			entries(&[(A, 200_000_000), (B, MAX_STAKE_WEIGHT + 1)]),
		));
		assert_eq!(weight_of(ALICE), 200_000_000, "A still credited");
		assert!(!was_written(BOB), "the over-cap entry is skipped, not consensus-pinned (block not bricked)");
		assert_eq!(shadow_of(BOB), 0, "the skipped entry is not projected either");
		System::assert_last_event(Event::ObservationApplied { reference_slot: MAX_REFERENCE - 1, credited: 1, cleared: 0, skipped: 1, enforced: true }.into());
	});
}

#[test]
fn observe_clamps_accounts_that_dropped_out_to_zero() {
	new_test_ext().execute_with(|| {
		enforce();
		bind(A, ALICE);
		bind(B, BOB);
		// Block 1: both A and B locked.
		assert_ok!(CardanoObserver::observe(RuntimeOrigin::none(), cref(MAX_REFERENCE - 10), entries(&[(A, 200_000_000), (B, 300_000_000)])));
		assert_eq!(weight_of(ALICE), 200_000_000);
		assert_eq!(weight_of(BOB), 300_000_000);
		// Block 2: B unlocked (absent now) ⇒ clamped to 0; A persists.
		assert_ok!(CardanoObserver::observe(RuntimeOrigin::none(), cref(MAX_REFERENCE - 5), entries(&[(A, 200_000_000)])));
		assert_eq!(weight_of(ALICE), 200_000_000, "A persists");
		assert_eq!(weight_of(BOB), 0, "B (absent now) is clamped to 0 — the unlock path");
		assert_eq!(shadow_of(BOB), 0, "the projection also clamps B to 0 (insert-0-never-delete)");
	});
}

// ── SHADOW mode (the DEFAULT) — verify + project, but DO NOT touch weight ───────────────────────────

#[test]
fn shadow_mode_records_projection_but_never_writes_weight() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// EnforceWeight defaults to false (shadow) — no enforce() call.
		bind(A, ALICE);
		assert_ok!(CardanoObserver::observe(RuntimeOrigin::none(), cref(MAX_REFERENCE - 1), entries(&[(A, 200_000_000)])));
		// The WeightSink (talk-stake/microblog) is NEVER called in shadow — the committee owns AllowedStake.
		assert!(!was_written(ALICE), "shadow mode must NOT apply weight (committee remains sole writer)");
		// …but the projection IS recorded, so the off-chain diff can compare it against AllowedStake.
		assert_eq!(shadow_of(ALICE), 200_000_000, "the inherent's projected weight is recorded in shadow");
		System::assert_last_event(Event::ObservationApplied { reference_slot: MAX_REFERENCE - 1, credited: 1, cleared: 0, skipped: 0, enforced: false }.into());
	});
}

#[test]
fn shadow_mode_clamp_zeroes_the_projection_only() {
	new_test_ext().execute_with(|| {
		bind(A, ALICE);
		bind(B, BOB);
		// Both observed (shadow) — projection recorded, weight untouched.
		assert_ok!(CardanoObserver::observe(RuntimeOrigin::none(), cref(MAX_REFERENCE - 10), entries(&[(A, 200_000_000), (B, 300_000_000)])));
		assert_eq!(shadow_of(BOB), 300_000_000);
		assert!(!was_written(BOB));
		// B drops out: the projection clamps to 0, but the WeightSink is STILL never called.
		assert_ok!(CardanoObserver::observe(RuntimeOrigin::none(), cref(MAX_REFERENCE - 5), entries(&[(A, 200_000_000)])));
		assert_eq!(shadow_of(BOB), 0, "the dropped account's projection is zeroed (visible to the diff)");
		assert!(!was_written(BOB), "…but no AllowedStake write in shadow");
	});
}

// ── the enforce/shadow flag setter ───────────────────────────────────────────────────────────────

#[test]
fn set_enforcement_is_gated_by_the_enforce_origin() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// A signed (non-root) caller cannot flip the flag (EnforceOrigin = EnsureRoot in the mock).
		assert!(CardanoObserver::set_enforcement(RuntimeOrigin::signed(ALICE), true).is_err());
		assert!(!crate::EnforceWeight::<Test>::get(), "flag unchanged after a rejected call");
		// Root can.
		assert_ok!(CardanoObserver::set_enforcement(RuntimeOrigin::root(), true));
		assert!(crate::EnforceWeight::<Test>::get(), "root flipped the flag to enforce");
		System::assert_last_event(Event::EnforcementSet { enabled: true }.into());
		// …and back to shadow.
		assert_ok!(CardanoObserver::set_enforcement(RuntimeOrigin::root(), false));
		assert!(!crate::EnforceWeight::<Test>::get());
	});
}

#[test]
fn set_enforcement_is_not_an_inherent() {
	// Only `observe` may be an inherent (the §5.2 mutual-exclusion invariant) — the setter is a normal,
	// pool-admissible governance call and must NOT be discriminated as an inherent.
	let call = crate::Call::<Test>::set_enforcement { enabled: true };
	assert!(!<CardanoObserver as ProvideInherent>::is_inherent(&call));
}

#[test]
fn observe_rejects_a_regressing_reference() {
	new_test_ext().execute_with(|| {
		bind(A, ALICE);
		assert_ok!(CardanoObserver::observe(RuntimeOrigin::none(), cref(MAX_REFERENCE - 5), entries(&[(A, 200_000_000)])));
		// A later block proposing an OLDER reference than the chain already holds is rejected (§5.6).
		assert_noop!(
			CardanoObserver::observe(RuntimeOrigin::none(), cref(MAX_REFERENCE - 6), entries(&[(A, 200_000_000)])),
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
			CardanoObserver::observe(RuntimeOrigin::none(), cref(MAX_REFERENCE + 1), entries(&[(A, 200_000_000)])),
			Error::<Test>::ReferenceTooFresh
		);
		// Exactly at the boundary is allowed.
		assert_ok!(CardanoObserver::observe(RuntimeOrigin::none(), cref(MAX_REFERENCE), entries(&[(A, 200_000_000)])));
	});
}

#[test]
fn observe_requires_the_none_origin() {
	new_test_ext().execute_with(|| {
		// An inherent must be dispatched with the None origin — a signed caller is rejected (it also
		// can never reach the pool, since is_inherent is true; this is defence-in-depth).
		assert!(CardanoObserver::observe(RuntimeOrigin::signed(ALICE), cref(MAX_REFERENCE - 1), entries(&[(A, 200_000_000)])).is_err());
	});
}
