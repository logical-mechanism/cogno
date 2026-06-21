//! Unit tests for `pallet-talk-stake`.

use crate::{mock::*, AllowedStake, Error, Event, VotingPower};
use frame_support::{assert_noop, assert_ok};
use sp_runtime::DispatchError;

const ALICE: u64 = 1;
const BOB: u64 = 2;

/// Count the `StakeSet` events currently in the System event buffer for `who`.
fn stake_set_events_for(who: u64) -> usize {
	System::events()
		.iter()
		.filter(|r| matches!(&r.event, RuntimeEvent::TalkStake(Event::StakeSet { who: w, .. }) if *w == who))
		.count()
}

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

// ── Event-emission edge cases ───────────────────────────────────────────────────────────────

/// **Gap 1 — every accepted `set_stake` emits, not just the last.** A regression that silently
/// drops the event on an intermediate write (e.g. an early `return Ok(())` before
/// `deposit_event`) would slip past `assert_last_event`. Here we drain the buffer between calls
/// and assert that EACH accepted write — including the idempotent re-derive and the unlock to 0
/// — deposits exactly its own `StakeSet` carrying the just-written weight.
#[test]
fn every_set_stake_emits_its_own_event() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		for w in [10_000_000u128, 25_000_000, 25_000_000 /* idempotent */, 0 /* unlock */] {
			System::reset_events();
			assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, w));
			// Exactly one StakeSet for ALICE per call (not zero, not two).
			assert_eq!(stake_set_events_for(ALICE), 1, "each accepted write must emit once");
			System::assert_last_event(Event::StakeSet { who: ALICE, weight: w }.into());
		}
	});
}

/// **Gap 2 — a `WeightTooHigh` rejection writes nothing AND emits nothing.** The state-change
/// guarantee is "no `StakeSet` without a corresponding write". A future maintainer moving
/// `deposit_event` above the `ensure!` would break it silently; `assert_noop!` proves no storage
/// change, and the explicit event scan proves no spurious event leaked.
#[test]
fn weight_too_high_emits_no_event() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		System::reset_events();
		assert_noop!(
			TalkStake::set_stake(RuntimeOrigin::root(), ALICE, MAX_STAKE_WEIGHT + 1),
			Error::<Test>::WeightTooHigh
		);
		assert_eq!(AllowedStake::<Test>::get(ALICE), 0, "rejected weight must not be stored");
		assert!(
			!System::events()
				.iter()
				.any(|r| matches!(r.event, RuntimeEvent::TalkStake(Event::StakeSet { .. }))),
			"a WeightTooHigh rejection must not emit StakeSet"
		);
	});
}

/// **Gap 3 — a `BadOrigin` rejection writes nothing AND emits nothing.** Extends the existing
/// origin gate test with the event-absence assertion: an unauthorised caller must leave both the
/// storage row and the event stream untouched.
#[test]
fn bad_origin_writes_nothing_and_emits_nothing() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		System::reset_events();
		assert_noop!(
			TalkStake::set_stake(RuntimeOrigin::signed(ALICE), ALICE, 10_000_000),
			DispatchError::BadOrigin,
		);
		assert_eq!(AllowedStake::<Test>::get(ALICE), 0, "bad-origin call must not write");
		assert!(
			!System::events()
				.iter()
				.any(|r| matches!(r.event, RuntimeEvent::TalkStake(Event::StakeSet { .. }))),
			"a BadOrigin rejection must not emit StakeSet"
		);
	});
}

// ── Boundary / saturation ───────────────────────────────────────────────────────────────────

