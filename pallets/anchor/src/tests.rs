//! Unit tests for `pallet-anchor` — the M3 Tier-A checkpoint recorder.
//!
//! These prove the two properties the WRITE link rests on: only the `AnchorOrigin` can record a
//! checkpoint (the public pool cannot forge anchor evidence), and `anchor_ack` is **idempotent /
//! monotonic** — a re-ack of an equal or lower finalized height is a no-op, so a Cardano-rollback
//! re-submit can never double-count (`PLAN.md` §9).

use crate::{mock::*, CardanoTxHash, Checkpoint, Event, LastCheckpoint, StateRoot};
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
