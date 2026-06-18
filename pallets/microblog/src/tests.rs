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
fn post_cost_saturates_safely_at_the_boundary() {
	new_test_ext().execute_with(|| {
		// At the MaxLength boundary (mock: BaseCost 100 + PerByteCost 1·512) the cost is exact and
		// well clear of overflow — the spam gate never silently mis-prices a max-length post.
		assert_eq!(Microblog::post_cost(512), 612);
		// post_cost is computed for u32::MAX bytes (impossible at the pool given the MaxLength gate,
		// but the formula uses saturating arithmetic): with PerByteCost 1 the product is exact and
		// does NOT saturate (well under u128::MAX), so we get the precise linear cost — proving the
		// saturating_mul is correct, not silently clamping a legitimate value.
		let huge = u32::MAX; // 4_294_967_295
		assert_eq!(Microblog::post_cost(huge), 100u128 + huge as u128);
		assert!(Microblog::post_cost(huge) < u128::MAX, "no saturation for the mock's PerByteCost=1");
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
fn zero_elapsed_blocks_no_regen() {
	new_test_ext().execute_with(|| {
		System::set_block_number(10);
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), 1, 100)); // rate 100/block
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 1, 250)); // banked @10
		// Reading at the SAME block as the last touch (elapsed == 0) returns cap_last verbatim —
		// no regen tick is credited within a block (this is the same-block-post anti-burst guard).
		assert_eq!(Microblog::current_capacity(&1, 10), 250);
	});
}

#[test]
fn capacity_regen_is_linear_per_block() {
	new_test_ext().execute_with(|| {
		System::set_block_number(10);
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), 1, 5)); // rate 5/block, cap min(50,5000)=50
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 1, 0)); // empty, dated @10
		// Exactly one block ⇒ exactly one regen tick of weight·RegenPerBlock = 5 (not a constant
		// offset, not exponential): the curve is linear at the per-block rate.
		assert_eq!(Microblog::current_capacity(&1, 11), 5);
		// Linear across multiple blocks: 5·k for k = 1..=10 until the ceiling (50) clamps it.
		for k in 1..=10u64 {
			let expected = core::cmp::min(5 * k as u128, 50);
			assert_eq!(Microblog::current_capacity(&1, 10 + k), expected, "block +{k} regen is linear");
		}
		// Past the fill point it stays clamped at the ceiling, never overshoots.
		assert_eq!(Microblog::current_capacity(&1, 100), 50);
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

#[test]
fn force_set_capacity_clamps_to_stake_backed_ceiling() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// No stake ⇒ ceiling 0 ⇒ a force cannot mint capacity unbacked by locked stake (microblog-3).
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 1, 1_000));
		assert_eq!(Capacity::<Test>::get(1).unwrap().cap_last, 0);
		System::assert_last_event(Event::CapacityForced { who: 1, cap_last: 0 }.into());

		// weight 100 ⇒ ceiling min(100·10, 5000) = 1000 ⇒ a force above it is clamped to 1000.
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), 2, 100));
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 2, 9_999));
		assert_eq!(Capacity::<Test>::get(2).unwrap().cap_last, 1_000);

		// A force within the ceiling is stored verbatim (the legitimate priming path).
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 2, 400));
		assert_eq!(Capacity::<Test>::get(2).unwrap().cap_last, 400);

		// Boundary: cap_last == ceiling EXACTLY passes through unclamped (not clamped to < ceiling).
		// weight 100 ⇒ ceiling 1000; force exactly 1000.
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 2, 1_000));
		assert_eq!(Capacity::<Test>::get(2).unwrap().cap_last, 1_000);
		System::assert_last_event(Event::CapacityForced { who: 2, cap_last: 1_000 }.into());

		// Boundary: ceiling + 1 is clamped down to exactly the ceiling (off-by-one guard).
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 2, 1_001));
		assert_eq!(Capacity::<Test>::get(2).unwrap().cap_last, 1_000);
		// The event reports the CLAMPED value, never the requested over-ceiling input.
		System::assert_last_event(Event::CapacityForced { who: 2, cap_last: 1_000 }.into());
	});
}

// ── bind/revoke lifecycle on microblog's own `OnIdentityBind` impl (provider-ref accounting) ───
// pallet-cogno-gate drives these via its `OnBind` Config type; here we exercise microblog's side
// directly so its provider-ref inc/dec and the never-delete relock-farm guard are covered without
// the cross-pallet plumbing. (Audit gaps 1, 2, and the on_bind/on_revoke logging paths.)

