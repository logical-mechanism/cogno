//! Unit tests for `pallet-talk-stake` — a call-less, observer-written ledger. The tests drive the
//! internal `apply_weight` / `apply_voting_power` writers directly (the observer inherent's sink), since
//! there is no extrinsic / origin / cap in this pallet any more.

use crate::{mock::*, AllowedStake, Event, Pallet, VotingPower};

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
		// ValueQuery: an account that was never written reads 0 weight and 0 voting power.
		assert_eq!(AllowedStake::<Test>::get(ALICE), 0);
		assert_eq!(VotingPower::<Test>::get(ALICE), 0);
	});
}

#[test]
fn apply_weight_overwrites_and_emits() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		Pallet::<Test>::apply_weight(&ALICE, 10_000_000);
		assert_eq!(AllowedStake::<Test>::get(ALICE), 10_000_000);
		System::assert_last_event(Event::StakeSet { who: ALICE, weight: 10_000_000 }.into());

		// Idempotent overwrite (reorg-safe re-derive): a later apply replaces, never sums.
		Pallet::<Test>::apply_weight(&ALICE, 25_000_000);
		assert_eq!(AllowedStake::<Test>::get(ALICE), 25_000_000);

		// Full unlock writes weight = 0 (the row stays; capacity clamps elsewhere).
		Pallet::<Test>::apply_weight(&ALICE, 0);
		assert_eq!(AllowedStake::<Test>::get(ALICE), 0);
	});
}

/// **DR-06 — largest-wins / never-sum (the L3 side).** `apply_weight` is an idempotent OVERWRITE; it
/// NEVER accumulates. That is the on-chain guarantee that makes the observer's largest-wins / never-sum
/// reduction safe: whatever per-vault weight the reduction folds for an identity, it applies exactly ONE
/// value and L3 stores precisely that — never the running sum (no live stake-splitting double-dip). We
/// sweep several re-observation sequences and assert: after every write the stored weight equals the
/// just-written value; and for any sequence with ≥2 nonzero observations the stored weight is strictly
/// below the naive sum (no accumulation, independent of read order).
#[test]
fn apply_weight_overwrites_never_sums_property() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let sequences: &[&[u128]] = &[
			&[10_000_000],
			&[10_000_000, 25_000_000],      // raise: largest-wins picks the larger vault
			&[25_000_000, 10_000_000],      // lower: a re-observed smaller vault
			&[5, 5, 5],                     // repeated identical re-derives (reorg-safe, idempotent)
			&[100, 200, 50, 175, 300],      // arbitrary re-observation order
			&[40_000_000, 0],               // unlock (final clamp to zero)
		];
		for (i, seq) in sequences.iter().enumerate() {
			let who = i as u64 + 1;
			let mut running_sum = 0u128;
			for &w in seq.iter() {
				Pallet::<Test>::apply_weight(&who, w);
				running_sum = running_sum.saturating_add(w);
				assert_eq!(AllowedStake::<Test>::get(who), w);
			}
			let last = *seq.last().unwrap();
			assert_eq!(AllowedStake::<Test>::get(who), last);
			if seq.iter().filter(|&&w| w > 0).count() >= 2 {
				assert!(last < running_sum, "stored weight must never be the sum of observations");
			}
		}
	});
}

/// Every accepted `apply_weight` — including the idempotent re-derive and the unlock to 0 — deposits
/// exactly its own `StakeSet` carrying the just-written weight.
#[test]
fn every_apply_weight_emits_its_own_event() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		for w in [10_000_000u128, 25_000_000, 25_000_000 /* idempotent */, 0 /* unlock */] {
			System::reset_events();
			Pallet::<Test>::apply_weight(&ALICE, w);
			assert_eq!(stake_set_events_for(ALICE), 1, "each accepted write must emit once");
			System::assert_last_event(Event::StakeSet { who: ALICE, weight: w }.into());
		}
	});
}

