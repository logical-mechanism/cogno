//! Unit tests for `pallet-talk-stake`.

use crate::{mock::*, AllowedStake, Event};
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
