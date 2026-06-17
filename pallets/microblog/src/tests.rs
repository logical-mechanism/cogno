//! Unit tests for `pallet-microblog` (plain posting + the M2c talk-capacity meter).
//!
//! Note: the M0 post/delete tests call the dispatchables directly, which BYPASSES the
//! `CheckCapacity` transaction extension (extensions only run in the full tx pipeline) — so
//! they remain valid unchanged. The capacity *gate* (ExhaustsResources at the pool) and the
//! *feeless* fee waiver are exercised end-to-end by the node acceptance harness; here we unit
//! test the pure bucket math + `force_set_capacity` + the anti-farm invariants.

use crate::{mock::*, ByAuthor, Capacity, Error, Event, NextPostId, Posts};
use frame_support::{assert_noop, assert_ok};
use sp_runtime::DispatchError;

#[test]
fn post_and_read_works() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(Microblog::post_message(
			RuntimeOrigin::signed(1),
			b"gm cogno".to_vec(),
			None
		));

		assert_eq!(NextPostId::<Test>::get(), 1);
		let post = Posts::<Test>::get(0).expect("post 0 should exist");
		assert_eq!(post.author, 1);
		assert_eq!(post.text.to_vec(), b"gm cogno".to_vec());
		assert_eq!(post.parent, None);
		assert_eq!(ByAuthor::<Test>::get(1).to_vec(), vec![0]);
		System::assert_last_event(Event::PostCreated { id: 0, author: 1 }.into());
	});
}

#[test]
fn unbound_identity_cannot_post() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// Deny account 1 at the identity gate → post_message is rejected with NotAllowed,
		// and (assert_noop! proves) no id is consumed. The real deny-by-default gate is
		// integration-tested in pallet-cogno-gate; here we prove the gate is wired into the body.
		crate::mock::deny_identity(1);
		assert_noop!(
			Microblog::post_message(RuntimeOrigin::signed(1), b"gm".to_vec(), None),
			Error::<Test>::NotAllowed
		);
		assert_eq!(NextPostId::<Test>::get(), 0);
	});
}

#[test]
fn replies_carry_parent() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(Microblog::post_message(RuntimeOrigin::signed(1), b"root".to_vec(), None));
		assert_ok!(Microblog::post_message(RuntimeOrigin::signed(2), b"reply".to_vec(), Some(0)));
		assert_eq!(Posts::<Test>::get(1).unwrap().parent, Some(0));
	});
}

#[test]
fn too_long_is_rejected() {
	new_test_ext().execute_with(|| {
		let big = vec![0u8; 513]; // MaxLength = 512
		assert_noop!(
			Microblog::post_message(RuntimeOrigin::signed(1), big, None),
			Error::<Test>::TooLong
		);
		assert_eq!(NextPostId::<Test>::get(), 0);
	});
}

#[test]
fn delete_post_works_and_guards_author() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(Microblog::post_message(RuntimeOrigin::signed(1), b"hello".to_vec(), None));

		// A non-author cannot delete.
		assert_noop!(
			Microblog::delete_post(RuntimeOrigin::signed(2), 0),
			Error::<Test>::NotAuthor
		);
		// Deleting a missing id fails.
		assert_noop!(
			Microblog::delete_post(RuntimeOrigin::signed(1), 99),
			Error::<Test>::NotFound
		);

		// The author can delete; the post and its index entry are removed.
		assert_ok!(Microblog::delete_post(RuntimeOrigin::signed(1), 0));
		assert!(Posts::<Test>::get(0).is_none());
		assert!(ByAuthor::<Test>::get(1).is_empty());
		System::assert_last_event(Event::PostDeleted { id: 0 }.into());
	});
}

