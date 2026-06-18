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
fn thread_pointer_at_exactly_ten_bytes_is_accepted() {
	// gap-1: the BoundedVec<u8, ConstU32<10>> boundary. 10 bytes is the inclusive limit — it
	// must succeed and be stored verbatim; 11 (tested above) fails. This pins the off-by-one.
	new_test_ext().execute_with(|| {
		let ptr = vec![0xABu8; 10]; // exactly at the limit
		assert_ok!(CognoGate::link_identity(
			RuntimeOrigin::root(),
			HASH_A,
			ALICE,
			Some(ptr.clone())
		));
		assert_eq!(ThreadOf::<Test>::get(ALICE).map(|b| b.to_vec()), Some(ptr));
		assert_eq!(PkhOf::<Test>::get(ALICE), Some(HASH_A));
	});
}

#[test]
fn thread_pointer_empty_is_accepted_and_stored_empty() {
	// gap-3: Some(vec![]) is at the LOWER boundary (0 ≤ len ≤ 10) — it must succeed and bind.
	// An empty pointer is stored as an empty BoundedVec (Some), distinct from the None path.
	new_test_ext().execute_with(|| {
		assert_ok!(CognoGate::link_identity(
			RuntimeOrigin::root(),
			HASH_A,
			ALICE,
			Some(vec![])
		));
		assert_eq!(PkhOf::<Test>::get(ALICE), Some(HASH_A));
		// Some(empty) — the field was supplied (just zero-length), not omitted.
		assert_eq!(ThreadOf::<Test>::get(ALICE).map(|b| b.to_vec()), Some(vec![]));
	});
}

#[test]
fn link_with_none_thread_pointer_stores_no_thread() {
	// Companion to the empty-vec case: None must leave ThreadOf entirely unset (is_none), proving
	// the None branch never writes a row (distinct from Some(vec![]) above).
	new_test_ext().execute_with(|| {
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));
		assert!(ThreadOf::<Test>::get(ALICE).is_none());
	});
}

#[test]
fn bad_thread_pointer_emits_no_event_and_writes_nothing() {
	// Event-absence on a rejected bind (gap-style): an over-long pointer fails the up-front
	// validation BEFORE any write, so NO directional map is touched and NO IdentityLinked fires.
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_noop!(
			CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, Some(vec![0u8; 11])),
			Error::<Test>::BadThread
		);
		// All-or-nothing: neither directional map nor the thread row was written.
		assert!(!PkhOf::<Test>::contains_key(ALICE));
		assert_eq!(AccountOf::<Test>::get(HASH_A), None);
		assert!(ThreadOf::<Test>::get(ALICE).is_none());
		// No spurious IdentityLinked event on the rejected call.
		assert!(!System::events()
			.iter()
			.any(|r| matches!(r.event, RuntimeEvent::CognoGate(Event::IdentityLinked { .. }))));
	});
}

#[test]
fn revoke_clears_thread_pointer() {
	// gap-2: revoke must remove ThreadOf (lib.rs ThreadOf::remove) or stale pointers accumulate.
	new_test_ext().execute_with(|| {
		let ptr = vec![0x01, 0x02, 0x03];
		assert_ok!(CognoGate::link_identity(
			RuntimeOrigin::root(),
			HASH_A,
			ALICE,
			Some(ptr.clone())
		));
		assert_eq!(ThreadOf::<Test>::get(ALICE).map(|b| b.to_vec()), Some(ptr));

		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		// The thread pointer is gone — no stale row survives the revoke.
		assert!(ThreadOf::<Test>::get(ALICE).is_none());
	});
}

#[test]
fn revoke_clears_account_of_immediately() {
	// gap-5: AccountOf must be None the instant after revoke (before any rebind). Existing tests
	// only check AccountOf after a subsequent rebind, masking a stale reverse-map row.
	new_test_ext().execute_with(|| {
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));
		assert_eq!(AccountOf::<Test>::get(HASH_A), Some(ALICE));

		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		// Reverse map cleared immediately — no rebind required to free the identity.
		assert_eq!(AccountOf::<Test>::get(HASH_A), None);
		assert!(!PkhOf::<Test>::contains_key(ALICE));
	});
}

#[test]
fn revoked_event_carries_the_correct_identity() {
	// gap-4 (cogno brief): destructure the Revoked event and assert identity == the bound HASH_A
	// (and who == ALICE). Catches a revoke that emits the event with a wrong/zeroed identity.
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));
		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));

		let revoked = System::events()
			.into_iter()
			.find_map(|r| match r.event {
				RuntimeEvent::CognoGate(Event::Revoked { who, identity }) => Some((who, identity)),
				_ => None,
			})
			.expect("a Revoked event must be emitted");
		assert_eq!(revoked, (ALICE, HASH_A), "Revoked must carry the bound account + identity");
	});
}

#[test]
fn revoke_unknown_account_emits_no_revoked_event() {
	// Event-absence on the NotBound idempotent no-op: a revoke of a never-bound account must NOT
	// emit a spurious Revoked event (the chain stays silent; only the error returns).
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_noop!(
			CognoGate::revoke(RuntimeOrigin::root(), ALICE),
			Error::<Test>::NotBound
		);
		assert!(!System::events()
			.iter()
			.any(|r| matches!(r.event, RuntimeEvent::CognoGate(Event::Revoked { .. }))));
	});
}

