//! Unit tests for `pallet-validator-set` — the extrinsic behaviour (add / remove / duplicate /
//! min-floor / origin gate) and the `SessionManager` hand-off. The queue→apply-at-a-session-boundary
//! behaviour is exercised on a live multi-node `--dev` network in the M6 acceptance, not here.

#![cfg(test)]

use crate::{mock::*, Error, Event, Validators};
use frame_support::{assert_noop, assert_ok};
use sp_runtime::DispatchError;

fn last_event() -> Event<Test> {
	System::events()
		.into_iter()
		.rev()
		.find_map(|r| {
			if let RuntimeEvent::ValidatorSet(e) = r.event {
				Some(e)
			} else {
				None
			}
		})
		.expect("a ValidatorSet event was emitted")
}

#[test]
fn genesis_seats_initial_validators() {
	new_test_ext().execute_with(|| {
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2, 3]);
	});
}

#[test]
fn add_validator_works_and_emits_event() {
	new_test_ext().execute_with(|| {
		assert_ok!(ValidatorSet::add_validator(RuntimeOrigin::root(), 4));
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2, 3, 4]);
		assert_eq!(last_event(), Event::ValidatorAdditionInitiated(4));
	});
}

#[test]
fn add_validator_rejects_duplicate() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			ValidatorSet::add_validator(RuntimeOrigin::root(), 1),
			Error::<Test>::Duplicate
		);
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2, 3]);
	});
}

#[test]
fn remove_validator_works_and_emits_event() {
	new_test_ext().execute_with(|| {
		assert_ok!(ValidatorSet::remove_validator(RuntimeOrigin::root(), 3));
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2]);
		assert_eq!(last_event(), Event::ValidatorRemovalInitiated(3));
	});
}

#[test]
fn remove_validator_honours_min_authorities_floor() {
	new_test_ext().execute_with(|| {
		// MinAuthorities = 2. From [1,2,3] we may remove down to 2, but not below.
		assert_ok!(ValidatorSet::remove_validator(RuntimeOrigin::root(), 3));
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2]);
		// The set is now at the floor — any further removal is refused (target count 1 < 2).
		assert_noop!(
			ValidatorSet::remove_validator(RuntimeOrigin::root(), 2),
			Error::<Test>::TooLowValidatorCount
		);
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2]);
	});
}

#[test]
fn add_remove_require_the_add_remove_origin() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			ValidatorSet::add_validator(RuntimeOrigin::signed(1), 4),
			DispatchError::BadOrigin
		);
		assert_noop!(
			ValidatorSet::remove_validator(RuntimeOrigin::signed(1), 3),
			DispatchError::BadOrigin
		);
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2, 3]);
	});
}

#[test]
fn session_manager_publishes_the_current_set() {
	new_test_ext().execute_with(|| {
		use pallet_session::SessionManager;
		// The SessionManager hands the pending set to pallet-session each rotation.
		assert_eq!(<ValidatorSet as SessionManager<u64>>::new_session(1), Some(vec![1, 2, 3]));
		assert_ok!(ValidatorSet::add_validator(RuntimeOrigin::root(), 4));
		// A queued addition is reflected in the very next `new_session` (pallet-session then
		// applies it one boundary later — the ~2-session latency).
		assert_eq!(<ValidatorSet as SessionManager<u64>>::new_session(2), Some(vec![1, 2, 3, 4]));
	});
}

#[test]
fn add_validator_rejects_growth_past_max_validators() {
	// validators-3: the set cannot grow past MaxValidators (= 5 in the mock), which mirrors the
	// runtime's aura/grandpa MaxAuthorities — so a rotation can never silently truncate it.
	new_test_ext().execute_with(|| {
		assert_ok!(ValidatorSet::add_validator(RuntimeOrigin::root(), 4));
		assert_ok!(ValidatorSet::add_validator(RuntimeOrigin::root(), 5)); // now [1,2,3,4,5] = the cap
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2, 3, 4, 5]);
		// The 6th would exceed MaxValidators — rejected, set unchanged (no silent truncation).
		assert_noop!(
			ValidatorSet::add_validator(RuntimeOrigin::root(), 6),
			Error::<Test>::TooManyValidators
		);
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2, 3, 4, 5]);
	});
}

