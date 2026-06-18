//! Unit tests for `pallet-talk-stake`.

use crate::{mock::*, AllowedStake, Error, Event};
use frame_support::{assert_noop, assert_ok};
use sp_runtime::DispatchError;

const ALICE: u64 = 1;

#[test]
fn unbound_account_reads_zero() {
	new_test_ext().execute_with(|| {
		// ValueQuery: an account that was never set reads 0 weight.
		assert_eq!(AllowedStake::<Test>::get(ALICE), 0);
	});
}

#[test]
fn root_can_set_stake_and_overwrite() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 10_000_000));
		assert_eq!(AllowedStake::<Test>::get(ALICE), 10_000_000);
		System::assert_last_event(Event::StakeSet { who: ALICE, weight: 10_000_000 }.into());

		// Idempotent overwrite (reorg-safe re-derive): a later set replaces, never sums.
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 25_000_000));
		assert_eq!(AllowedStake::<Test>::get(ALICE), 25_000_000);

		// Full unlock writes weight = 0 (the row stays; capacity clamps elsewhere).
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 0));
		assert_eq!(AllowedStake::<Test>::get(ALICE), 0);
	});
}

#[test]
fn set_stake_rejects_weight_above_max() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// MaxStakeWeight = 100_000_000 in the mock.
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 100_000_000)); // exactly the cap
		assert_eq!(AllowedStake::<Test>::get(ALICE), 100_000_000);
		// One over the cap is rejected (stake-1) and (assert_noop proves) no write happened.
		assert_noop!(
			TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 100_000_001),
			Error::<Test>::WeightTooHigh
		);
		assert_eq!(AllowedStake::<Test>::get(ALICE), 100_000_000); // unchanged
	});
}

#[test]
fn signed_origin_cannot_set_stake() {
	new_test_ext().execute_with(|| {
		// Only SetStakeOrigin (root in the mock) may write weight.
		assert_noop!(
			TalkStake::set_stake(RuntimeOrigin::signed(ALICE), ALICE, 10_000_000),
			DispatchError::BadOrigin,
		);
		assert_eq!(AllowedStake::<Test>::get(ALICE), 0);
	});
}

// ── DR-06 property tests ────────────────────────────────────────────────────────────────────

/// **DR-06 — largest-wins / never-sum (the L3 side).** `set_stake` is an idempotent OVERWRITE; it
/// NEVER accumulates. That is the on-chain guarantee that makes the follower's off-chain
/// largest-wins / never-sum aggregation (`L2-follower.md` §6.4, DR-34) safe: whatever sequence of
/// per-vault weights the follower folds for an identity, it submits exactly ONE value and L3
/// stores precisely that — never the running sum (no live "stake-splitting double-dip"). We sweep
/// several re-observation sequences a follower might emit (raise, lower, repeated reorg-safe
/// re-derives, unlock) and assert: after every write the stored weight equals the just-written
/// value; and for any sequence with ≥2 nonzero observations the stored weight is strictly below
/// the naive sum (proving no accumulation, independent of read order).
#[test]
fn set_stake_overwrites_never_sums_property() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let sequences: &[&[u128]] = &[
			&[10_000_000],                  // single observation
			&[10_000_000, 25_000_000],      // raise: follower's largest-wins picks the larger vault
			&[25_000_000, 10_000_000],      // lower: a re-observed smaller vault
			&[5, 5, 5],                     // repeated identical re-derives (reorg-safe, idempotent)
			&[100, 200, 50, 175, 300],      // arbitrary re-observation order
			&[40_000_000, 0],               // unlock (final clamp to zero)
		];
		for (i, seq) in sequences.iter().enumerate() {
			let who = i as u64 + 1;
			let mut running_sum = 0u128;
			for &w in seq.iter() {
				assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), who, w));
				running_sum = running_sum.saturating_add(w);
				// Invariant after EVERY write: stored == just-written, never the accumulation.
				assert_eq!(AllowedStake::<Test>::get(who), w);
			}
			let last = *seq.last().unwrap();
			assert_eq!(AllowedStake::<Test>::get(who), last);
			// never-sum: with ≥2 nonzero observations, the stored weight is strictly below the sum.
			if seq.iter().filter(|&&w| w > 0).count() >= 2 {
				assert!(
					last < running_sum,
					"stored weight must never be the sum of the observations (no double-dip)"
				);
			}
		}
	});
}
