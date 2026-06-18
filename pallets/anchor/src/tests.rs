//! Unit tests for `pallet-anchor` — the M3 Tier-A checkpoint recorder.
//!
//! These prove the two properties the WRITE link rests on: only the `AnchorOrigin` can record a
//! checkpoint (the public pool cannot forge anchor evidence), and `anchor_ack` is **idempotent /
//! monotonic** — a re-ack of an equal or lower finalized height is a no-op, so a Cardano-rollback
//! re-submit can never double-count (`PLAN.md` §9).

use crate::{mock::*, CardanoTxHash, Checkpoint, Error, Event, LastCheckpoint, StateRoot};
use frame_support::{assert_noop, assert_ok};
use sp_runtime::DispatchError;

const ROOT_A: StateRoot = [0x11u8; 32];
const ROOT_B: StateRoot = [0x22u8; 32];
const TX_A: CardanoTxHash = [0xA1u8; 32];
const TX_B: CardanoTxHash = [0xB2u8; 32];

#[test]
fn first_ack_records_and_emits() {
	new_test_ext().execute_with(|| {
		assert!(Anchor::last_checkpoint().is_none());

		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 10, ROOT_A, TX_A, 7, 1_700_000_000_000));

		let cp = Anchor::last_checkpoint().expect("recorded");
		assert_eq!(
			cp,
			Checkpoint {
				block_number: 10,
				finalized_root: ROOT_A,
				cardano_txhash: TX_A,
				post_count: 7,
				timestamp: 1_700_000_000_000,
			}
		);
		System::assert_has_event(
			Event::AnchorAcked {
				block_number: 10,
				finalized_root: ROOT_A,
				cardano_txhash: TX_A,
				post_count: 7,
				timestamp: 1_700_000_000_000,
			}
			.into(),
		);
	});
}

#[test]
fn ack_requires_anchor_origin() {
	new_test_ext().execute_with(|| {
		// A public (signed) origin cannot forge anchor evidence — only AnchorOrigin (root in dev).
		assert_noop!(
			Anchor::anchor_ack(RuntimeOrigin::signed(1), 10, ROOT_A, TX_A, 7, 1),
			DispatchError::BadOrigin
		);
		assert!(!LastCheckpoint::<Test>::exists());
	});
}

#[test]
fn higher_height_advances_checkpoint() {
	new_test_ext().execute_with(|| {
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 10, ROOT_A, TX_A, 7, 100));
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 20, ROOT_B, TX_B, 9, 200));

		let cp = Anchor::last_checkpoint().unwrap();
		assert_eq!(cp.block_number, 20);
		assert_eq!(cp.finalized_root, ROOT_B);
		assert_eq!(cp.cardano_txhash, TX_B);
		assert_eq!(cp.post_count, 9);
		System::assert_has_event(
			Event::AnchorAcked {
				block_number: 20,
				finalized_root: ROOT_B,
				cardano_txhash: TX_B,
				post_count: 9,
				timestamp: 200,
			}
			.into(),
		);
	});
}

#[test]
fn re_ack_same_height_is_noop() {
	new_test_ext().execute_with(|| {
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 10, ROOT_A, TX_A, 7, 100));
		// A Cardano-rollback re-submit of the SAME height — different txhash/root must NOT overwrite.
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 10, ROOT_B, TX_B, 99, 999));

		let cp = Anchor::last_checkpoint().unwrap();
		assert_eq!(cp.block_number, 10);
		assert_eq!(cp.finalized_root, ROOT_A, "stale re-ack must not overwrite");
		assert_eq!(cp.cardano_txhash, TX_A);
		assert_eq!(cp.post_count, 7);
		System::assert_has_event(Event::AckIgnored { block_number: 10, last: 10 }.into());
	});
}

#[test]
fn lower_height_is_noop() {
	new_test_ext().execute_with(|| {
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 20, ROOT_A, TX_A, 7, 100));
		// A late/duplicate ack for an earlier finalized height is ignored (anti double-count).
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 10, ROOT_B, TX_B, 1, 50));

		let cp = Anchor::last_checkpoint().unwrap();
		assert_eq!(cp.block_number, 20, "recorded height only moves forward");
		assert_eq!(cp.finalized_root, ROOT_A);
		System::assert_has_event(Event::AckIgnored { block_number: 10, last: 20 }.into());
	});
}