#[test]
fn on_bind_takes_a_provider_ref_and_is_idempotent_on_the_row() {
	use crate::OnIdentityBind;
	new_test_ext().execute_with(|| {
		System::set_block_number(10);
		let providers = |who: u64| frame_system::Account::<Test>::get(who).providers;
		let base = providers(1);

		<Microblog as OnIdentityBind<u64>>::on_bind(&1);
		// The provider ref is taken so the bound account's first feeless post survives CheckNonce.
		assert_eq!(providers(1), base + 1, "on_bind takes exactly one provider ref");
		let row = Capacity::<Test>::get(1).expect("on_bind primes the (empty, dated) row");
		assert_eq!(row.cap_last, 0);
		assert_eq!(row.last_block, 10);

		// A second on_bind (e.g. a relock path) re-takes a provider ref (the trait is symmetric per
		// bind), but must NOT re-mint the capacity bucket — the row stays empty and dated @10, so a
		// relock cannot read a None first-touch and start a fresh full-charging bucket.
		System::set_block_number(50);
		<Microblog as OnIdentityBind<u64>>::on_bind(&1);
		let row2 = Capacity::<Test>::get(1).expect("row still exists");
		assert_eq!(row2.last_block, 10, "row is NOT re-dated on a second bind (relock-farm guard)");
		assert_eq!(row2.cap_last, 0, "row is NOT re-minted on a second bind");
	});
}

#[test]
fn bind_revoke_rebind_relock_farm_guard() {
	use crate::OnIdentityBind;
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let providers = |who: u64| frame_system::Account::<Test>::get(who).providers;
		let base = providers(1);

		// Bind: provider ref +1, empty row dated @1.
		<Microblog as OnIdentityBind<u64>>::on_bind(&1);
		assert_eq!(providers(1), base + 1, "bind takes a provider ref");

		// Give the account real banked capacity (weight 100 ⇒ ceiling 1000).
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), 1, 100));
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 1, 1_000));
		System::set_block_number(20);
		assert!(Microblog::current_capacity(&1, 20) > 0, "banked capacity is live before revoke");

		// Revoke: provider ref released (back to baseline, no leak), capacity zeroed, ROW KEPT.
		<Microblog as OnIdentityBind<u64>>::on_revoke(&1);
		assert_eq!(providers(1), base, "revoke releases the bind provider ref (no leak)");
		let row = Capacity::<Test>::get(1).expect("row kept on revoke (relock-farm guard)");
		assert_eq!(row.cap_last, 0, "banked capacity zeroed on revoke");
		assert_eq!(row.last_block, 20, "revoke re-dates the zeroed row to now");
		// Capacity is observably zero even though weight is still 100 (the row was zeroed).
		assert_eq!(Microblog::current_capacity(&1, 20), 0, "no usable capacity right after revoke");

		// Rebind: provider ref re-taken, but the KEPT row must NOT be re-minted into a fresh full
		// bucket — on_first_bind is a no-op because the row already exists. This is the relock-farm
		// guard: a bind/revoke/rebind cycle cannot manufacture a fresh first-touch bucket.
		System::set_block_number(30);
		<Microblog as OnIdentityBind<u64>>::on_bind(&1);
		assert_eq!(providers(1), base + 1, "rebind re-takes the provider ref");
		let row2 = Capacity::<Test>::get(1).expect("row still exists after rebind");
		assert_eq!(row2.cap_last, 0, "rebind does NOT re-mint a fresh bucket");
		assert_eq!(row2.last_block, 20, "rebind does NOT re-date the kept row (no relock first-touch)");
	});
}

#[test]
fn on_revoke_without_a_row_releases_ref_and_is_a_noop_on_capacity() {
	use crate::OnIdentityBind;
	new_test_ext().execute_with(|| {
		System::set_block_number(5);
		let providers = |who: u64| frame_system::Account::<Test>::get(who).providers;
		let base = providers(1);

		// A bind/revoke on an account that was bound (took a ref) but never had a force-primed row
		// beyond the empty one: revoke must still balance the ref and never create a row from nothing.
		<Microblog as OnIdentityBind<u64>>::on_bind(&1); // row created (empty), ref +1
		assert!(Capacity::<Test>::get(1).is_some());
		<Microblog as OnIdentityBind<u64>>::on_revoke(&1);
		assert_eq!(providers(1), base, "ref balanced back to baseline");
		// Row is kept and zeroed (never deleted) — the relock-farm guard.
		assert_eq!(Capacity::<Test>::get(1).expect("row kept").cap_last, 0);

		// A second revoke is a clean no-op on capacity (the row stays zeroed) — it does not panic and
		// does not create or mutate the bucket beyond keeping it at zero. (dec_providers may fail at
		// baseline; on_revoke is best-effort and logs rather than aborting.)
		let providers_before = providers(1);
		<Microblog as OnIdentityBind<u64>>::on_revoke(&1);
		assert_eq!(Capacity::<Test>::get(1).expect("row still kept").cap_last, 0);
		// The capacity row is unchanged by a redundant revoke.
		assert!(providers(1) <= providers_before, "redundant revoke never inflates the provider ref");
	});
}