#[test]
fn new_session_drains_offline_validators() {
	// validators-5: the im-online drain path (inert in v1) — a validator queued in OfflineValidators
	// is removed from the published set at the next session and the queue is cleared.
	new_test_ext().execute_with(|| {
		use pallet_session::SessionManager;
		crate::OfflineValidators::<Test>::try_mutate(|v| v.try_push(3u64)).unwrap();
		let published = <ValidatorSet as SessionManager<u64>>::new_session(2);
		assert_eq!(published, Some(vec![1, 2]), "the offline validator is drained from the set");
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2]);
		assert!(crate::OfflineValidators::<Test>::get().is_empty(), "queue cleared after drain");
	});
}

#[test]
fn remove_validator_nonexistent_is_a_noop_but_still_succeeds() {
	// validators-5 / brief gap 1 + runtime gap 8: `do_remove_validator` uses `retain`, which
	// silently filters nothing if the id is absent. The call must still return Ok and emit the
	// removal event (idempotent contract), but the set must be UNCHANGED — no element is dropped
	// by mistake. (We removed 99, not the first/last element of [1,2,3].)
	new_test_ext().execute_with(|| {
		assert_ok!(ValidatorSet::remove_validator(RuntimeOrigin::root(), 99));
		assert_eq!(
			Validators::<Test>::get().to_vec(),
			vec![1, 2, 3],
			"removing an absent validator leaves the set untouched",
		);
		// The event is still emitted even though nothing was removed (the no-op path).
		assert_eq!(last_event(), Event::ValidatorRemovalInitiated(99));
	});
}

#[test]
fn new_session_drains_multiple_offline_validators() {
	// brief gap 2: the real im-online scenario flags several validators at once. Both queued ids
	// must be removed from the published set and the queue fully cleared (not just the first).
	new_test_ext().execute_with(|| {
		use pallet_session::SessionManager;
		crate::OfflineValidators::<Test>::try_mutate(|v| {
			v.try_push(2u64)?;
			v.try_push(3u64)
		})
		.unwrap();
		let published = <ValidatorSet as SessionManager<u64>>::new_session(2);
		assert_eq!(published, Some(vec![1]), "both offline validators are drained");
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1]);
		assert!(
			crate::OfflineValidators::<Test>::get().is_empty(),
			"the offline queue is cleared after a multi-element drain",
		);
	});
}

#[test]
fn remove_validator_floor_uses_target_count_not_current_count() {
	// brief gap 3: the floor compares the *post-removal* (target) count against MinAuthorities.
	// With MinAuthorities = 2 and the set [1,2,3]: removing once is fine (target 2 == floor), the
	// next removal has target 1 < 2 and must be rejected. This pins the saturating_sub(1) >= floor
	// semantics: the boundary is target >= floor (exactly-at-floor is allowed), not current > floor.
	new_test_ext().execute_with(|| {
		// target = 2 == MinAuthorities -> allowed (at the floor, not below it).
		assert_ok!(ValidatorSet::remove_validator(RuntimeOrigin::root(), 3));
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2]);
		// target = 1 < MinAuthorities -> rejected.
		assert_noop!(
			ValidatorSet::remove_validator(RuntimeOrigin::root(), 1),
			Error::<Test>::TooLowValidatorCount
		);
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2]);
	});
}

#[test]
fn add_validator_duplicate_detection_is_exact_id_match() {
	// brief gap 5: `contains(&id)` is an exact-equality match. Re-adding an existing id (2, the
	// middle element) is rejected, but a fresh distinct id (10) is accepted — proving the guard is
	// per-id, not a prefix/range match, and does not spuriously reject non-members.
	new_test_ext().execute_with(|| {
		assert_noop!(
			ValidatorSet::add_validator(RuntimeOrigin::root(), 2),
			Error::<Test>::Duplicate
		);
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2, 3]);
		assert_ok!(ValidatorSet::add_validator(RuntimeOrigin::root(), 10));
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2, 3, 10]);
		assert_eq!(last_event(), Event::ValidatorAdditionInitiated(10));
	});
}