#[test]
fn too_many_posts_is_rejected_without_consuming_id() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// MaxPostsPerAuthor = 8 in the mock.
		for _ in 0..8u64 {
			assert_ok!(Microblog::post_message(RuntimeOrigin::signed(1), vec![b'x'], None));
		}
		assert_eq!(ByAuthor::<Test>::get(1).len(), 8);
		assert_eq!(NextPostId::<Test>::get(), 8);

		// The 9th overflows the author index — rejected, and (assert_noop! proves) no
		// storage changed, so the id counter was not consumed.
		assert_noop!(
			Microblog::post_message(RuntimeOrigin::signed(1), vec![b'y'], None),
			Error::<Test>::TooManyPosts
		);
		assert_eq!(NextPostId::<Test>::get(), 8);

		// A different author is unaffected.
		assert_ok!(Microblog::post_message(RuntimeOrigin::signed(2), vec![b'z'], None));
		assert_eq!(NextPostId::<Test>::get(), 9);
	});
}

// ── talk-capacity meter (mock constants: cap = min(weight·10, 5000); rate = weight·1/block;
//    cost = 100 + 1·len) ───────────────────────────────────────────────────────────────────

#[test]
fn first_touch_capacity_is_zero() {
	new_test_ext().execute_with(|| {
		// Weighted but never bound: cap is positive, but the bucket has no row yet → 0.
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), 1, 100)); // cap would be 1000
		assert_eq!(Capacity::<Test>::get(1), None);
		assert_eq!(Microblog::current_capacity(&1, 5), 0); // None ⇒ 0 (charges up from empty)
	});
}

#[test]
fn post_cost_is_base_plus_per_byte() {
	new_test_ext().execute_with(|| {
		assert_eq!(Microblog::post_cost(0), 100);
		assert_eq!(Microblog::post_cost(10), 110);
		assert_eq!(Microblog::post_cost(512), 612);
	});
}

#[test]
fn capacity_regenerates_then_clamps_to_cap() {
	new_test_ext().execute_with(|| {
		System::set_block_number(10);
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), 1, 100)); // cap=1000, rate=100/block
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 1, 0)); // empty, dated @10
		assert_eq!(Microblog::current_capacity(&1, 10), 0);
		// 3 blocks: regen = 100·1·3 = 300.
		assert_eq!(Microblog::current_capacity(&1, 13), 300);
		// 20 blocks: 100·20 = 2000, clamped to cap = 1000.
		assert_eq!(Microblog::current_capacity(&1, 30), 1000);
	});
}

#[test]
fn consume_reduces_banked_capacity() {
	new_test_ext().execute_with(|| {
		System::set_block_number(10);
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), 1, 100));
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 1, 1000)); // full
		assert_eq!(Microblog::current_capacity(&1, 10), 1000);
		// Spend a 5-byte post: cost = 100 + 5 = 105.
		Microblog::consume(&1, 10, Microblog::post_cost(5));
		assert_eq!(Microblog::current_capacity(&1, 10), 895);
	});
}

#[test]
fn ceiling_caps_the_linear_curve() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// weight 1000 → linear cap 10_000, but Ceiling = 5000 → cap = 5000.
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), 1, 1000));
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 1, 9999));
		assert_eq!(Microblog::current_capacity(&1, 1), 5000); // clamped to the ceiling
	});
}

#[test]
fn unlock_clamps_capacity_to_zero() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), 1, 100));
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 1, 1000));
		assert_eq!(Microblog::current_capacity(&1, 1), 1000);
		// Full unlock: weight → 0 makes cap = 0, so current clamps to min(0, …) = 0 — even though
		// the banked cap_last is 1000 and the row is NOT deleted.
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), 1, 0));
		assert_eq!(Microblog::current_capacity(&1, 5), 0);
		assert!(Capacity::<Test>::get(1).is_some()); // row persists (relock-farm guard)
	});
}