#[test]
fn rejects_regressing_post_count_or_timestamp() {
	new_test_ext().execute_with(|| {
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 10, ROOT_A, TX_A, 7, 100));
		// A strictly-higher block reporting a LOWER post_count is inconsistent → rejected (anchor-1).
		assert_noop!(
			Anchor::anchor_ack(RuntimeOrigin::root(), 20, ROOT_B, TX_B, 6, 200),
			Error::<Test>::NonMonotonicAnchor
		);
		// ...and a LOWER timestamp too.
		assert_noop!(
			Anchor::anchor_ack(RuntimeOrigin::root(), 20, ROOT_B, TX_B, 9, 50),
			Error::<Test>::NonMonotonicAnchor
		);
		// assert_noop proved nothing was written: the checkpoint is still height 10.
		assert_eq!(Anchor::last_checkpoint().unwrap().block_number, 10);
		// Equal (non-decreasing) post_count + timestamp at a higher height is accepted.
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 20, ROOT_B, TX_B, 7, 100));
		assert_eq!(Anchor::last_checkpoint().unwrap().block_number, 20);
	});
}

/// AND-junction boundary (anchor-1, `lib.rs` ensure!): the guard requires `post_count >= last &&
/// timestamp >= last`, so a regression in EITHER field alone must reject — even when the OTHER field
/// is exactly equal (not regressing). The existing test covers each field strictly lower with the
/// other strictly higher; these two cases pin the "one equal, one regresses" corners of the AND.
#[test]
fn rejects_when_one_field_equal_and_the_other_regresses() {
	new_test_ext().execute_with(|| {
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 10, ROOT_A, TX_A, 7, 100));
		// post_count == last (7, not regressing) but timestamp regresses (50 < 100) → reject.
		assert_noop!(
			Anchor::anchor_ack(RuntimeOrigin::root(), 20, ROOT_B, TX_B, 7, 50),
			Error::<Test>::NonMonotonicAnchor
		);
		// timestamp == last (100, not regressing) but post_count regresses (6 < 7) → reject.
		assert_noop!(
			Anchor::anchor_ack(RuntimeOrigin::root(), 20, ROOT_B, TX_B, 6, 100),
			Error::<Test>::NonMonotonicAnchor
		);
		// Nothing was written by either rejection: still the original height-10 checkpoint.
		let cp = Anchor::last_checkpoint().unwrap();
		assert_eq!(cp.block_number, 10);
		assert_eq!(cp.post_count, 7);
		assert_eq!(cp.timestamp, 100);
	});
}

/// A rejected `anchor_ack` (`NonMonotonicAnchor`) must be a pure failure: it returns the error AND
/// emits NO event — unlike the idempotent no-op which deliberately emits `AckIgnored`. `assert_noop!`
/// proves the storage rollback; this asserts the absence of any spurious event, so an accidental
/// future double-emit (or an error event added by mistake) would be caught.
#[test]
fn non_monotonic_rejection_emits_no_event() {
	new_test_ext().execute_with(|| {
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 10, ROOT_A, TX_A, 7, 100));
		// Drop the AnchorAcked from the first (valid) ack so we only inspect the rejection's effect.
		System::reset_events();

		assert_noop!(
			Anchor::anchor_ack(RuntimeOrigin::root(), 20, ROOT_B, TX_B, 6, 200),
			Error::<Test>::NonMonotonicAnchor
		);
		// The rejection path emits NOTHING: not AnchorAcked, not AckIgnored, no error event.
		assert!(
			System::events().is_empty(),
			"NonMonotonicAnchor rejection must emit no event, got {:?}",
			System::events()
		);
	});
}

/// A rejected origin (`BadOrigin`) must likewise emit no event and write no checkpoint — the public
/// pool cannot leave any on-chain trace via a forged anchor attempt.
#[test]
fn bad_origin_rejection_emits_no_event() {
	new_test_ext().execute_with(|| {
		assert_noop!(
			Anchor::anchor_ack(RuntimeOrigin::signed(1), 10, ROOT_A, TX_A, 7, 100),
			DispatchError::BadOrigin
		);
		assert!(!LastCheckpoint::<Test>::exists());
		assert!(
			System::events().is_empty(),
			"BadOrigin rejection must emit no event, got {:?}",
			System::events()
		);
	});
}