/// **Gaps 5 + 9 — the cap is a real comparison against the configured constant.** Against a mock
/// whose `MaxStakeWeight == u128::MAX`, the extreme values `u128::MAX - 1` and `u128::MAX` must
/// BOTH be accepted (there is no hidden internal ceiling below the constant), and there is no
/// representable weight that can exceed the cap — so on this runtime `set_stake` can never return
/// `WeightTooHigh`. Run against the default mock, `u128::MAX` is one over an `100_000_000` cap and
/// is rejected — proving the `<=` boundary tracks `MaxStakeWeight`, not the type max.
#[test]
fn max_stake_weight_is_compared_against_the_configured_cap() {
	// Cap == u128::MAX: the largest representable weights are accepted, nothing can exceed it.
	maxcap::new_test_ext().execute_with(|| {
		maxcap::System::set_block_number(1);
		assert_ok!(maxcap::TalkStake::set_stake(
			maxcap::RuntimeOrigin::root(),
			ALICE,
			u128::MAX - 1
		));
		assert_eq!(AllowedStake::<maxcap::Test>::get(ALICE), u128::MAX - 1);
		assert_ok!(maxcap::TalkStake::set_stake(maxcap::RuntimeOrigin::root(), ALICE, u128::MAX));
		assert_eq!(AllowedStake::<maxcap::Test>::get(ALICE), u128::MAX);
	});

	// Default mock (cap = 100_000_000): u128::MAX is far over the cap and is rejected, no write.
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_noop!(
			TalkStake::set_stake(RuntimeOrigin::root(), ALICE, u128::MAX),
			Error::<Test>::WeightTooHigh
		);
		assert_eq!(AllowedStake::<Test>::get(ALICE), 0);
	});
}

/// **Boundary triple — cap − 1, exactly cap, cap + 1.** Pins the inequality precisely at the
/// three values around the limit (the existing test covers cap and cap+1; this adds cap−1 and
/// asserts the rejection at cap+1 leaves the accepted value untouched).
#[test]
fn set_stake_boundary_below_at_and_above_cap() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, MAX_STAKE_WEIGHT - 1));
		assert_eq!(AllowedStake::<Test>::get(ALICE), MAX_STAKE_WEIGHT - 1);
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, MAX_STAKE_WEIGHT));
		assert_eq!(AllowedStake::<Test>::get(ALICE), MAX_STAKE_WEIGHT);
		assert_noop!(
			TalkStake::set_stake(RuntimeOrigin::root(), ALICE, MAX_STAKE_WEIGHT + 1),
			Error::<Test>::WeightTooHigh
		);
		// The rejected over-cap write left the last accepted value (the cap) in place.
		assert_eq!(AllowedStake::<Test>::get(ALICE), MAX_STAKE_WEIGHT);
	});
}

/// **Gap 9 (runtime brief) — `set_stake(who, 0)` is indistinguishable from an unbound read.**
/// An account never written reads 0 (ValueQuery); an account explicitly unlocked to 0 must read
/// the same 0 — the row exists but the value is identical, so capacity collapses identically
/// either way. Also asserts the unlock emits its own `StakeSet { weight: 0 }`.
#[test]
fn explicit_zero_matches_unbound_zero() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// BOB is never written → ValueQuery default.
		assert_eq!(AllowedStake::<Test>::get(BOB), 0);
		// ALICE is funded then explicitly unlocked to 0.
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 40_000_000));
		System::reset_events();
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 0));
		assert_eq!(AllowedStake::<Test>::get(ALICE), AllowedStake::<Test>::get(BOB));
		assert_eq!(AllowedStake::<Test>::get(ALICE), 0);
		System::assert_last_event(Event::StakeSet { who: ALICE, weight: 0 }.into());
	});
}

// ── Lifecycle / multi-account isolation ─────────────────────────────────────────────────────

/// **Gap 6 — reorg-safe idempotency across a (simulated) re-org.** The follower re-derives weight
/// after a re-org and re-submits the SAME value at a re-played block height. We set weight at
/// block N, rewind the block number to N − 1 (a re-org rewind), and re-submit the identical
/// weight: the stored value is unchanged and the call still succeeds and emits — i.e. re-execution
/// is safe and deterministic regardless of block height moving backward.
#[test]
fn set_stake_is_idempotent_across_a_reorg_rewind() {
	new_test_ext().execute_with(|| {
		System::set_block_number(10);
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 30_000_000));
		assert_eq!(AllowedStake::<Test>::get(ALICE), 30_000_000);

		// Simulate a re-org: the chain rewinds and re-executes the same extrinsic.
		System::set_block_number(9);
		System::reset_events();
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 30_000_000));
		// Identical state, no accumulation, and the re-played write still emits.
		assert_eq!(AllowedStake::<Test>::get(ALICE), 30_000_000);
		assert_eq!(stake_set_events_for(ALICE), 1);
		System::assert_last_event(Event::StakeSet { who: ALICE, weight: 30_000_000 }.into());
	});
}

