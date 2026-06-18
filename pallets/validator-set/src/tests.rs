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

// NOTE (validators-5): the FULL queue→enact latency — a pending change becoming the ACTIVE
// aura/grandpa set only after pallet-session rotates ~2 boundaries later, AND pallet-session
// silently filtering out an added validator that has no registered session keys (validators-2) — is
// integration behaviour of pallet-session that requires real (proof-of-possession) session keys, so
// it is exercised on the live multi-node `--dev` network in the M6 acceptance, not in this mock. The
// in-pallet surface (new_session publishes the pending set; the offline-drain path) is covered above.