#[test]
fn thread_pointer_state_transitions_across_rebind() {
	// gap-7: bind WITH a pointer, revoke (clears it), rebind the same identity to a NEW account
	// WITHOUT a pointer → the new account's ThreadOf is None, and the old account stays cleared.
	new_test_ext().execute_with(|| {
		assert_ok!(CognoGate::link_identity(
			RuntimeOrigin::root(),
			HASH_A,
			ALICE,
			Some(vec![0xDE, 0xAD])
		));
		assert!(ThreadOf::<Test>::get(ALICE).is_some());

		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		assert!(ThreadOf::<Test>::get(ALICE).is_none());

		// Rebind the freed identity to BOB without a thread pointer.
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, BOB, None));
		assert!(ThreadOf::<Test>::get(BOB).is_none(), "None rebind writes no thread row");
		assert!(ThreadOf::<Test>::get(ALICE).is_none(), "old account stays cleared");
		assert_eq!(AccountOf::<Test>::get(HASH_A), Some(BOB));
	});
}

#[test]
fn rebind_can_reuse_the_same_thread_pointer() {
	// runtime-node gap-4 (rebind reuse): after revoke frees the identity, the SAME thread pointer
	// must be reusable on the rebind (the merkle root is not "consumed"). Rebind same identity →
	// same account → same pointer.
	new_test_ext().execute_with(|| {
		let ptr = vec![0x00, 0xe5, 0x99, 0x3f, 0xa3];
		assert_ok!(CognoGate::link_identity(
			RuntimeOrigin::root(),
			HASH_A,
			ALICE,
			Some(ptr.clone())
		));
		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		assert_ok!(CognoGate::link_identity(
			RuntimeOrigin::root(),
			HASH_A,
			ALICE,
			Some(ptr.clone())
		));
		assert_eq!(ThreadOf::<Test>::get(ALICE).map(|b| b.to_vec()), Some(ptr));
	});
}

#[test]
fn full_event_audit_trail_for_bind_revoke_rebind() {
	// gap-8: the complete event sequence. A bind→revoke→rebind cycle must fire
	// IdentityLinked, then Revoked, then IdentityLinked again — in that exact order. Guards
	// against an accidental event deletion on any one of the three state changes.
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));
		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));

		let gate_events: Vec<_> = System::events()
			.into_iter()
			.filter_map(|r| match r.event {
				RuntimeEvent::CognoGate(e) => Some(e),
				_ => None,
			})
			.collect();
		assert_eq!(
			gate_events,
			vec![
				Event::IdentityLinked { who: ALICE, identity: HASH_A },
				Event::Revoked { who: ALICE, identity: HASH_A },
				Event::IdentityLinked { who: ALICE, identity: HASH_A },
			]
		);
	});
}

#[test]
fn post_revoke_rebind_post_id_continuity() {
	// runtime-node gap-10: the cross-pallet narrative. bound → can post → revoke → CANNOT post →
	// rebind (different identity) → can post again, and the microblog post-id counter is
	// CONTINUOUS (a revoke must never reset NextPostId, or post ids would collide after a rebind).
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));

		assert_ok!(post_as(ALICE)); // id 0
		assert_eq!(pallet_microblog::NextPostId::<Test>::get(), 1);

		// Revoke re-locks: ALICE cannot post.
		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		assert_noop!(post_as(ALICE), pallet_microblog::Error::<Test>::NotAllowed);
		// The id counter did NOT reset on revoke.
		assert_eq!(pallet_microblog::NextPostId::<Test>::get(), 1);

		// Rebind ALICE to a DIFFERENT identity → posting unlocks again.
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_B, ALICE, None));
		assert_ok!(post_as(ALICE)); // id 1, NOT a reused 0

		// The newly created post got id 1 (continuous), and id 0 still exists (no collision).
		assert_eq!(pallet_microblog::NextPostId::<Test>::get(), 2);
		assert!(pallet_microblog::Posts::<Test>::get(0).is_some());
		assert!(pallet_microblog::Posts::<Test>::get(1).is_some());
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

		// The capacity row is KEPT (relock-farm guard) but its banked capacity is zeroed (gate-1).
		let row = pallet_microblog::Capacity::<Test>::get(ALICE).expect("row kept");
		assert_eq!(row.cap_last, 0);

		// After revoke the identity is free to be re-bound (to the same or a new account).
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, BOB, None));
		assert_eq!(AccountOf::<Test>::get(HASH_A), Some(BOB));
	});
}

#[test]
fn bind_revoke_rebind_keeps_provider_accounting_balanced() {
	// gate-1/gate-4: the bind/revoke lifecycle is symmetric — bind takes one provider ref, revoke
	// releases it (and zeroes the banked capacity), and a rebind re-takes it. The capacity row is
	// never deleted, so the count returns to baseline across cycles with no leak.
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let providers = |who: u64| frame_system::Account::<Test>::get(who).providers;
		let base = providers(ALICE);

		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));
		assert_eq!(providers(ALICE), base + 1, "bind takes a provider ref");

		// Give ALICE real banked capacity, then revoke.
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 100));
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), ALICE, 1_000));
		assert!(pallet_microblog::Capacity::<Test>::get(ALICE).unwrap().cap_last > 0);

		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		assert_eq!(providers(ALICE), base, "revoke releases the bind provider ref (no leak)");
		let row = pallet_microblog::Capacity::<Test>::get(ALICE).expect("row kept (relock-farm guard)");
		assert_eq!(row.cap_last, 0, "banked capacity zeroed on revoke");

		// Rebind re-takes the provider ref so the rebound account can post feelessly again.
		assert_ok!(CognoGate::link_identity(RuntimeOrigin::root(), HASH_A, ALICE, None));
		assert_eq!(providers(ALICE), base + 1, "rebind re-takes the provider ref");
		assert!(pallet_microblog::Capacity::<Test>::get(ALICE).is_some());
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
