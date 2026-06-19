//! Unit / integration tests for `pallet-cogno-gate` — the M2 identity gate.
//!
//! These run against the real `CognoGate ↔ Microblog ↔ TalkStake` wiring (see `mock.rs`), so
//! they prove the actual gate behaviour: an unbound account cannot post; the shared `do_bind` body
//! (driven via the `bind` test helper) binds 1:1 and unlocks posting; double-binds are rejected on
//! both sides; `revoke` re-locks; and the trustless `link_identity_signed` self-proof is exercised
//! end-to-end against a real wallet fixture (the `link_identity_signed_*` tests).
//!
//! Note: direct dispatch calls bypass the `CheckCapacity` transaction extension (extensions
//! only run in the full tx pipeline), so a bound account posts here without a capacity grant —
//! the feeless/capacity gate is exercised end-to-end by the node acceptance harness. These
//! tests isolate the *identity* gate.

use crate::{mock::*, AccountOf, Error, Event, IdentityHash, PkhOf, ThreadOf, Tombstoned};
use frame_support::{assert_noop, assert_ok, traits::ConstU32, BoundedVec};
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
		assert_ok!(bind(HASH_A, ALICE, None));

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
		assert_ok!(bind(HASH_A, ALICE, None));
		// A second identity cannot be bound to an already-bound account.
		assert_noop!(
			bind(HASH_B, ALICE, None),
			Error::<Test>::AccountAlreadyBound
		);
		assert_eq!(PkhOf::<Test>::get(ALICE), Some(HASH_A)); // unchanged
		assert_eq!(AccountOf::<Test>::get(HASH_B), None);
	});
}

#[test]
fn double_bind_same_identity_to_another_account_is_rejected() {
	new_test_ext().execute_with(|| {
		assert_ok!(bind(HASH_A, ALICE, None));
		// The same Cardano identity cannot be bound to a second account (the Sybil anchor).
		assert_noop!(
			bind(HASH_A, BOB, None),
			Error::<Test>::PkhAlreadyBound
		);
		assert_eq!(AccountOf::<Test>::get(HASH_A), Some(ALICE)); // unchanged
		assert!(!PkhOf::<Test>::contains_key(BOB));
		// BOB still cannot post.
		assert_noop!(post_as(BOB), pallet_microblog::Error::<Test>::NotAllowed);
	});
}

// (Removed `link_identity_requires_follower_origin`: the trusted `FollowerOrigin`-gated
// `link_identity` dispatchable no longer exists — the bind path is the permissionless cryptographic
// `link_identity_signed`, whose origin/authorization is covered by the `link_identity_signed_*` tests.)