// ── CheckCapacity transaction extension — the WHOLE feeless anti-spam budget (microblog-1) ──────
// The dispatchable tests above bypass the extension (it only runs in the full tx pipeline), so the
// gate itself was previously untested. These drive validate / post_dispatch_details directly.
mod capacity_extension {
	use super::*;
	use crate::CheckCapacity;
	use frame_support::dispatch::{GetDispatchInfo, PostDispatchInfo};
	use sp_runtime::traits::{TransactionExtension, TxBaseImplication};
	use sp_runtime::transaction_validity::{
		InvalidTransaction, TransactionSource, TransactionValidityError,
	};

	type Ext = CheckCapacity<Test>;

	fn post_call(text: Vec<u8>) -> RuntimeCall {
		RuntimeCall::Microblog(crate::Call::post_message { text, parent: None })
	}

	/// Run `validate` for `who`; on success return (priority, the carried Pre).
	fn validate(
		who: u64,
		call: &RuntimeCall,
	) -> Result<(u64, crate::Pre<Test>), TransactionValidityError> {
		let info = call.get_dispatch_info();
		Ext::new()
			.validate(
				RuntimeOrigin::signed(who),
				call,
				&info,
				0usize,
				(),
				&TxBaseImplication(()),
				TransactionSource::External,
			)
			.map(|(vt, pre, _origin)| (vt.priority, pre))
	}

	/// Run `post_dispatch_details` with the given dispatch result.
	fn post_dispatch(pre: crate::Pre<Test>, result: sp_runtime::DispatchResult) {
		let info = post_call(vec![]).get_dispatch_info();
		<Ext as TransactionExtension<RuntimeCall>>::post_dispatch_details(
			pre,
			&info,
			&PostDispatchInfo::default(),
			0usize,
			&result,
		)
		.expect("post_dispatch_details ok");
	}