/// **Gap 8 — many distinct accounts set in one block stay isolated.** Writes are per-account; a
/// hash-collision or shared-key bug in the `StorageMap` would let one account's write clobber
/// another. Set N accounts to distinct weights in a single block, then read every one back and
/// confirm it holds exactly its own value and exactly N `StakeSet` events were emitted.
#[test]
fn many_accounts_set_in_one_block_are_isolated() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		const N: u64 = 100;
		for acct in 1..=N {
			let weight = (acct as u128) * 1_000; // distinct, all well under the cap
			assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), acct, weight));
		}
		// Every account reads back exactly its own weight (no cross-contamination).
		for acct in 1..=N {
			assert_eq!(AllowedStake::<Test>::get(acct), (acct as u128) * 1_000);
		}
		let total = System::events()
			.iter()
			.filter(|r| matches!(r.event, RuntimeEvent::TalkStake(Event::StakeSet { .. })))
			.count();
		assert_eq!(total as u64, N, "one StakeSet per distinct account");
	});
}

// ── Voting power (set_voting_power) — the stake-weighted-vote source ─────────────────────────

#[test]
fn voting_power_unbound_reads_zero() {
	new_test_ext().execute_with(|| {
		// ValueQuery: an account that was never set reads 0 voting power (its votes carry no weight).
		assert_eq!(VotingPower::<Test>::get(ALICE), 0);
	});
}

#[test]
fn root_can_set_voting_power_and_overwrite() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(TalkStake::set_voting_power(RuntimeOrigin::root(), ALICE, 500_000_000));
		assert_eq!(VotingPower::<Test>::get(ALICE), 500_000_000);
		System::assert_last_event(Event::VotingPowerSet { who: ALICE, weight: 500_000_000 }.into());
		// Idempotent overwrite (epoch re-snapshot): a later set replaces, never sums.
		assert_ok!(TalkStake::set_voting_power(RuntimeOrigin::root(), ALICE, 250_000_000));
		assert_eq!(VotingPower::<Test>::get(ALICE), 250_000_000);
	});
}

#[test]
fn voting_power_and_allowed_stake_are_independent() {
	// The two weights are stored separately: setting voting power never touches the posting/deposit
	// AllowedStake, and vice versa. A voting power ABOVE MaxStakeWeight (but under MaxVotingPower) is
	// accepted — proving the ceilings are distinct (total stake can exceed any single vault's lock).
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 50_000_000));
		// MAX_STAKE_WEIGHT = 100_000_000; this voting power exceeds it but is under MAX_VOTING_POWER.
		assert_ok!(TalkStake::set_voting_power(RuntimeOrigin::root(), ALICE, 800_000_000));
		assert_eq!(AllowedStake::<Test>::get(ALICE), 50_000_000, "stake untouched by voting-power set");
		assert_eq!(VotingPower::<Test>::get(ALICE), 800_000_000);
		// And setting stake does not disturb voting power.
		assert_ok!(TalkStake::set_stake(RuntimeOrigin::root(), ALICE, 0));
		assert_eq!(VotingPower::<Test>::get(ALICE), 800_000_000, "voting power untouched by stake unlock");
	});
}

#[test]
fn set_voting_power_rejects_above_max_and_signed_origin() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		// Exactly the cap is accepted; one over is rejected with no write.
		assert_ok!(TalkStake::set_voting_power(RuntimeOrigin::root(), ALICE, MAX_VOTING_POWER));
		assert_eq!(VotingPower::<Test>::get(ALICE), MAX_VOTING_POWER);
		assert_noop!(
			TalkStake::set_voting_power(RuntimeOrigin::root(), ALICE, MAX_VOTING_POWER + 1),
			Error::<Test>::VotingPowerTooHigh
		);
		assert_eq!(VotingPower::<Test>::get(ALICE), MAX_VOTING_POWER); // unchanged
		// Only SetStakeOrigin (root in the mock) may write voting power.
		assert_noop!(
			TalkStake::set_voting_power(RuntimeOrigin::signed(BOB), BOB, 1),
			DispatchError::BadOrigin,
		);
		assert_eq!(VotingPower::<Test>::get(BOB), 0);
	});
}