#[test]
fn thread_pointer_is_stored_and_length_bounded() {
	new_test_ext().execute_with(|| {
		// A valid 5-byte / 10-hex cogno_v3 pointer is stored.
		let ptr = vec![0x00, 0xe5, 0x99, 0x3f, 0xa3]; // 5 bytes (cf. cogno_v3 #"00e5993fa3")
		assert_ok!(bind(HASH_A, ALICE, Some(ptr.clone())));
		assert_eq!(ThreadOf::<Test>::get(ALICE).map(|b| b.to_vec()), Some(ptr));

		// An over-long pointer (>10 bytes) is rejected without binding.
		let too_long = vec![0u8; 11];
		assert_noop!(
			bind(HASH_B, BOB, Some(too_long)),
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
		assert_ok!(bind(HASH_A, ALICE, Some(ptr.clone())));
		assert_eq!(ThreadOf::<Test>::get(ALICE).map(|b| b.to_vec()), Some(ptr));
		assert_eq!(PkhOf::<Test>::get(ALICE), Some(HASH_A));
	});
}

#[test]
fn thread_pointer_empty_is_accepted_and_stored_empty() {
	// gap-3: Some(vec![]) is at the LOWER boundary (0 ≤ len ≤ 10) — it must succeed and bind.
	// An empty pointer is stored as an empty BoundedVec (Some), distinct from the None path.
	new_test_ext().execute_with(|| {
		assert_ok!(bind(HASH_A, ALICE, Some(vec![])));
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
		assert_ok!(bind(HASH_A, ALICE, None));
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
			bind(HASH_A, ALICE, Some(vec![0u8; 11])),
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
		assert_ok!(bind(HASH_A, ALICE, Some(ptr.clone())));
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
		assert_ok!(bind(HASH_A, ALICE, None));
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
		assert_ok!(bind(HASH_A, ALICE, None));
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
		assert_ok!(bind(HASH_A, ALICE, Some(vec![0xDE, 0xAD])));
		assert!(ThreadOf::<Test>::get(ALICE).is_some());

		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		assert!(ThreadOf::<Test>::get(ALICE).is_none());

		// HASH_A is now tombstoned; bind a FRESH identity (HASH_B) to BOB without a thread pointer.
		assert_ok!(bind(HASH_B, BOB, None));
		assert!(ThreadOf::<Test>::get(BOB).is_none(), "None rebind writes no thread row");
		assert!(ThreadOf::<Test>::get(ALICE).is_none(), "old account stays cleared");
		assert_eq!(AccountOf::<Test>::get(HASH_B), Some(BOB));
	});
}

#[test]
fn tombstone_blocks_reusing_a_revoked_identity() {
	// "Ban means ban": after revoke tombstones the identity, it can NEVER be re-bound — not even to
	// the same account with the same thread pointer (was: rebind-reuse; now a permanent ban).
	new_test_ext().execute_with(|| {
		let ptr = vec![0x00, 0xe5, 0x99, 0x3f, 0xa3];
		assert_ok!(bind(HASH_A, ALICE, Some(ptr.clone())));
		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		// Tombstone: the SAME identity cannot be reused after a ban (permanent), even with its old thread.
		assert_noop!(
			bind(HASH_A, ALICE, Some(ptr.clone())),
			Error::<Test>::IdentityTombstoned
		);
		let _ = ptr;
	});
}

#[test]
fn full_event_audit_trail_for_bind_revoke_rebind() {
	// gap-8: the complete event sequence. A bind→revoke→rebind cycle must fire
	// IdentityLinked, then Revoked, then IdentityLinked again — in that exact order. Guards
	// against an accidental event deletion on any one of the three state changes.
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(bind(HASH_A, ALICE, None));
		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		// HASH_A is tombstoned; the rebind uses a FRESH identity (HASH_B).
		assert_ok!(bind(HASH_B, ALICE, None));

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
				Event::IdentityLinked { who: ALICE, identity: HASH_B },
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
		assert_ok!(bind(HASH_A, ALICE, None));

		assert_ok!(post_as(ALICE)); // id 0
		assert_eq!(pallet_microblog::NextPostId::<Test>::get(), 1);

		// Revoke re-locks: ALICE cannot post.
		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		assert_noop!(post_as(ALICE), pallet_microblog::Error::<Test>::NotAllowed);
		// The id counter did NOT reset on revoke.
		assert_eq!(pallet_microblog::NextPostId::<Test>::get(), 1);

		// Rebind ALICE to a DIFFERENT identity → posting unlocks again.
		assert_ok!(bind(HASH_B, ALICE, None));
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
		assert_ok!(bind(HASH_A, ALICE, None));
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

		// Tombstone ("ban means ban"): the revoked identity is PERMANENTLY banned — it cannot be
		// re-bound to anyone, even via the trusted path.
		assert_noop!(
			bind(HASH_A, BOB, None),
			Error::<Test>::IdentityTombstoned
		);
		assert_eq!(AccountOf::<Test>::get(HASH_A), None);
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

		assert_ok!(bind(HASH_A, ALICE, None));
		assert_eq!(providers(ALICE), base + 1, "bind takes a provider ref");

		// Give ALICE real banked capacity, then revoke.
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 100));
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), ALICE, 1_000));
		assert!(pallet_microblog::Capacity::<Test>::get(ALICE).unwrap().cap_last > 0);

		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), ALICE));
		assert_eq!(providers(ALICE), base, "revoke releases the bind provider ref (no leak)");
		let row = pallet_microblog::Capacity::<Test>::get(ALICE).expect("row kept (relock-farm guard)");
		assert_eq!(row.cap_last, 0, "banked capacity zeroed on revoke");

		// ALICE rebinds to a FRESH identity (HASH_A is tombstoned) — the provider ref is re-taken.
		assert_ok!(bind(HASH_B, ALICE, None));
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
		assert_ok!(bind(HASH_A, ALICE, None));
		assert_noop!(
			CognoGate::revoke(RuntimeOrigin::signed(ALICE), ALICE),
			DispatchError::BadOrigin
		);
		assert!(PkhOf::<Test>::contains_key(ALICE)); // still bound
	});
}

// ── the trustless self-proof (link_identity_signed, D1) ─────────────────────────────────────────────
// A REAL MeshWallet.signData fixture (app/scripts/m2-cip8-fixture.mjs); the verifier itself is unit-tested
// in src/cip8/tests.rs — here we prove the CALL wires verify → genesis-check → 1:1 bind / tombstone.