#[test]
fn on_first_bind_is_idempotent_no_remint() {
	new_test_ext().execute_with(|| {
		System::set_block_number(10);
		Microblog::on_first_bind(&1); // stamps an empty row dated @10 + a provider ref
		let row = Capacity::<Test>::get(1).expect("row exists");
		assert_eq!(row.cap_last, 0);
		assert_eq!(row.last_block, 10);
		// A later call (e.g. after an unlock/relock) must NOT re-stamp/re-date the row.
		System::set_block_number(50);
		Microblog::on_first_bind(&1);
		let row2 = Capacity::<Test>::get(1).expect("row still exists");
		assert_eq!(row2.last_block, 10); // unchanged → no fresh bucket on relock
		assert_eq!(row2.cap_last, 0);
	});
}

#[test]
fn set_stake_does_not_credit_banked_capacity() {
	new_test_ext().execute_with(|| {
		System::set_block_number(10);
		Microblog::on_first_bind(&1); // cap_last 0 @10
		// Raising weight lifts the future cap/rate but must not retroactively credit cap_last.
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), 1, 100));
		let row = Capacity::<Test>::get(1).expect("row exists");
		assert_eq!(row.cap_last, 0); // going-forward-only
		assert_eq!(row.last_block, 10);
	});
}

#[test]
fn force_set_capacity_is_gated() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			Microblog::force_set_capacity(RuntimeOrigin::signed(1), 1, 100),
			DispatchError::BadOrigin,
		);
		assert_eq!(Capacity::<Test>::get(1), None);
	});
}

// ── DR-06 property test ─────────────────────────────────────────────────────────────────────

/// **DR-06 — clamp-latency ≤ grant-latency (the asymmetric-safety property).** The follower's
/// failure modes are asymmetric: a slow GRANT is safe-but-stale, but a slow CLAMP leaves a
/// stale-positive weight — voice no longer backed by locked ADA — which is the dangerous one
/// (`L2-follower.md` §8.2). So a clamp (weight → 0 on unlock) must take effect no slower than a
/// grant. On L3 this falls out of the capacity math: a grant only raises the future ceiling and
/// must regenerate over the window (latency > 0), whereas a clamp drops usable capacity to 0 on
/// the very next read (latency 0). We measure both latencies directly across a sweep of weights
/// and assert `clamp_latency == 0 ≤ grant_latency`.
#[test]
fn clamp_latency_at_most_grant_latency_property() {
	new_test_ext().execute_with(|| {
		// mock constants: cap = min(weight·10, 5000), rate = weight·1 / block.
		for &weight in &[1u128, 10, 50, 100, 400] {
			let who = weight as u64; // distinct account per case
			let t0 = 1u64;
			System::set_block_number(t0);
			Microblog::on_first_bind(&who); // empty bucket, dated @ t0

			// ── GRANT: raise weight from 0; usable capacity must NOT jump — it regenerates. ──
			assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), who, weight));
			let cap = core::cmp::min(weight.saturating_mul(10), 5000);
			assert!(cap > 0);
			assert_eq!(Microblog::current_capacity(&who, t0), 0, "a grant is never instantaneous");
			let mut grant_latency = 0u64;
			while Microblog::current_capacity(&who, t0 + grant_latency) < cap {
				grant_latency += 1;
				assert!(grant_latency < 1_000_000, "bucket must fill in finite time");
			}
			assert!(grant_latency > 0, "grant takes > 0 blocks to fully take effect");

			// ── CLAMP: fill the bucket, then unlock (weight → 0); capacity drops to 0 at once. ──
			let tf = t0 + grant_latency;
			assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), who, cap));
			assert_eq!(Microblog::current_capacity(&who, tf), cap);
			assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), who, 0));
			let mut clamp_latency = 0u64;
			while Microblog::current_capacity(&who, tf + clamp_latency) > 0 {
				clamp_latency += 1;
				assert!(clamp_latency < 1_000_000, "bucket must clamp in finite time");
			}
			assert_eq!(clamp_latency, 0, "clamp is instantaneous (same-block)");

			// The asymmetric-safety property: the dangerous direction is never the slower one.
			assert!(clamp_latency <= grant_latency);
		}
	});
}