	fn prime(who: u64, weight: u128, cap: u128) {
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), who, weight));
		assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), who, cap));
	}

	#[test]
	fn over_budget_post_rejected_at_pool() {
		new_test_ext().execute_with(|| {
			System::set_block_number(10);
			prime(1, 100, 50); // cap ceiling 1000, but bucket only 50 < cost(5)=105
			let err = validate(1, &post_call(b"hello".to_vec())).map(|_| ()).unwrap_err();
			assert_eq!(err, TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources));
		});
	}

	#[test]
	fn affordable_post_passes_priority_and_consumes_exact_cost() {
		new_test_ext().execute_with(|| {
			System::set_block_number(10);
			prime(1, 100, 1_000); // full bucket
			let (priority, pre) = validate(1, &post_call(b"hello".to_vec())).expect("valid");
			// priority == remaining headroom == have(1000) - need(105)
			assert_eq!(priority, 895);
			post_dispatch(pre, Ok(()));
			// exactly post_cost(5) = 105 debited
			assert_eq!(Microblog::current_capacity(&1, 10), 895);
		});
	}

	#[test]
	fn second_same_block_post_is_rejected() {
		new_test_ext().execute_with(|| {
			System::set_block_number(10);
			prime(1, 100, 150); // affords one 105-cost post, not two (no same-block regen)
			let (_p, pre) = validate(1, &post_call(b"hello".to_vec())).expect("1st valid");
			post_dispatch(pre, Ok(())); // 150 - 105 = 45 left
			let err = validate(1, &post_call(b"hello".to_vec())).map(|_| ()).unwrap_err();
			assert_eq!(err, TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources));
		});
	}

	#[test]
	fn over_length_post_rejected_at_pool_before_metering() {
		new_test_ext().execute_with(|| {
			System::set_block_number(1);
			prime(1, 1_000, 5_000); // plenty of capacity (so only the length check can reject)
			let big = vec![0u8; 513]; // > MaxLength 512
			let err = validate(1, &post_call(big)).map(|_| ()).unwrap_err();
			// Call (malformed), NOT ExhaustsResources — it must not be retried as merely over-budget.
			assert_eq!(err, TransactionValidityError::Invalid(InvalidTransaction::Call));
		});
	}

	#[test]
	fn non_post_calls_pass_through_without_consuming() {
		new_test_ext().execute_with(|| {
			System::set_block_number(10);
			prime(1, 100, 1_000);
			// delete_post is not metered: validate passes and post_dispatch consumes nothing.
			let call = RuntimeCall::Microblog(crate::Call::delete_post { id: 0 });
			let (_p, pre) = validate(1, &call).expect("non-post passes");
			post_dispatch(pre, Ok(()));
			assert_eq!(Microblog::current_capacity(&1, 10), 1_000); // unchanged
		});
	}

	#[test]
	fn capacity_is_consumed_even_when_the_post_body_fails() {
		new_test_ext().execute_with(|| {
			System::set_block_number(10);
			prime(1, 100, 1_000);
			let (_p, pre) = validate(1, &post_call(b"hello".to_vec())).expect("valid");
			// A failed dispatch (e.g. TooManyPosts) must STILL burn capacity — else a doomed post is
			// free spam. post_dispatch ignores the dispatch result by design.
			let failed: sp_runtime::DispatchResult = Err(crate::Error::<Test>::TooManyPosts.into());
			post_dispatch(pre, failed);
			assert_eq!(Microblog::current_capacity(&1, 10), 895);
		});
	}

	#[test]
	fn capacity_exactly_equal_to_cost_passes_with_zero_priority() {
		new_test_ext().execute_with(|| {
			System::set_block_number(10);
			// Boundary: banked capacity == post cost EXACTLY. cost(5) = 105; prime exactly 105.
			prime(1, 100, 105);
			let (priority, pre) = validate(1, &post_call(b"hello".to_vec())).expect("have == need is valid");
			// priority = have - need = 0 (the inequality is `have < need`, so equality passes). An
			// off-by-one (`have <= need`) would reject here, or an underflow would wrap to u64::MAX.
			assert_eq!(priority, 0, "exact-cost post has zero remaining-headroom priority");
			// post_dispatch debits the exact cost, draining the bucket to precisely 0 (no underflow).
			post_dispatch(pre, Ok(()));
			assert_eq!(Microblog::current_capacity(&1, 10), 0);
		});
	}

	#[test]
	fn one_unit_short_of_cost_is_rejected_at_pool() {
		new_test_ext().execute_with(|| {
			System::set_block_number(10);
			// Boundary the other side of equality: have == need - 1 ⇒ rejected (have < need).
			prime(1, 100, 104); // cost(5) = 105
			let err = validate(1, &post_call(b"hello".to_vec())).map(|_| ()).unwrap_err();
			assert_eq!(err, TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources));
		});
	}

	#[test]
	fn unbound_account_passes_extension_validate_but_fails_dispatchable() {
		new_test_ext().execute_with(|| {
			System::set_block_number(10);
			// Two-layer gate: the CheckCapacity extension does NOT consult the identity gate — it
			// only checks length + capacity. So an account that is DENIED at the identity gate but has
			// capacity passes validate() (the capacity gate is satisfied)…
			prime(1, 100, 1_000);
			crate::mock::deny_identity(1);
			let (_priority, pre) = validate(1, &post_call(b"hello".to_vec()))
				.expect("extension validate ignores the identity gate");
			// …yet the dispatchable BODY rejects it with NotAllowed (the authoritative Sybil gate).
			assert_noop!(
				Microblog::post_message(RuntimeOrigin::signed(1), b"hello".to_vec(), None),
				crate::Error::<Test>::NotAllowed
			);
			// And capacity is still consumed by post_dispatch even though the body would reject —
			// the extension is identity-blind by design (capacity is spent on inclusion regardless).
			post_dispatch(pre, Err(crate::Error::<Test>::NotAllowed.into()));
			assert_eq!(Microblog::current_capacity(&1, 10), 895);
		});
	}

	#[test]
	fn unlocked_account_cannot_post_even_with_banked_capacity() {
		new_test_ext().execute_with(|| {
			System::set_block_number(10);
			// Prime a full bucket, then UNLOCK (weight → 0). The banked cap_last (1000) is non-zero
			// and the row is NOT deleted, but the ceiling drops to 0 so current_capacity clamps to 0.
			prime(1, 100, 1_000);
			assert_eq!(Microblog::current_capacity(&1, 10), 1_000);
			assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), 1, 0)); // full unlock ⇒ ceiling 0
			assert!(Capacity::<Test>::get(1).is_some(), "row persists (relock-farm guard)");

			// A post is now rejected at the pool with ExhaustsResources — NOT because the banked
			// cap_last is zero (it isn't), but because the stake-backed ceiling collapsed to 0.
			let err = validate(1, &post_call(b"hello".to_vec())).map(|_| ()).unwrap_err();
			assert_eq!(err, TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources));
		});
	}
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