const SIG: &str = "845869a3012704582073fea80d424276ad0978d4fe5310e8bc2d485f5f6bb3bf87612989f112ad5a7d67616464726573735839009493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e32c728d3861e164cab28cb8f006448139c8f1740ffb8e7aa9e5232dca166686173686564f458cc636f676e6f2d636861696e2f62696e642f76313b67656e657369733d323761663338353730616230373261326137383233326664663436616335653935376561613463343461356339326430366235363435353862666232656431363b6163636f756e743d333033356361336134626436306335356635313035626231386663373636613630333634643032323666373230666665336665333364323964363633313033343b6e6f6e63653d616261626162616261626162616261626162616261626162616261626162616258400cdf9b33e4179a29995b0d0d96fb770c58b54ed570ede16df0d32b2e904efa7687ee2efa0bbc6840ecab99a6c6e20992f1916f41e4ca6b28b4d5b103234cf00e";
const KEY: &str = "a401010327200621582073fea80d424276ad0978d4fe5310e8bc2d485f5f6bb3bf87612989f112ad5a7d";
const GENESIS: &str = "27af38570ab072a2a78232fdf46ac5e957eaa4c44a5c92d06b564558bfb2ed16";
const PROOF_ACCOUNT: &str = "3035ca3a4bd60c55f5105bb18fc766a60364d0226f720ffe3fe33d29d6631034";

fn hx(s: &str) -> Vec<u8> {
	(0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}
/// Pin BlockHash[0] to the fixture's genesis so the on-chain anti-cross-chain check passes.
fn set_genesis(g: &str) {
	frame_system::BlockHash::<Test>::insert(0u64, sp_core::H256::from_slice(&hx(g)));
}
fn proof() -> (BoundedVec<u8, ConstU32<512>>, BoundedVec<u8, ConstU32<128>>) {
	(hx(SIG).try_into().expect("cose_sign1 fits 512"), hx(KEY).try_into().expect("cose_key fits 128"))
}
/// The u64 the mock decodes the proof's 32-byte committed account into (first 8 bytes, LE).
fn bound_account() -> u64 {
	u64::from_le_bytes(hx(PROOF_ACCOUNT)[..8].try_into().unwrap())
}

#[test]
fn link_identity_signed_binds_a_real_wallet_proof() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		set_genesis(GENESIS);
		let (s, k) = proof();
		// ANY signed submitter (ALICE pays the fee); the bound account is the one the PROOF commits — the
		// submitter cannot retarget it.
		assert_ok!(CognoGate::link_identity_signed(RuntimeOrigin::signed(ALICE), s, k, None));
		let acct = bound_account();
		let identity = PkhOf::<Test>::get(acct).expect("the committed account is now bound");
		assert_eq!(AccountOf::<Test>::get(identity), Some(acct), "1:1 both ways via the verified proof");
		System::assert_has_event(Event::IdentityLinked { who: acct, identity }.into());
	});
}

#[test]
fn link_identity_signed_rejects_a_wrong_genesis() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// BlockHash[0] is left at the default (NOT the fixture's chain) ⇒ anti-cross-chain reject.
		let (s, k) = proof();
		assert_noop!(
			CognoGate::link_identity_signed(RuntimeOrigin::signed(ALICE), s, k, None),
			Error::<Test>::WrongGenesis
		);
		assert!(AccountOf::<Test>::iter().next().is_none(), "nothing bound on a rejected proof");
	});
}

#[test]
fn link_identity_signed_rejects_a_garbage_proof() {
	new_test_ext().execute_with(|| {
		set_genesis(GENESIS);
		let bad: BoundedVec<u8, ConstU32<512>> = vec![0xde, 0xad, 0xbe, 0xef].try_into().unwrap();
		let key: BoundedVec<u8, ConstU32<128>> = vec![0x00].try_into().unwrap();
		assert_noop!(
			CognoGate::link_identity_signed(RuntimeOrigin::signed(ALICE), bad, key, None),
			Error::<Test>::ProofInvalid
		);
	});
}

#[test]
fn link_identity_signed_is_not_callable_unsigned() {
	new_test_ext().execute_with(|| {
		set_genesis(GENESIS);
		let (s, k) = proof();
		// Permissionless ≠ origin-free: it is a SIGNED call (the fee payer). Root/none is rejected.
		assert_noop!(
			CognoGate::link_identity_signed(RuntimeOrigin::root(), s, k, None),
			DispatchError::BadOrigin
		);
	});
}

#[test]
fn revoke_tombstones_and_blocks_a_signed_rebind() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		set_genesis(GENESIS);
		let (s, k) = proof();
		assert_ok!(CognoGate::link_identity_signed(RuntimeOrigin::signed(ALICE), s.clone(), k.clone(), None));
		let acct = bound_account();
		let identity = PkhOf::<Test>::get(acct).unwrap();

		// Operator ban: revoke tombstones the identity permanently.
		assert_ok!(CognoGate::revoke(RuntimeOrigin::root(), acct));
		assert!(Tombstoned::<Test>::contains_key(identity), "revoke tombstones the identity");

		// Replaying the SAME (eternally-valid) wallet proof cannot resurrect the binding.
		assert_noop!(
			CognoGate::link_identity_signed(RuntimeOrigin::signed(ALICE), s, k, None),
			Error::<Test>::IdentityTombstoned
		);
	});
}
