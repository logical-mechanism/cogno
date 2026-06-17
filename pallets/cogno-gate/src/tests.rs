//! Unit / integration tests for `pallet-cogno-gate` — the M2 identity gate.
//!
//! These run against the real `CognoGate ↔ Microblog ↔ TalkStake` wiring (see `mock.rs`), so
//! they prove the actual gate behaviour: an unbound account cannot post; `link_identity` binds
//! 1:1 and unlocks posting; double-binds are rejected on both sides; `revoke` re-locks.
//!
//! Note: direct dispatch calls bypass the `CheckCapacity` transaction extension (extensions
//! only run in the full tx pipeline), so a bound account posts here without a capacity grant —
//! the feeless/capacity gate is exercised end-to-end by the node acceptance harness. These
//! tests isolate the *identity* gate.

use crate::{mock::*, AccountOf, Error, Event, IdentityHash, PkhOf, ThreadOf};
use frame_support::{assert_noop, assert_ok};
use sp_runtime::DispatchError;

const ALICE: u64 = 1;
const BOB: u64 = 2;
const HASH_A: IdentityHash = [0xAAu8; 32];
const HASH_B: IdentityHash = [0xBBu8; 32];

fn post_as(who: u64) -> sp_runtime::DispatchResult {
	Microblog::post_message(RuntimeOrigin::signed(who), b"gm cogno".to_vec(), None)
}

#[test]
fn unbound_account_cannot_post() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// No binding → the microblog post gate rejects with NotAllowed.
		assert_noop!(post_as(ALICE), pallet_microblog::Error::<Test>::NotAllowed);
	});
}

#[test]
fn link_identity_binds_both_ways_and_unlocks_posting() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// Unbound: cannot post.
		assert_noop!(post_as(ALICE), pallet_microblog::Error::<Test>::NotAllowed);

		// The follower (root in dev) binds the Cardano identity to ALICE's posting account.
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));

		// Both directional maps resolve the 1:1 binding.
		assert_eq!(PkhOf::<Test>::get(ALICE), Some(HASH_A));
		assert_eq!(AccountOf::<Test>::get(HASH_A), Some(ALICE));
		assert_eq!(CognoGate::identity_of(&ALICE), Some(HASH_A));
		System::assert_has_event(Event::IdentityLinked { who: ALICE, identity: HASH_A }.into());

		// on_first_bind primed the microblog capacity row (provider ref too).
		assert!(pallet_microblog::Capacity::<Test>::get(ALICE).is_some());

		// Now bound → ALICE can post (capacity bypassed in direct calls; identity gate passes).
		assert_ok!(post_as(ALICE));
	});
}

#[test]
fn double_bind_same_account_is_rejected() {
	new_test_ext().execute_with(|| {
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));
		// A second identity cannot be bound to an already-bound account.
		assert_noop!(
			CognoGate::link_identity(RuntimeOrigin::root(), HASH_B, ALICE, None),
			Error::<Test>::AccountAlreadyBound
		);
		assert_eq!(PkhOf::<Test>::get(ALICE), Some(HASH_A)); // unchanged
		assert_eq!(AccountOf::<Test>::get(HASH_B), None);
	});
}

#[test]
fn double_bind_same_identity_to_another_account_is_rejected() {
	new_test_ext().execute_with(|| {
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));
		// The same Cardano identity cannot be bound to a second account (the Sybil anchor).
		assert_noop!(
			CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, BOB, None),
			Error::<Test>::PkhAlreadyBound
		);
		assert_eq!(AccountOf::<Test>::get(HASH_A), Some(ALICE)); // unchanged
		assert!(!PkhOf::<Test>::contains_key(BOB));
		// BOB still cannot post.
		assert_noop!(post_as(BOB), pallet_microblog::Error::<Test>::NotAllowed);
	});
}

#[test]
fn link_identity_requires_follower_origin() {
	new_test_ext().execute_with(|| {
		// A public (signed) origin cannot forge a binding — only FollowerOrigin (root in dev).
		assert_noop!(
			CognoGate::link_identity(RuntimeOrigin::signed(ALICE), HASH_A, ALICE, None),
			DispatchError::BadOrigin
		);
		assert!(!PkhOf::<Test>::contains_key(ALICE));
	});
}

#[test]
fn thread_pointer_is_stored_and_length_bounded() {
	new_test_ext().execute_with(|| {
		// A valid 5-byte / 10-hex cogno_v3 pointer is stored.
		let ptr = vec![0x00, 0xe5, 0x99, 0x3f, 0xa3]; // 5 bytes (cf. cogno_v3 #"00e5993fa3")
		assert_ok!(CognoGate::link_identity(
			RuntimeOrigin::root(),
			HASH_A,
			ALICE,
			Some(ptr.clone())
		));
		assert_eq!(ThreadOf::<Test>::get(ALICE).map(|b| b.to_vec()), Some(ptr));

		// An over-long pointer (>10 bytes) is rejected without binding.
		let too_long = vec![0u8; 11];
		assert_noop!(
			CognoGate::link_identity(RuntimeOrigin::root(), HASH_B, BOB, Some(too_long)),
			Error::<Test>::BadThread
		);
		assert!(!PkhOf::<Test>::contains_key(BOB));
	});
}

#[test]
fn revoke_relocks_posting() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));
		assert_ok!(post_as(ALICE)); // bound → can post

		// The follower (operator ban, DR-14) revokes the binding.
		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		assert!(!PkhOf::<Test>::contains_key(ALICE));
		assert_eq!(AccountOf::<Test>::get(HASH_A), None);
		System::assert_has_event(Event::Revoked { who: ALICE, identity: HASH_A }.into());

		// Re-locked: ALICE can no longer post.
		assert_noop!(post_as(ALICE), pallet_microblog::Error::<Test>::NotAllowed);

		// The capacity row is intentionally left in place (M2b owns full teardown).
		assert!(pallet_microblog::Capacity::<Test>::get(ALICE).is_some());

		// After revoke the identity is free to be re-bound (to the same or a new account).
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, BOB, None));
		assert_eq!(AccountOf::<Test>::get(HASH_A), Some(BOB));
	});
}

#[test]
fn revoke_unknown_account_fails() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			CognoGate::revoke(RuntimeOrigin::root(), ALICE),
			Error::<Test>::NotBound
		);
	});
}

#[test]
fn revoke_requires_follower_origin() {
	new_test_ext().execute_with(|| {
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));
		assert_noop!(
			CognoGate::revoke(RuntimeOrigin::signed(ALICE), ALICE),
			DispatchError::BadOrigin
		);
		assert!(PkhOf::<Test>::contains_key(ALICE)); // still bound
	});
}