/// Explicit no-growth boundary: a strictly-higher height that carries EQUAL post_count and EQUAL
/// timestamp (neither field "advances") is valid — `>=` admits equality. This pins the success side
/// of the boundary whose failure side (`one equal, one regresses`) is covered above, and records
/// that the checkpoint metadata (root/txhash) DOES advance even when the counters stand still.
#[test]
fn equal_post_count_and_timestamp_at_higher_height_is_accepted() {
	new_test_ext().execute_with(|| {
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 10, ROOT_A, TX_A, 7, 100));
		// Same counters, higher height, fresh root/txhash → accepted and the record advances.
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 20, ROOT_B, TX_B, 7, 100));

		let cp = Anchor::last_checkpoint().unwrap();
		assert_eq!(cp.block_number, 20);
		assert_eq!(cp.finalized_root, ROOT_B, "metadata advances even when counters are flat");
		assert_eq!(cp.cardano_txhash, TX_B);
		assert_eq!(cp.post_count, 7);
		assert_eq!(cp.timestamp, 100);
		System::assert_last_event(
			Event::AnchorAcked {
				block_number: 20,
				finalized_root: ROOT_B,
				cardano_txhash: TX_B,
				post_count: 7,
				timestamp: 100,
			}
			.into(),
		);
	});
}

/// Zero boundary: on the FIRST ack (no prior checkpoint) zero counters are valid (no constraint to
/// regress against); a later ack of zero counters after non-zero ones is a regression and rejects.
/// Guards the `0 >= n` comparison corner the small-positive fixtures never exercise.
#[test]
fn zero_post_count_and_timestamp_first_ack_valid_then_zero_regresses() {
	new_test_ext().execute_with(|| {
		// First ack with both counters at zero is accepted (block_number is still meaningful).
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 5, ROOT_A, TX_A, 0, 0));
		assert_eq!(Anchor::last_checkpoint().unwrap().post_count, 0);

		// Grow to non-zero counters at a higher height.
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 10, ROOT_B, TX_B, 5, 100));

		// A later, strictly-higher height reporting post_count back at 0 regresses (0 < 5) → reject.
		assert_noop!(
			Anchor::anchor_ack(RuntimeOrigin::root(), 20, ROOT_A, TX_A, 0, 200),
			Error::<Test>::NonMonotonicAnchor
		);
		// ...and a zero timestamp after a non-zero one regresses too (0 < 100).
		assert_noop!(
			Anchor::anchor_ack(RuntimeOrigin::root(), 20, ROOT_A, TX_A, 5, 0),
			Error::<Test>::NonMonotonicAnchor
		);
		// The checkpoint is unchanged from the height-10 grow.
		let cp = Anchor::last_checkpoint().unwrap();
		assert_eq!(cp.block_number, 10);
		assert_eq!(cp.post_count, 5);
		assert_eq!(cp.timestamp, 100);
	});
}

/// `u64::MAX` boundary for the monotonic counters: an equal `u64::MAX` at a higher height is NOT a
/// regression and is accepted; any value below `u64::MAX` afterwards regresses and rejects. Proves
/// the `>=` comparison is correct at the top of the range (no surprise wrap or off-by-one).
#[test]
fn u64_max_post_count_and_timestamp_boundary() {
	new_test_ext().execute_with(|| {
		assert_ok!(Anchor::anchor_ack(
			RuntimeOrigin::root(),
			10,
			ROOT_A,
			TX_A,
			u64::MAX,
			u64::MAX
		));
		// Equal u64::MAX at a higher height — neither field regresses → accepted.
		assert_ok!(Anchor::anchor_ack(
			RuntimeOrigin::root(),
			20,
			ROOT_B,
			TX_B,
			u64::MAX,
			u64::MAX
		));
		assert_eq!(Anchor::last_checkpoint().unwrap().block_number, 20);

		// Any post_count below u64::MAX now regresses (MAX-1 < MAX) → rejected.
		assert_noop!(
			Anchor::anchor_ack(RuntimeOrigin::root(), 30, ROOT_A, TX_A, u64::MAX - 1, u64::MAX),
			Error::<Test>::NonMonotonicAnchor
		);
		assert_eq!(Anchor::last_checkpoint().unwrap().block_number, 20);
	});
}