#[test]
fn sequential_removals_at_floor_all_fail_and_emit_no_event() {
	// brief gap 6: once the set is at the floor [1,2], EVERY further removal must fail in sequence
	// (including a removal of an absent id, which would otherwise be a no-op-Ok). Critically, no
	// ValidatorRemovalInitiated event may be emitted by a rejected call — the floor check runs
	// BEFORE the event, so a BadOrigin/floor rejection leaves the event stream clean.
	new_test_ext().execute_with(|| {
		assert_ok!(ValidatorSet::remove_validator(RuntimeOrigin::root(), 3));
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2]);
		// Snapshot the event count after the one legitimate removal; nothing below may add to it.
		let events_after_valid_removal = System::events().len();

		for target in [2u64, 1, 99] {
			assert_noop!(
				ValidatorSet::remove_validator(RuntimeOrigin::root(), target),
				Error::<Test>::TooLowValidatorCount
			);
			assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2]);
		}
		assert_eq!(
			System::events().len(),
			events_after_valid_removal,
			"no spurious removal event is emitted by a floor-rejected call",
		);
	});
}

#[test]
fn add_then_mark_offline_then_session_drains_the_added_validator() {
	// brief gap 7: compose the add path and the offline-drain path. Add 4 (set becomes [1,2,3,4]),
	// flag 4 offline, then a session rotation must publish [1,2,3] and clear the queue — the
	// freshly-added validator is drained by the very same mechanism that drains a genesis one.
	new_test_ext().execute_with(|| {
		use pallet_session::SessionManager;
		assert_ok!(ValidatorSet::add_validator(RuntimeOrigin::root(), 4));
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2, 3, 4]);
		crate::OfflineValidators::<Test>::try_mutate(|v| v.try_push(4u64)).unwrap();

		let published = <ValidatorSet as SessionManager<u64>>::new_session(2);
		assert_eq!(published, Some(vec![1, 2, 3]), "the offline-flagged addition is drained");
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1, 2, 3]);
		assert!(crate::OfflineValidators::<Test>::get().is_empty(), "queue cleared after drain");
	});
}

#[test]
fn mark_for_removal_silently_drops_when_offline_queue_is_full() {
	// brief gap 8: `mark_for_removal` ignores `try_push` overflow by design (best-effort, inert in
	// v1). Fill OfflineValidators to MaxValidators (5) with distinct ids, then report one more
	// offence — the extra id must NOT be queued (try_push failed silently) and the queue stays at
	// the cap. This pins the documented "intentionally ignored Result" behaviour.
	new_test_ext().execute_with(|| {
		use sp_staking::offence::ReportOffence;
		// Saturate the offline queue to MaxValidators = 5.
		crate::OfflineValidators::<Test>::mutate(|v| {
			for id in 1u64..=5 {
				v.try_push(id).expect("5 ids fit within MaxValidators=5");
			}
		});
		assert_eq!(crate::OfflineValidators::<Test>::get().len(), 5);

		// Report an offence for a 6th id — the ReportOffence impl calls mark_for_removal, whose
		// try_push must fail silently (no panic, no growth past the bound).
		let offence = MockOffence { offenders: vec![(6u64, 6u64)] };
		assert_ok!(<ValidatorSet as ReportOffence<_, _, _>>::report_offence(vec![], offence));

		let queue = crate::OfflineValidators::<Test>::get();
		assert_eq!(queue.len(), 5, "the queue did not grow past MaxValidators");
		assert!(!queue.contains(&6u64), "the overflowing id was dropped, not queued");
	});
}

#[test]
fn remove_from_single_validator_set_at_min_authorities_one_is_rejected() {
	// brief gap 10: with MinAuthorities = 1 and a single-validator set [1], removing 1 gives a
	// target count of 0 < 1, which must be rejected (the saturating_sub(1) as u32 boundary at the
	// very bottom of the range). Uses a bespoke ext so the mock's MinAuthorities = 2 floor does not
	// mask the zero-removal edge.
	single_validator_ext().execute_with(|| {
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1]);
		assert_noop!(
			ValidatorSet::remove_validator(RuntimeOrigin::root(), 1),
			Error::<Test>::TooLowValidatorCount
		);
		assert_eq!(Validators::<Test>::get().to_vec(), vec![1], "the last validator cannot be removed");
	});
}

// NOTE (validators-5): the FULL queue→enact latency — a pending change becoming the ACTIVE
// aura/grandpa set only after pallet-session rotates ~2 boundaries later, AND pallet-session
// silently filtering out an added validator that has no registered session keys (validators-2) — is
// integration behaviour of pallet-session that requires real (proof-of-possession) session keys, so
// it is exercised on the live multi-node `--dev` network in the M6 acceptance, not in this mock. The
// in-pallet surface (new_session publishes the pending set; the offline-drain path) is covered above.