/// `apply_weight(who, 0)` is indistinguishable from an unbound read: an account never written reads 0
/// (ValueQuery); an account explicitly unlocked to 0 reads the same 0 — capacity collapses identically.
#[test]
fn explicit_zero_matches_unbound_zero() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		assert_eq!(AllowedStake::<Test>::get(BOB), 0); // never written
		Pallet::<Test>::apply_weight(&ALICE, 40_000_000);
		System::reset_events();
		Pallet::<Test>::apply_weight(&ALICE, 0);
		assert_eq!(AllowedStake::<Test>::get(ALICE), AllowedStake::<Test>::get(BOB));
		assert_eq!(AllowedStake::<Test>::get(ALICE), 0);
		System::assert_last_event(Event::StakeSet { who: ALICE, weight: 0 }.into());
	});
}

/// Reorg-safe idempotency across a (simulated) re-org: apply at block N, rewind to N−1, re-apply the same
/// value — the stored value is unchanged and the re-play still emits.
#[test]
fn apply_weight_is_idempotent_across_a_reorg_rewind() {
	new_test_ext().execute_with(|| {
		System::set_block_number(10);
		Pallet::<Test>::apply_weight(&ALICE, 30_000_000);
		assert_eq!(AllowedStake::<Test>::get(ALICE), 30_000_000);

		System::set_block_number(9); // re-org rewind
		System::reset_events();
		Pallet::<Test>::apply_weight(&ALICE, 30_000_000);
		assert_eq!(AllowedStake::<Test>::get(ALICE), 30_000_000);
		assert_eq!(stake_set_events_for(ALICE), 1);
		System::assert_last_event(Event::StakeSet { who: ALICE, weight: 30_000_000 }.into());
	});
}

/// Many distinct accounts written in one block stay isolated (per-account StorageMap).
#[test]
fn many_accounts_written_in_one_block_are_isolated() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		const N: u64 = 100;
		for acct in 1..=N {
			Pallet::<Test>::apply_weight(&acct, (acct as u128) * 1_000);
		}
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

// ── Voting power (apply_voting_power) — the stake-weighted-vote source ─────────────────────────

#[test]
fn apply_voting_power_overwrites_and_is_independent_of_allowed_stake() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		Pallet::<Test>::apply_voting_power(&ALICE, 500_000_000);
		assert_eq!(VotingPower::<Test>::get(ALICE), 500_000_000);
		System::assert_last_event(Event::VotingPowerSet { who: ALICE, weight: 500_000_000 }.into());

		// Idempotent overwrite (epoch re-snapshot): a later apply replaces, never sums.
		Pallet::<Test>::apply_voting_power(&ALICE, 250_000_000);
		assert_eq!(VotingPower::<Test>::get(ALICE), 250_000_000);

		// The two weights are stored separately: stake and voting power never touch each other.
		Pallet::<Test>::apply_weight(&ALICE, 50_000_000);
		Pallet::<Test>::apply_voting_power(&ALICE, 800_000_000);
		assert_eq!(AllowedStake::<Test>::get(ALICE), 50_000_000, "stake untouched by voting-power set");
		assert_eq!(VotingPower::<Test>::get(ALICE), 800_000_000);
		Pallet::<Test>::apply_weight(&ALICE, 0);
		assert_eq!(VotingPower::<Test>::get(ALICE), 800_000_000, "voting power untouched by stake unlock");
	});
}

// ── Genesis seeding (the dev/local no-Cardano path) ───────────────────────────────────────────

#[test]
fn genesis_seeds_initial_weights() {
	new_test_ext_with_weights(vec![(ALICE, 10_000_000, 500_000_000), (BOB, 0, 42)]).execute_with(|| {
		assert_eq!(AllowedStake::<Test>::get(ALICE), 10_000_000);
		assert_eq!(VotingPower::<Test>::get(ALICE), 500_000_000);
		assert_eq!(AllowedStake::<Test>::get(BOB), 0);
		assert_eq!(VotingPower::<Test>::get(BOB), 42);
		// An unseeded account still reads the ValueQuery default.
		assert_eq!(AllowedStake::<Test>::get(3u64), 0);
	});
}