/// `BlockNumberFor` (u64) at `u64::MAX`: the monotonic-height guard must hold at the very top of the
/// block-number range. Acking at `u64::MAX` records it, and any subsequent ack (including a re-ack of
/// `u64::MAX` itself) is `<= last` and is therefore the idempotent no-op — never an advance.
#[test]
fn u64_max_block_number_is_terminal_and_re_ack_is_noop() {
	new_test_ext().execute_with(|| {
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), u64::MAX, ROOT_A, TX_A, 7, 100));
		assert_eq!(Anchor::last_checkpoint().unwrap().block_number, u64::MAX);

		// Re-ack of the same terminal height with higher counters/different metadata is a no-op.
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), u64::MAX, ROOT_B, TX_B, 99, 999));
		let cp = Anchor::last_checkpoint().unwrap();
		assert_eq!(cp.finalized_root, ROOT_A, "terminal re-ack must not overwrite");
		assert_eq!(cp.post_count, 7);
		System::assert_last_event(
			Event::AckIgnored { block_number: u64::MAX, last: u64::MAX }.into(),
		);
	});
}

/// Interleaved fresh/stale acks: a relayer must be able to read the event type to know whether a
/// retry advanced the checkpoint (`AnchorAcked`) or was a no-op (`AckIgnored`). This drives a
/// sequence 10 → 20 → 15 → 10 and asserts the event emitted at EACH step, distinguishing the two
/// in the same run (the existing monotonic test only ever advances).
#[test]
fn interleaved_fresh_and_stale_acks_emit_distinct_events() {
	new_test_ext().execute_with(|| {
		// Height 10: fresh → AnchorAcked.
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 10, ROOT_A, TX_A, 7, 100));
		System::assert_last_event(
			Event::AnchorAcked {
				block_number: 10,
				finalized_root: ROOT_A,
				cardano_txhash: TX_A,
				post_count: 7,
				timestamp: 100,
			}
			.into(),
		);

		// Height 20: fresh advance → AnchorAcked.
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 20, ROOT_B, TX_B, 9, 200));
		System::assert_last_event(
			Event::AnchorAcked {
				block_number: 20,
				finalized_root: ROOT_B,
				cardano_txhash: TX_B,
				post_count: 9,
				timestamp: 200,
			}
			.into(),
		);

		// Height 15: stale (15 <= 20) → AckIgnored, last reported as 20, checkpoint unchanged.
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 15, ROOT_A, TX_A, 8, 150));
		System::assert_last_event(Event::AckIgnored { block_number: 15, last: 20 }.into());
		assert_eq!(Anchor::last_checkpoint().unwrap().block_number, 20);

		// Height 10 again: stale → AckIgnored, last still 20.
		assert_ok!(Anchor::anchor_ack(RuntimeOrigin::root(), 10, ROOT_A, TX_A, 7, 100));
		System::assert_last_event(Event::AckIgnored { block_number: 10, last: 20 }.into());

		// The checkpoint never regressed through the stale acks.
		let cp = Anchor::last_checkpoint().unwrap();
		assert_eq!(cp.block_number, 20);
		assert_eq!(cp.finalized_root, ROOT_B);
		assert_eq!(cp.post_count, 9);
	});
}

#[test]
fn monotonic_sequence_of_acks() {
	new_test_ext().execute_with(|| {
		for (i, &bn) in [5u64, 10, 15, 20].iter().enumerate() {
			let root = [i as u8; 32];
			let tx = [(i + 100) as u8; 32];
			assert_ok!(Anchor::anchor_ack(
				RuntimeOrigin::root(),
				bn,
				root,
				tx,
				bn, // post_count grows with height in this fixture
				bn * 1000,
			));
			assert_eq!(Anchor::last_checkpoint().unwrap().block_number, bn);
		}
	});
}
