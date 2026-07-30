//! Unit tests for `pallet-cardano-observer` — the inherent verification semantics + the Mandatory
//! `observe` dispatchable (monotonicity, stability bound, MaxStakeWeight skip, account resolution,
//! weight application, the explicit unlock, and the paging that replaced the old population cliff).
//!
//! ## Reading these tests
//!
//! Most of them drive [`observe_snapshot`], which does what a real block does: build the node's FULL
//! snapshot, let `create_inherent` diff it against on-chain state, and dispatch the resulting delta. That
//! is deliberate. Calling `observe` with a hand-built change list would test the apply half against
//! payloads the diff can never produce, and the interesting invariants (an unlock is derived, an
//! unresolvable entry never enters a page, a re-sent snapshot is a no-op) live in the diff.
//!
//! Where a test needs a payload the diff would NOT produce — a tampered delta, a change for an unbound
//! beacon — it builds the call directly and dispatches it through [`dispatch`].

use crate::mock::*;
use crate::{
    BeaconName, CardanoObservation, CardanoRef, Event, InherentError, LastObserved,
    LastObservedRoles, LastObservedStake, LastReference, PendingChanges, RoleEntry, RoleSource,
    StakeCredential, INHERENT_IDENTIFIER,
};
use frame_support::{
    assert_ok,
    inherent::{InherentData, IsFatalError, ProvideInherent},
    traits::OnInitialize,
    BoundedVec,
};

const ALICE: AccountId = 1;
const BOB: AccountId = 2;
const A: BeaconName = [0xAA; 32];
const B: BeaconName = [0xBB; 32];
const S1: StakeCredential = [0xC1; 28];
const S2: StakeCredential = [0xC2; 28];

/// A placeholder input commitment for the application/dispatchable tests. The commitment is only
/// load-bearing in `check_inherent` (the Mandatory dispatchable carries-but-ignores it), exercised by
/// the dedicated taxonomy tests below with `COMMIT` vs `COMMIT2`.
const COMMIT: [u8; 32] = [0u8; 32];
/// A DIFFERENT input commitment — "the importer saw different raw Cardano data".
const COMMIT2: [u8; 32] = [0x99u8; 32];

fn cref(slot: u64) -> CardanoRef {
    CardanoRef {
        slot,
        block_hash: [0u8; 32],
    }
}

// ── snapshot construction ──────────────────────────────────────────────────────────────────────────
//
// These build the NODE's observation (the full-snapshot inherent DATA), not the block payload. The
// payload is derived from them.

/// A node snapshot with the given vault entries and nothing else.
fn snap(slot: u64, entries: &[(BeaconName, u128)]) -> CardanoObservation {
    snap_full(slot, COMMIT, entries, &[], &[])
}

/// A node snapshot with the given vault + stake entries.
fn snap_stake(
    slot: u64,
    entries: &[(BeaconName, u128)],
    stake: &[(StakeCredential, u128)],
) -> CardanoObservation {
    snap_full(slot, COMMIT, entries, stake, &[])
}

/// A node snapshot with the given role entries and nothing else.
fn snap_roles(slot: u64, roles: &[RoleEntry]) -> CardanoObservation {
    snap_full(slot, COMMIT, &[], &[], roles)
}

fn snap_full(
    slot: u64,
    commitment: [u8; 32],
    entries: &[(BeaconName, u128)],
    stake: &[(StakeCredential, u128)],
    roles: &[RoleEntry],
) -> CardanoObservation {
    CardanoObservation {
        reference: cref(slot),
        inputs_commitment: commitment,
        entries: entries.to_vec(),
        stake_entries: stake.to_vec(),
        role_entries: roles.to_vec(),
    }
}

/// Role entries with a zero chamber weight (the badge-shape tests).
fn roles(items: &[(RoleSource, [u8; 28], [u8; 28])]) -> Vec<RoleEntry> {
    items
        .iter()
        .map(|(source, credential, id)| RoleEntry {
            source: *source,
            credential: *credential,
            id: *id,
            weight: 0,
        })
        .collect()
}

/// Role entries carrying an explicit chamber weight (spec 207).
fn roles_w(items: &[(RoleSource, [u8; 28], [u8; 28], u128)]) -> Vec<RoleEntry> {
    items
        .iter()
        .map(|(source, credential, id, weight)| RoleEntry {
            source: *source,
            credential: *credential,
            id: *id,
            weight: *weight,
        })
        .collect()
}

// ── driving a block ────────────────────────────────────────────────────────────────────────────────

fn put_obs(id: &mut InherentData, obs: &CardanoObservation) {
    id.put_data(INHERENT_IDENTIFIER, obs)
        .expect("encode observation");
}

/// The call `create_inherent` builds from `obs` against the CURRENT state — i.e. the delta.
fn derive(obs: &CardanoObservation) -> crate::Call<Test> {
    let mut id = InherentData::new();
    put_obs(&mut id, obs);
    <CardanoObserver as ProvideInherent>::create_inherent(&id).expect("inherent produced")
}

/// Dispatch an `observe` call as the inherent would.
fn dispatch(call: crate::Call<Test>) -> frame_support::pallet_prelude::DispatchResult {
    match call {
        crate::Call::observe {
            reference,
            inputs_commitment,
            changes,
            stake_changes,
            role_changes,
            pending,
        } => CardanoObserver::observe(
            RuntimeOrigin::none(),
            reference,
            inputs_commitment,
            changes,
            stake_changes,
            role_changes,
            pending,
        ),
        _ => panic!("expected an observe call"),
    }
}

/// One whole block's worth of observation: derive the delta from the node snapshot and apply it. Returns
/// the `pending` backlog the block reported.
fn observe_snapshot(obs: &CardanoObservation) -> u32 {
    let call = derive(obs);
    let pending = match &call {
        crate::Call::observe { pending, .. } => *pending,
        _ => panic!("expected an observe call"),
    };
    assert_ok!(dispatch(call));
    pending
}

/// The change counts in a derived call, as `(vault, stake, role)`.
fn change_counts(call: &crate::Call<Test>) -> (usize, usize, usize) {
    match call {
        crate::Call::observe {
            changes,
            stake_changes,
            role_changes,
            ..
        } => (changes.len(), stake_changes.len(), role_changes.len()),
        _ => panic!("expected an observe call"),
    }
}

/// The single-identity observation the stall-alarm tests share. The value moves with the slot so each
/// block produces a REAL change — re-sending an identical snapshot derives an empty delta, which would
/// still stamp the clock but would stop these tests exercising the apply path at all.
fn observe_once(slot: u64) {
    let obs = snap(slot, &[(A, MIN_LOCK.saturating_add(slot as u128))]);
    observe_snapshot(&obs);
}

/// Enforce mode is the DEFAULT (`EnforceWeight` defaults to `true`), so this is now a no-op made explicit
/// for the application tests — they assert on the `WeightSink`. Kept as a marker of intent.
fn enforce() {
    assert_ok!(CardanoObserver::set_enforcement(
        RuntimeOrigin::root(),
        true
    ));
}
/// FREEZE weight (the emergency-revert state): the read is still verified, but no weight is applied.
fn freeze() {
    assert_ok!(CardanoObserver::set_enforcement(
        RuntimeOrigin::root(),
        false
    ));
}

/// The 32-byte beacon for index `i`, big-endian so a generated set is ASCENDING — the canonical order the
/// real reduction produces and `derive_call` pages in.
fn nth_beacon(i: u32) -> BeaconName {
    let mut b = [0u8; 32];
    b[..4].copy_from_slice(&i.to_be_bytes());
    b
}

/// The account index `i`'s beacon is bound to. Offset well clear of ALICE/BOB.
fn nth_account(i: u32) -> AccountId {
    1000 + i as AccountId
}

// ── ProvideInherent: create_inherent ───────────────────────────────────────────────────────────────

#[test]
fn create_inherent_emits_the_difference_not_the_snapshot() {
    new_test_ext().execute_with(|| {
        bind(A, ALICE);
        bind(B, BOB);
        bind_stake(S1, ALICE);
        let obs = snap_full(
            1000,
            COMMIT2,
            &[(A, 200_000_000), (B, 300_000_000)],
            &[(S1, 700_000_000)],
            &[],
        );

        // Nothing applied yet, so the first delta IS the whole set.
        let call = derive(&obs);
        match &call {
            crate::Call::observe {
                reference,
                inputs_commitment,
                changes,
                stake_changes,
                pending,
                ..
            } => {
                assert_eq!(*reference, cref(1000));
                assert_eq!(
                    *inputs_commitment, COMMIT2,
                    "the node's input commitment is carried into the call"
                );
                assert_eq!(
                    changes.to_vec(),
                    vec![(A, Some(200_000_000)), (B, Some(300_000_000))]
                );
                assert_eq!(stake_changes.to_vec(), vec![(S1, Some(700_000_000))]);
                assert_eq!(*pending, 0, "well under one page");
            }
            _ => panic!("expected observe call"),
        }
        assert_ok!(dispatch(call));

        // Re-deriving from the SAME snapshot now yields NOTHING. This is the property the whole design
        // rests on: the block payload is proportional to what moved, not to how many identities exist.
        let again = derive(&obs);
        assert_eq!(change_counts(&again), (0, 0, 0));
    });
}

#[test]
fn create_inherent_absent_data_is_none() {
    new_test_ext().execute_with(|| {
        // No data under our identifier ⇒ no inherent this block (legal; is_inherent_required = Ok(None)).
        let id = InherentData::new();
        assert!(<CardanoObserver as ProvideInherent>::create_inherent(&id).is_none());
    });
}

#[test]
fn create_inherent_never_abstains_on_size() {
    new_test_ext().execute_with(|| {
        // THE regression this change exists to prevent. `create_inherent` used to do
        // `BoundedVec::try_from(obs.entries).ok()?`, so ONE entry over `MaxObserved` dropped the ENTIRE
        // inherent — and because the observer is the sole weight writer and the reference is a pure
        // function of the parent, that repeated every slot and froze weight for everyone, permanently.
        //
        // Here the change set is more than double a page. The inherent is still produced, it carries a
        // full page, and the remainder is REPORTED rather than lost.
        let n = MAX_CHANGES_PER_BLOCK * 2 + 7;
        let mut items = Vec::new();
        for i in 0..n {
            bind(nth_beacon(i), nth_account(i));
            items.push((nth_beacon(i), 200_000_000u128));
        }
        let obs = snap(1000, &items);

        let call = derive(&obs);
        let (vault, _, _) = change_counts(&call);
        assert_eq!(
            vault, MAX_CHANGES_PER_BLOCK as usize,
            "the page is filled exactly, not truncated arbitrarily and not dropped"
        );
        match &call {
            crate::Call::observe { pending, .. } => assert_eq!(
                *pending,
                n - MAX_CHANGES_PER_BLOCK,
                "the surplus is reported, so it is visible on-chain rather than silently lost"
            ),
            _ => panic!("expected observe call"),
        }
    });
}

#[test]
fn a_change_set_larger_than_a_page_drains_over_blocks_and_converges() {
    new_test_ext().execute_with(|| {
        // THE acceptance test. A churn spike far larger than any per-block bound must DRAIN, never drop
        // the inherent and never freeze weight — and it must converge to the correct state.
        let n = MAX_CHANGES_PER_BLOCK * 2 + 7; // 519 at the live bound: three blocks' worth
        let mut items = Vec::new();
        for i in 0..n {
            bind(nth_beacon(i), nth_account(i));
            items.push((nth_beacon(i), 200_000_000u128 + i as u128));
        }
        let obs = snap(1000, &items);

        // Block 1: a full page lands, the rest is queued, and the frontier does NOT move.
        let pending = observe_snapshot(&obs);
        assert_eq!(pending, n - MAX_CHANGES_PER_BLOCK);
        assert_eq!(PendingChanges::<Test>::get(), n - MAX_CHANGES_PER_BLOCK);
        assert!(
            LastReference::<Test>::get().is_none(),
            "the frontier must not claim a reference was applied while part of it is queued"
        );

        // Block 2: another page. Still backlogged, still held.
        let pending = observe_snapshot(&obs);
        assert_eq!(pending, n - MAX_CHANGES_PER_BLOCK * 2);
        assert!(LastReference::<Test>::get().is_none());

        // Block 3: the tail. Drained, so the frontier finally advances.
        let pending = observe_snapshot(&obs);
        assert_eq!(pending, 0);
        assert_eq!(PendingChanges::<Test>::get(), 0);
        assert_eq!(LastReference::<Test>::get(), Some(cref(1000)));

        // Converged: every one of the 519 identities holds exactly its observed weight.
        for i in 0..n {
            assert_eq!(
                weight_of(nth_account(i)),
                200_000_000u128 + i as u128,
                "identity {i} did not converge",
            );
        }
        // And a fourth block over the same snapshot is a complete no-op.
        assert_eq!(change_counts(&derive(&obs)), (0, 0, 0));
    });
}

#[test]
fn a_backlogged_block_reports_its_depth_on_chain() {
    new_test_ext().execute_with(|| {
        let n = MAX_CHANGES_PER_BLOCK + 5;
        let mut items = Vec::new();
        for i in 0..n {
            bind(nth_beacon(i), nth_account(i));
            items.push((nth_beacon(i), 200_000_000u128));
        }
        System::set_block_number(1);
        observe_snapshot(&snap(1000, &items));
        // The backlog is a graded, on-chain signal — the generalization of the old latched `Stalled`
        // flag, which could only say "the writer stopped" and had no way to say "it is catching up".
        System::assert_has_event(RuntimeEvent::CardanoObserver(
            Event::ObservationBacklogged {
                reference_slot: 1000,
                pending: 5,
            },
        ));
    });
}

#[test]
fn an_unlock_arriving_mid_backlog_still_zeroes() {
    new_test_ext().execute_with(|| {
        // A drain is not a quiet period: Cardano keeps moving while it runs. An identity that was credited
        // in the FIRST page and unlocks before the last one must still be taken back — the diff is against
        // the applied basis, so its `None` appears the moment it leaves the snapshot.
        let n = MAX_CHANGES_PER_BLOCK + 20;
        let mut items = Vec::new();
        for i in 0..n {
            bind(nth_beacon(i), nth_account(i));
            items.push((nth_beacon(i), 200_000_000u128));
        }
        // Page 1 credits indices 0..256 (ascending beacons), so index 3 is definitely applied.
        observe_snapshot(&snap(1000, &items));
        assert_eq!(weight_of(nth_account(3)), 200_000_000);
        assert!(PendingChanges::<Test>::get() > 0, "still draining");

        // Index 3 unlocks. The next snapshot simply lacks it.
        items.retain(|(b, _)| *b != nth_beacon(3));
        observe_snapshot(&snap(1001, &items));
        assert_eq!(
            weight_of(nth_account(3)),
            0,
            "an unlock during a drain is derived and applied like any other change",
        );
        assert!(
            LastObserved::<Test>::get(nth_beacon(3)).is_none(),
            "and it leaves the basis, so it is not re-emitted forever",
        );

        // Drain the rest and confirm everything else converged.
        for slot in 1002..1010 {
            if observe_snapshot(&snap(slot, &items)) == 0 {
                break;
            }
        }
        assert_eq!(PendingChanges::<Test>::get(), 0);
        for i in 0..n {
            let expected = if i == 3 { 0 } else { 200_000_000 };
            assert_eq!(weight_of(nth_account(i)), expected, "identity {i}");
        }
    });
}

#[test]
fn an_unresolvable_or_over_cap_entry_never_occupies_a_page_slot() {
    new_test_ext().execute_with(|| {
        // The anti-starvation rule. An entry the apply step would SKIP must not enter the delta: it would
        // be emitted, skipped, left out of the basis, and emitted again next block — for ever, holding a
        // page slot that a real change needed. Both skip reasons are covered.
        bind(A, ALICE);
        let obs = snap(
            1000,
            &[
                (A, 200_000_000),                   // fine
                (B, 300_000_000),                   // B is bound to nobody
                ([0x11; 32], MAX_STAKE_WEIGHT + 1), // over MaxStakeWeight
            ],
        );
        bind([0x11; 32], BOB);

        let call = derive(&obs);
        match &call {
            crate::Call::observe { changes, .. } => assert_eq!(
                changes.to_vec(),
                vec![(A, Some(200_000_000))],
                "only the entry that can actually be applied is carried",
            ),
            _ => panic!("expected observe call"),
        }
        assert_ok!(dispatch(call));
        // And it stays out on the next block too, rather than churning.
        assert_eq!(change_counts(&derive(&obs)), (0, 0, 0));
    });
}

// ── ProvideInherent: check_inherent ────────────────────────────────────────────────────────────────

#[test]
fn check_inherent_matches_local_read() {
    new_test_ext().execute_with(|| {
        bind(A, ALICE);
        let obs = snap(1000, &[(A, 200_000_000)]);
        let call = derive(&obs);
        let mut id = InherentData::new();
        put_obs(&mut id, &obs);
        // The importer re-derives the delta from its OWN snapshot against the SAME parent state, so an
        // honest author's page matches byte for byte.
        assert!(<CardanoObserver as ProvideInherent>::check_inherent(&call, &id).is_ok());
    });
}

#[test]
fn check_inherent_agrees_with_the_author_mid_backlog() {
    new_test_ext().execute_with(|| {
        // The hazard a paged payload introduces: if the importer compared the author's PAGE against its own
        // full snapshot it would see a difference on every backlogged block and fatally reject an honest
        // one. Both sides run the same derivation over the same basis, so both page at the same boundary.
        let n = MAX_CHANGES_PER_BLOCK + 40;
        let mut items = Vec::new();
        for i in 0..n {
            bind(nth_beacon(i), nth_account(i));
            items.push((nth_beacon(i), 200_000_000u128));
        }
        let obs = snap(1000, &items);
        let call = derive(&obs);
        match &call {
            crate::Call::observe { pending, .. } => assert_eq!(*pending, 40),
            _ => panic!("expected observe call"),
        }
        let mut id = InherentData::new();
        put_obs(&mut id, &obs);
        assert!(
            <CardanoObserver as ProvideInherent>::check_inherent(&call, &id).is_ok(),
            "a backlogged page is not a disagreement",
        );
    });
}

#[test]
fn check_inherent_rejects_a_tampered_delta() {
    new_test_ext().execute_with(|| {
        bind(A, ALICE);
        bind(B, BOB);
        let obs = snap(1000, &[(A, 200_000_000), (B, 300_000_000)]);
        let honest = derive(&obs);

        // An author who inflates a weight in an otherwise-correct page.
        let forged = match honest.clone() {
            crate::Call::observe {
                reference,
                inputs_commitment,
                stake_changes,
                role_changes,
                pending,
                ..
            } => crate::Call::observe {
                reference,
                inputs_commitment,
                changes: BoundedVec::truncate_from(vec![
                    (A, Some(999_000_000)),
                    (B, Some(300_000_000)),
                ]),
                stake_changes,
                role_changes,
                pending,
            },
            _ => panic!("expected observe call"),
        };
        let mut id = InherentData::new();
        put_obs(&mut id, &obs);
        let err = <CardanoObserver as ProvideInherent>::check_inherent(&forged, &id)
            .expect_err("a tampered delta must be rejected");
        // Same raw Cardano inputs (the commitment matches), different derived output ⇒ a compute
        // divergence rather than a data disagreement. Fatal either way.
        assert!(matches!(err, InherentError::ComputeDiverged));
        assert!(err.is_fatal_error());

        // Dropping a change is caught too — an author cannot quietly withhold someone's unlock.
        let withheld = match honest {
            crate::Call::observe {
                reference,
                inputs_commitment,
                stake_changes,
                role_changes,
                pending,
                ..
            } => crate::Call::observe {
                reference,
                inputs_commitment,
                changes: BoundedVec::truncate_from(vec![(A, Some(200_000_000))]),
                stake_changes,
                role_changes,
                pending,
            },
            _ => panic!("expected observe call"),
        };
        assert!(matches!(
            <CardanoObserver as ProvideInherent>::check_inherent(&withheld, &id),
            Err(InherentError::ComputeDiverged)
        ));
    });
}

#[test]
fn check_inherent_mismatch_is_fatal() {
    new_test_ext().execute_with(|| {
        bind(A, ALICE);
        bind(B, BOB);
        // The author saw A; the importer sees B, and their raw input commitments differ too.
        let author_obs = snap_full(1000, COMMIT, &[(A, 200_000_000)], &[], &[]);
        let call = derive(&author_obs);
        let local = snap_full(1000, COMMIT2, &[(B, 300_000_000)], &[], &[]);
        let mut id = InherentData::new();
        put_obs(&mut id, &local);
        let err = <CardanoObserver as ProvideInherent>::check_inherent(&call, &id)
            .expect_err("differing reads must be rejected");
        assert!(matches!(err, InherentError::Mismatch));
        assert!(err.is_fatal_error());

        // A differing reference SLOT alone is a mismatch, whatever the entries say.
        let other_ref = snap_full(999, COMMIT, &[(A, 200_000_000)], &[], &[]);
        let mut id2 = InherentData::new();
        put_obs(&mut id2, &other_ref);
        assert!(matches!(
            <CardanoObserver as ProvideInherent>::check_inherent(&call, &id2),
            Err(InherentError::Mismatch)
        ));
    });
}

#[test]
fn check_inherent_rejects_a_forged_sealed_block_hash_anchor() {
    new_test_ext().execute_with(|| {
        bind(A, ALICE);
        let local = snap(1000, &[(A, 200_000_000)]);
        let call = derive(&local);
        let mut id = InherentData::new();
        put_obs(&mut id, &local);
        assert!(<CardanoObserver as ProvideInherent>::check_inherent(&call, &id).is_ok());

        // Same slot, same entries, same commitment — but a different sealed stable-block anchor. Comparing
        // the FULL reference is what makes the header-sealed `cobs` anchor importer-checked.
        let forged = match call {
            crate::Call::observe {
                inputs_commitment,
                changes,
                stake_changes,
                role_changes,
                pending,
                ..
            } => crate::Call::observe {
                reference: CardanoRef {
                    slot: 1000,
                    block_hash: [0x77; 32],
                },
                inputs_commitment,
                changes,
                stake_changes,
                role_changes,
                pending,
            },
            _ => panic!("expected observe call"),
        };
        let err = <CardanoObserver as ProvideInherent>::check_inherent(&forged, &id)
            .expect_err("a forged anchor must be rejected");
        assert!(matches!(err, InherentError::Mismatch));
        assert!(err.is_fatal_error());
    });
}

#[test]
fn check_inherent_accepts_when_the_derived_delta_agrees_despite_a_commitment_diff() {
    new_test_ext().execute_with(|| {
        bind(A, ALICE);
        // Two honest nodes whose raw candidate sets differ only in UTxOs the reduction drops (too fresh,
        // already spent) reduce to the same entries and therefore derive the same delta. The commitment
        // must NEVER reject on its own.
        let author_obs = snap_full(1000, COMMIT, &[(A, 200_000_000)], &[], &[]);
        let call = derive(&author_obs);
        let local = snap_full(1000, COMMIT2, &[(A, 200_000_000)], &[], &[]);
        let mut id = InherentData::new();
        put_obs(&mut id, &local);
        assert!(<CardanoObserver as ProvideInherent>::check_inherent(&call, &id).is_ok());
    });
}

#[test]
fn check_inherent_cannot_verify_when_local_source_behind_is_non_fatal() {
    new_test_ext().execute_with(|| {
        bind(A, ALICE);
        let call = derive(&snap(1000, &[(A, 200_000_000)]));
        // The importer has no observation of its own (db-sync down or behind).
        let id = InherentData::new();
        let err = <CardanoObserver as ProvideInherent>::check_inherent(&call, &id)
            .expect_err("no local data cannot be verified");
        assert!(matches!(err, InherentError::CannotVerify));
        assert!(
            !err.is_fatal_error(),
            "a lagging follower must never fork the chain",
        );
    });
}

#[test]
fn check_inherent_rejects_differing_stake_changes_as_mismatch() {
    new_test_ext().execute_with(|| {
        bind_stake(S1, ALICE);
        bind_stake(S2, BOB);
        // Identical vault half (and identical commitment); the stake halves disagree. The commitment covers
        // the VAULT candidate set only, so there is nothing to appeal to on the stake axis — a difference
        // there is always a data mismatch.
        let author_obs = snap_stake(1000, &[], &[(S1, 700_000_000)]);
        let call = derive(&author_obs);
        let local = snap_stake(1000, &[], &[(S2, 500_000_000)]);
        let mut id = InherentData::new();
        put_obs(&mut id, &local);
        assert!(matches!(
            <CardanoObserver as ProvideInherent>::check_inherent(&call, &id),
            Err(InherentError::Mismatch)
        ));
    });
}

#[test]
fn observe_call_is_recognised_as_an_inherent() {
    // Deliberately NOT wrapped in externalities: `is_inherent` must stay storage-free, or the pool would
    // panic instead of rejecting. (`create_inherent` and `check_inherent` DO read state — they run inside
    // the block builder and the import path, which both provide the parent's externalities.)
    let call = crate::Call::<Test>::observe {
        reference: cref(1),
        inputs_commitment: COMMIT,
        changes: BoundedVec::new(),
        stake_changes: BoundedVec::new(),
        role_changes: BoundedVec::new(),
        pending: 0,
    };
    assert!(<CardanoObserver as ProvideInherent>::is_inherent(&call));
}

// ── the vault axis ─────────────────────────────────────────────────────────────────────────────────

#[test]
fn observe_applies_weight_to_bound_accounts_and_skips_unbound() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind(A, ALICE);
        // B is bound to nobody.
        observe_snapshot(&snap(
            MAX_REFERENCE - 1,
            &[(A, 200_000_000), (B, 300_000_000)],
        ));
        assert_eq!(weight_of(ALICE), 200_000_000);
        assert!(
            !was_written(BOB),
            "an unbound beacon is skipped, not an error"
        );
        System::assert_has_event(RuntimeEvent::CardanoObserver(Event::ObservationApplied {
            reference_slot: MAX_REFERENCE - 1,
            credited: 1,
            cleared: 0,
            skipped: 0,
            enforced: true,
        }));
    });
}

#[test]
fn observe_applies_min_lock_floor() {
    new_test_ext().execute_with(|| {
        enforce();
        bind(A, ALICE);
        // Below MIN_LOCK maps to weight 0 — credited at zero, not skipped.
        observe_snapshot(&snap(MAX_REFERENCE - 1, &[(A, MIN_LOCK - 1)]));
        assert!(was_written(ALICE));
        assert_eq!(weight_of(ALICE), 0);
        // The basis records the FLOORED value, so a second sub-floor observation is a no-op rather than
        // churning a change every block.
        assert_eq!(LastObserved::<Test>::get(A), Some((ALICE, 0)));
        assert_eq!(
            change_counts(&derive(&snap(MAX_REFERENCE - 1, &[(A, MIN_LOCK - 2)]))),
            (0, 0, 0),
            "two different sub-floor amounts are the same applied weight",
        );
    });
}

#[test]
fn observe_skips_over_max_stake_weight_without_bricking_the_block() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind(A, ALICE);
        bind(B, BOB);
        // Built directly: `create_inherent` filters an over-cap entry out, so this is the payload a hand-
        // built or hostile inherent would carry. It must SKIP, not `Err` — an `Err` from a Mandatory
        // dispatch is `BadMandatory`, which discards the whole block.
        assert_ok!(dispatch(crate::Call::observe {
            reference: cref(MAX_REFERENCE - 1),
            inputs_commitment: COMMIT,
            changes: BoundedVec::truncate_from(vec![
                (A, Some(200_000_000)),
                (B, Some(MAX_STAKE_WEIGHT + 1)),
            ]),
            stake_changes: BoundedVec::new(),
            role_changes: BoundedVec::new(),
            pending: 0,
        }));
        assert_eq!(weight_of(ALICE), 200_000_000);
        assert!(
            !was_written(BOB),
            "the over-cap value is not consensus-pinned"
        );
        System::assert_has_event(RuntimeEvent::CardanoObserver(Event::ObservationApplied {
            reference_slot: MAX_REFERENCE - 1,
            credited: 1,
            cleared: 0,
            skipped: 1,
            enforced: true,
        }));
    });
}

#[test]
fn a_beacon_absent_from_the_delta_keeps_its_weight() {
    new_test_ext().execute_with(|| {
        // The inverse of the old full-snapshot rule, and the single most important semantic change in the
        // payload: absence used to MEAN "unlocked", and now means "unchanged". A test that expresses an
        // unlock by simply omitting a key would silently stop meaning what it says.
        enforce();
        bind(A, ALICE);
        bind(B, BOB);
        observe_snapshot(&snap(
            MAX_REFERENCE - 3,
            &[(A, 200_000_000), (B, 300_000_000)],
        ));
        assert_eq!(weight_of(BOB), 300_000_000);

        // A delta that mentions only A. B is untouched.
        assert_ok!(dispatch(crate::Call::observe {
            reference: cref(MAX_REFERENCE - 2),
            inputs_commitment: COMMIT,
            changes: BoundedVec::truncate_from(vec![(A, Some(250_000_000))]),
            stake_changes: BoundedVec::new(),
            role_changes: BoundedVec::new(),
            pending: 0,
        }));
        assert_eq!(weight_of(ALICE), 250_000_000);
        assert_eq!(
            weight_of(BOB),
            300_000_000,
            "absence from a delta is not an unlock",
        );
    });
}

#[test]
fn an_explicit_none_clears_a_beacon() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind(A, ALICE);
        bind(B, BOB);
        observe_snapshot(&snap(
            MAX_REFERENCE - 3,
            &[(A, 200_000_000), (B, 300_000_000)],
        ));

        // B unlocks: it leaves the snapshot, and the diff turns that into an explicit `(B, None)`.
        let call = derive(&snap(MAX_REFERENCE - 2, &[(A, 200_000_000)]));
        match &call {
            crate::Call::observe { changes, .. } => {
                assert_eq!(changes.to_vec(), vec![(B, None)])
            }
            _ => panic!("expected observe call"),
        }
        assert_ok!(dispatch(call));
        assert_eq!(weight_of(BOB), 0);
        assert_eq!(weight_of(ALICE), 200_000_000, "A is untouched");
        assert!(LastObserved::<Test>::get(B).is_none());
        System::assert_has_event(RuntimeEvent::CardanoObserver(Event::ObservationApplied {
            reference_slot: MAX_REFERENCE - 2,
            credited: 0,
            cleared: 1,
            skipped: 0,
            enforced: true,
        }));
    });
}

#[test]
fn an_unlock_zeroes_the_account_from_the_basis_not_the_resolver() {
    new_test_ext().execute_with(|| {
        // A beacon whose identity binding is revoked (or rebound) no longer resolves to the account that
        // holds the weight. The unlock has to reach that account anyway, or `AllowedStake` is left standing
        // with no locked ADA behind it — so the account comes out of the BASIS.
        enforce();
        bind(A, ALICE);
        observe_snapshot(&snap(MAX_REFERENCE - 3, &[(A, 200_000_000)]));
        assert_eq!(weight_of(ALICE), 200_000_000);

        // The binding moves to BOB (a revoke-and-rebind), and A unlocks in the same window.
        bind(A, BOB);
        assert_ok!(dispatch(crate::Call::observe {
            reference: cref(MAX_REFERENCE - 2),
            inputs_commitment: COMMIT,
            changes: BoundedVec::truncate_from(vec![(A, None)]),
            stake_changes: BoundedVec::new(),
            role_changes: BoundedVec::new(),
            pending: 0,
        }));
        assert_eq!(
            weight_of(ALICE),
            0,
            "the account that HELD the weight is the one zeroed",
        );
        assert!(!was_written(BOB), "and the new binding is not touched");
    });
}

#[test]
fn a_rebound_beacon_is_re_applied_to_the_new_account() {
    new_test_ext().execute_with(|| {
        // The account is part of the diff comparison, not just the weight — otherwise a beacon rebound to
        // a different account at an unchanged lovelace would produce no change and the new owner would
        // never be credited.
        enforce();
        bind(A, ALICE);
        let obs = snap(MAX_REFERENCE - 3, &[(A, 200_000_000)]);
        observe_snapshot(&obs);
        assert_eq!(weight_of(ALICE), 200_000_000);

        bind(A, BOB);
        let call = derive(&obs);
        assert_eq!(change_counts(&call), (1, 0, 0));
        assert_ok!(dispatch(call));
        assert_eq!(weight_of(BOB), 200_000_000);
        assert_eq!(LastObserved::<Test>::get(A), Some((BOB, 200_000_000)));
    });
}

// ── the voting-power axis ──────────────────────────────────────────────────────────────────────────

#[test]
fn observe_applies_voting_power_to_bound_stake_creds_and_skips_unbound() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind_stake(S1, ALICE);
        // No MIN_LOCK floor on this axis — total stake counts at any size.
        observe_snapshot(&snap_stake(
            MAX_REFERENCE - 1,
            &[],
            &[(S1, 700_000_000), (S2, 5)],
        ));
        assert_eq!(voting_power_of(ALICE), 700_000_000);
        assert!(!vp_was_written(BOB));
        System::assert_has_event(RuntimeEvent::CardanoObserver(Event::VotingPowerObserved {
            reference_slot: MAX_REFERENCE - 1,
            credited: 1,
            cleared: 0,
            skipped: 0,
            enforced: true,
        }));
    });
}

#[test]
fn observe_skips_voting_power_over_max_without_bricking_the_block() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind_stake(S1, ALICE);
        bind_stake(S2, BOB);
        assert_ok!(dispatch(crate::Call::observe {
            reference: cref(MAX_REFERENCE - 1),
            inputs_commitment: COMMIT,
            changes: BoundedVec::new(),
            stake_changes: BoundedVec::truncate_from(vec![
                (S1, Some(700_000_000)),
                (S2, Some(MAX_STAKE_WEIGHT + 1)),
            ]),
            role_changes: BoundedVec::new(),
            pending: 0,
        }));
        assert_eq!(voting_power_of(ALICE), 700_000_000);
        assert!(!vp_was_written(BOB));
        System::assert_has_event(RuntimeEvent::CardanoObserver(Event::VotingPowerObserved {
            reference_slot: MAX_REFERENCE - 1,
            credited: 1,
            cleared: 0,
            skipped: 1,
            enforced: true,
        }));
    });
}

#[test]
fn a_dropped_stake_cred_is_zeroed_by_an_explicit_none() {
    new_test_ext().execute_with(|| {
        enforce();
        bind_stake(S1, ALICE);
        bind_stake(S2, BOB);
        observe_snapshot(&snap_stake(
            MAX_REFERENCE - 3,
            &[],
            &[(S1, 700_000_000), (S2, 500_000_000)],
        ));
        assert_eq!(voting_power_of(BOB), 500_000_000);

        let call = derive(&snap_stake(MAX_REFERENCE - 2, &[], &[(S1, 700_000_000)]));
        match &call {
            crate::Call::observe { stake_changes, .. } => {
                assert_eq!(stake_changes.to_vec(), vec![(S2, None)])
            }
            _ => panic!("expected observe call"),
        }
        assert_ok!(dispatch(call));
        assert_eq!(voting_power_of(BOB), 0);
        assert_eq!(voting_power_of(ALICE), 700_000_000);
        assert!(LastObservedStake::<Test>::get(S2).is_none());
    });
}

// ── the freeze / re-enable discipline ──────────────────────────────────────────────────────────────

#[test]
fn frozen_mode_verifies_but_never_writes_weight() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        bind(A, ALICE);
        freeze();
        observe_snapshot(&snap(MAX_REFERENCE - 1, &[(A, 200_000_000)]));
        assert!(
            !was_written(ALICE),
            "frozen: the read is verified but no weight is applied",
        );
        System::assert_has_event(RuntimeEvent::CardanoObserver(Event::ObservationApplied {
            reference_slot: MAX_REFERENCE - 1,
            credited: 1,
            cleared: 0,
            skipped: 0,
            enforced: false,
        }));
    });
}

#[test]
fn a_freeze_holds_the_basis_so_the_same_delta_is_re_derived_every_block() {
    new_test_ext().execute_with(|| {
        // The mechanism the three `re_enable_*` tests below depend on, stated on its own. Freezing gates
        // the BASIS writes as well as the sink writes, so the diff is taken against unchanged state and
        // re-derives the identical change set. Gating only the sink would record the change as applied
        // while never applying it — and it would never be re-sent.
        bind(A, ALICE);
        freeze();
        let obs = snap(MAX_REFERENCE - 3, &[(A, 200_000_000)]);
        observe_snapshot(&obs);
        assert!(LastObserved::<Test>::get(A).is_none(), "basis held");
        assert_eq!(
            change_counts(&derive(&obs)),
            (1, 0, 0),
            "the same change is still outstanding",
        );

        enforce();
        observe_snapshot(&obs);
        assert_eq!(weight_of(ALICE), 200_000_000);
        assert_eq!(LastObserved::<Test>::get(A), Some((ALICE, 200_000_000)));
    });
}

#[test]
fn re_enable_clamps_an_account_that_unlocked_during_a_freeze() {
    new_test_ext().execute_with(|| {
        enforce();
        bind(A, ALICE);
        bind(B, BOB);
        observe_snapshot(&snap(
            MAX_REFERENCE - 5,
            &[(A, 200_000_000), (B, 300_000_000)],
        ));
        assert_eq!(weight_of(BOB), 300_000_000);

        // B unlocks DURING a freeze. Nothing is written, and — critically — the basis still says B is
        // credited, so the unlock is still outstanding.
        freeze();
        observe_snapshot(&snap(MAX_REFERENCE - 4, &[(A, 200_000_000)]));
        assert_eq!(
            weight_of(BOB),
            300_000_000,
            "frozen: weight holds at its last value",
        );

        // Re-enabling applies it. Without the held basis, B would have been recorded as already handled
        // and would keep a stale-positive weight for ever: voice not backed by locked ADA.
        enforce();
        observe_snapshot(&snap(MAX_REFERENCE - 3, &[(A, 200_000_000)]));
        assert_eq!(weight_of(BOB), 0);
    });
}

#[test]
fn re_enable_clamps_a_stake_cred_that_dropped_out_during_a_freeze() {
    new_test_ext().execute_with(|| {
        enforce();
        bind_stake(S1, ALICE);
        bind_stake(S2, BOB);
        observe_snapshot(&snap_stake(
            MAX_REFERENCE - 5,
            &[],
            &[(S1, 700_000_000), (S2, 300_000_000)],
        ));
        assert_eq!(voting_power_of(BOB), 300_000_000);

        freeze();
        observe_snapshot(&snap_stake(MAX_REFERENCE - 4, &[], &[(S1, 700_000_000)]));
        assert_eq!(voting_power_of(BOB), 300_000_000);

        enforce();
        observe_snapshot(&snap_stake(MAX_REFERENCE - 3, &[], &[(S1, 700_000_000)]));
        assert_eq!(voting_power_of(BOB), 0);
    });
}

#[test]
fn frozen_mode_verifies_voting_power_but_never_writes_it() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        bind_stake(S1, ALICE);
        freeze();
        observe_snapshot(&snap_stake(MAX_REFERENCE - 1, &[], &[(S1, 700_000_000)]));
        assert!(!vp_was_written(ALICE));
        System::assert_has_event(RuntimeEvent::CardanoObserver(Event::VotingPowerObserved {
            reference_slot: MAX_REFERENCE - 1,
            credited: 1,
            cleared: 0,
            skipped: 0,
            enforced: false,
        }));
    });
}

// ── reference bounds ───────────────────────────────────────────────────────────────────────────────

#[test]
fn observe_skips_a_regressing_reference_without_discarding_the_block() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind(A, ALICE);
        observe_snapshot(&snap(MAX_REFERENCE - 5, &[(A, 200_000_000)]));
        assert_eq!(LastReference::<Test>::get(), Some(cref(MAX_REFERENCE - 5)));
        let applied_at = crate::LastAppliedAt::<Test>::get();

        // An OLDER reference is skipped, not `Err`'d. An `Err` from a Mandatory dispatch is
        // `BadMandatory`, which discards the whole block — and since the reference is a pure function of
        // the parent, the next slot would recompute the same one and fail identically, for ever.
        System::set_block_number(5);
        assert_ok!(dispatch(crate::Call::observe {
            reference: cref(MAX_REFERENCE - 50),
            inputs_commitment: COMMIT,
            changes: BoundedVec::truncate_from(vec![(A, Some(999_000_000))]),
            stake_changes: BoundedVec::new(),
            role_changes: BoundedVec::new(),
            pending: 0,
        }));
        assert_eq!(weight_of(ALICE), 200_000_000, "nothing applied");
        assert_eq!(
            LastReference::<Test>::get(),
            Some(cref(MAX_REFERENCE - 5)),
            "and the frontier is not rewound",
        );
        assert_eq!(
            crate::LastAppliedAt::<Test>::get(),
            applied_at,
            "a skipped observation does not stamp the clock, so a persistent skip latches the alarm",
        );
    });
}

#[test]
fn observe_skips_a_too_fresh_reference() {
    new_test_ext().execute_with(|| {
        enforce();
        bind(A, ALICE);
        // One slot inside the Cardano rollback window.
        assert_ok!(dispatch(crate::Call::observe {
            reference: cref(MAX_REFERENCE + 1),
            inputs_commitment: COMMIT,
            changes: BoundedVec::truncate_from(vec![(A, Some(200_000_000))]),
            stake_changes: BoundedVec::new(),
            role_changes: BoundedVec::new(),
            pending: 0,
        }));
        assert!(!was_written(ALICE));
        assert!(LastReference::<Test>::get().is_none());

        // Exactly at the bound is accepted — the boundary is pinned.
        observe_snapshot(&snap(MAX_REFERENCE, &[(A, 200_000_000)]));
        assert_eq!(weight_of(ALICE), 200_000_000);
        assert_eq!(LastReference::<Test>::get(), Some(cref(MAX_REFERENCE)));
    });
}

#[test]
fn observe_requires_the_none_origin() {
    new_test_ext().execute_with(|| {
        // Defence in depth on top of `is_inherent` (which already makes this pool-inadmissible).
        assert!(CardanoObserver::observe(
            RuntimeOrigin::signed(ALICE),
            cref(MAX_REFERENCE - 1),
            COMMIT,
            BoundedVec::new(),
            BoundedVec::new(),
            BoundedVec::new(),
            0,
        )
        .is_err());
    });
}

// ── idempotence and re-execution ───────────────────────────────────────────────────────────────────

#[test]
fn applying_the_same_delta_twice_is_idempotent() {
    new_test_ext().execute_with(|| {
        // A Substrate re-org RE-EXECUTES the Mandatory `observe`. Every change is an absolute SET (or an
        // absolute clear), never an increment, so replaying one lands on the same state.
        enforce();
        bind(A, ALICE);
        bind(B, BOB);
        observe_snapshot(&snap(
            MAX_REFERENCE - 5,
            &[(A, 200_000_000), (B, 300_000_000)],
        ));
        let call = derive(&snap(MAX_REFERENCE - 4, &[(A, 250_000_000)]));

        assert_ok!(dispatch(call.clone()));
        let after_first = (weight_of(ALICE), weight_of(BOB));
        assert_eq!(after_first, (250_000_000, 0));

        assert_ok!(dispatch(call));
        assert_eq!(
            (weight_of(ALICE), weight_of(BOB)),
            after_first,
            "replaying a delta converges on the same state, it does not accumulate",
        );
        assert_eq!(LastObserved::<Test>::get(A), Some((ALICE, 250_000_000)));
        assert!(LastObserved::<Test>::get(B).is_none());
    });
}

#[test]
fn a_delta_replayed_against_a_changed_base_still_lands_on_the_right_state() {
    new_test_ext().execute_with(|| {
        // The sharper version of the above, and the one a delta design actually has to answer: replaying a
        // change against a DIFFERENT basis. Because each change carries an absolute value and the basis is
        // rewritten from it (rather than adjusted by it), the outcome is the value in the change either
        // way — and the next block's diff re-derives anything the replay left behind.
        enforce();
        bind(A, ALICE);
        observe_snapshot(&snap(MAX_REFERENCE - 5, &[(A, 200_000_000)]));
        let call = derive(&snap(MAX_REFERENCE - 4, &[(A, 250_000_000)]));

        // Something else moves the basis on before the replay (the re-org's competing branch).
        observe_snapshot(&snap(MAX_REFERENCE - 4, &[(A, 900_000_000)]));
        assert_eq!(weight_of(ALICE), 900_000_000);

        assert_ok!(dispatch(call));
        assert_eq!(weight_of(ALICE), 250_000_000);
        assert_eq!(
            LastObserved::<Test>::get(A),
            Some((ALICE, 250_000_000)),
            "the basis agrees with what was actually applied, so the next diff is correct",
        );
        // And the next honest block puts it right.
        observe_snapshot(&snap(MAX_REFERENCE - 3, &[(A, 900_000_000)]));
        assert_eq!(weight_of(ALICE), 900_000_000);
    });
}

// ── set_enforcement ────────────────────────────────────────────────────────────────────────────────

#[test]
fn set_enforcement_is_gated_by_the_enforce_origin() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert!(
            crate::EnforceWeight::<Test>::get(),
            "the observer is the sole weight writer from genesis, so enforcement defaults ON",
        );
        assert!(
            CardanoObserver::set_enforcement(RuntimeOrigin::signed(ALICE), false).is_err(),
            "a signed caller cannot flip the emergency freeze",
        );
        assert!(crate::EnforceWeight::<Test>::get(), "and it is unchanged");

        assert_ok!(CardanoObserver::set_enforcement(
            RuntimeOrigin::root(),
            false
        ));
        assert!(!crate::EnforceWeight::<Test>::get());
        System::assert_last_event(RuntimeEvent::CardanoObserver(Event::EnforcementSet {
            enabled: false,
        }));
        assert_ok!(CardanoObserver::set_enforcement(
            RuntimeOrigin::root(),
            true
        ));
        assert!(crate::EnforceWeight::<Test>::get());
    });
}

#[test]
fn set_enforcement_is_not_an_inherent() {
    // The mutual-exclusion invariant: only `observe` is an inherent, so `set_enforcement` stays a normal
    // pool-admissible governance call.
    let call = crate::Call::<Test>::set_enforcement { enabled: false };
    assert!(!<CardanoObserver as ProvideInherent>::is_inherent(&call));
}

// ── the stall alarm ────────────────────────────────────────────────────────────────────────────────

fn roll_to(to: u64) {
    let mut n = System::block_number();
    while n < to {
        n += 1;
        System::set_block_number(n);
        CardanoObserver::on_initialize(n);
    }
}

fn stalled_events() -> usize {
    System::events()
        .iter()
        .filter(|r| {
            matches!(
                r.event,
                RuntimeEvent::CardanoObserver(Event::ObservationStalled { .. })
            )
        })
        .count()
}

#[test]
fn a_persistent_regressed_reference_latches_the_stall_alarm_instead_of_wedging() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        bind(A, ALICE);
        observe_once(MAX_REFERENCE - 5);
        // Every following block proposes an OLDER reference, so every one skips and none stamps the clock.
        for n in 2..=(STALL_AFTER + 2) {
            System::set_block_number(n);
            CardanoObserver::on_initialize(n);
            assert_ok!(dispatch(crate::Call::observe {
                reference: cref(MAX_REFERENCE - 50),
                inputs_commitment: COMMIT,
                changes: BoundedVec::new(),
                stake_changes: BoundedVec::new(),
                role_changes: BoundedVec::new(),
                pending: 0,
            }));
        }
        assert!(crate::Stalled::<Test>::get());
        assert_eq!(
            stalled_events(),
            1,
            "latched: once per episode, not per block"
        );
    });
}

#[test]
fn stall_alarm_latches_exactly_once_and_clears_on_the_next_observation() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        bind(A, ALICE);
        observe_once(MAX_REFERENCE - 100);
        assert_eq!(crate::LastAppliedAt::<Test>::get(), 1);

        // A gap of exactly StallAfter is not a stall.
        roll_to(1 + STALL_AFTER);
        assert!(!crate::Stalled::<Test>::get());
        assert_eq!(stalled_events(), 0);

        // One block past it latches, exactly once.
        roll_to(2 + STALL_AFTER);
        assert!(crate::Stalled::<Test>::get());
        assert_eq!(stalled_events(), 1);
        System::assert_last_event(RuntimeEvent::CardanoObserver(Event::ObservationStalled {
            last_applied: 1,
            blocks: STALL_AFTER + 1,
        }));
        roll_to(5 + STALL_AFTER);
        assert_eq!(stalled_events(), 1, "still once");

        // The next applied observation clears it and reports the whole gap.
        let now = System::block_number();
        observe_once(MAX_REFERENCE - 99);
        assert!(!crate::Stalled::<Test>::get());
        System::assert_has_event(RuntimeEvent::CardanoObserver(Event::ObservationResumed {
            blocks: now - 1,
        }));
    });
}

#[test]
fn no_alarm_while_observations_keep_landing() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        bind(A, ALICE);
        for n in 1..=(STALL_AFTER * 3) {
            System::set_block_number(n);
            CardanoObserver::on_initialize(n);
            observe_once(MAX_REFERENCE - 200 + n);
        }
        assert!(!crate::Stalled::<Test>::get());
        assert_eq!(stalled_events(), 0);
        assert_eq!(crate::LastAppliedAt::<Test>::get(), STALL_AFTER * 3);
    });
}

#[test]
fn a_draining_backlog_is_not_a_stall() {
    new_test_ext().execute_with(|| {
        // A backlog must not read as a stopped writer. Each draining block applies a page and stamps the
        // clock, so the alarm stays quiet across a drain far longer than `StallAfter`.
        System::set_block_number(1);
        let n = MAX_CHANGES_PER_BLOCK * (STALL_AFTER as u32 + 3);
        let mut items = Vec::new();
        for i in 0..n {
            bind(nth_beacon(i), nth_account(i));
            items.push((nth_beacon(i), 200_000_000u128));
        }
        let obs = snap(MAX_REFERENCE - 5, &items);

        let mut block = 1u64;
        loop {
            block += 1;
            System::set_block_number(block);
            CardanoObserver::on_initialize(block);
            if observe_snapshot(&obs) == 0 {
                break;
            }
            assert!(
                !crate::Stalled::<Test>::get(),
                "a draining block is an APPLIED observation",
            );
        }
        assert!(
            block > STALL_AFTER + 1,
            "the drain outlasted the alarm window"
        );
        assert_eq!(stalled_events(), 0);
        assert_eq!(LastReference::<Test>::get(), Some(cref(MAX_REFERENCE - 5)));
    });
}

#[test]
fn a_zero_clock_anchors_at_the_current_block_instead_of_alarming() {
    new_test_ext().execute_with(|| {
        // A chain upgraded INTO this alarm must not read its whole history as one enormous stall.
        System::set_block_number(500_000);
        CardanoObserver::on_initialize(500_000);
        assert_eq!(crate::LastAppliedAt::<Test>::get(), 500_000);
        assert!(!crate::Stalled::<Test>::get());
        assert_eq!(stalled_events(), 0);
    });
}

#[test]
fn a_chain_that_never_observed_does_not_alarm() {
    new_test_ext().execute_with(|| {
        // `--dev` is exactly this: no db-sync, so no observation ever lands. "The sole weight writer has
        // STOPPED" is a false statement about a chain that never started.
        System::set_block_number(1);
        roll_to(STALL_AFTER * 4);
        assert!(!crate::Stalled::<Test>::get());
        assert_eq!(stalled_events(), 0);

        // The first accepted observation ARMS it; a gap after that latches.
        bind(A, ALICE);
        observe_once(MAX_REFERENCE - 100);
        roll_to(System::block_number() + STALL_AFTER + 2);
        assert!(crate::Stalled::<Test>::get());
    });
}

#[test]
fn a_frozen_observation_still_stamps_the_clock() {
    new_test_ext().execute_with(|| {
        // A governance freeze is a deliberate state, not a stalled observer: the read is still verified
        // cross-node every block.
        System::set_block_number(1);
        bind(A, ALICE);
        freeze();
        for n in 1..=(STALL_AFTER * 2) {
            System::set_block_number(n);
            CardanoObserver::on_initialize(n);
            observe_once(MAX_REFERENCE - 200 + n);
        }
        assert!(!was_written(ALICE), "frozen: nothing applied");
        assert!(!crate::Stalled::<Test>::get());
        assert_eq!(stalled_events(), 0);
    });
}

// ── the role axis ──────────────────────────────────────────────────────────────────────────────────

const CAL: [u8; 28] = [0xD1; 28];
const STAKE_OWNER: [u8; 28] = [0xD2; 28];
const POOL_A: [u8; 28] = [0xE1; 28];
const POOL_B: [u8; 28] = [0xE2; 28];

#[test]
fn observe_credits_then_clears_roles() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind_role(CAL, ALICE);
        observe_snapshot(&snap_roles(
            MAX_REFERENCE - 5,
            &roles(&[(RoleSource::SpoCalidus, CAL, POOL_A)]),
        ));
        assert_eq!(observed_roles_of(ALICE), vec![(0u8, POOL_A)]);

        // The pool retires (or the claim lapses): the account leaves the observation, and the diff turns
        // that into an explicit clear carrying the ACCOUNT — which is why it still works after the
        // credential itself has stopped resolving.
        let call = derive(&snap_roles(MAX_REFERENCE - 4, &[]));
        match &call {
            crate::Call::observe { role_changes, .. } => {
                assert_eq!(role_changes.len(), 1);
                assert_eq!(role_changes[0].who, ALICE);
                assert!(role_changes[0].roles.is_none());
            }
            _ => panic!("expected observe call"),
        }
        assert_ok!(dispatch(call));
        assert!(observed_roles_of(ALICE).is_empty());
        assert!(LastObservedRoles::<Test>::get(ALICE).is_none());
    });
}

#[test]
fn observe_skips_an_unresolved_role_credential() {
    new_test_ext().execute_with(|| {
        enforce();
        // CAL is bound to nobody.
        let call = derive(&snap_roles(
            MAX_REFERENCE - 5,
            &roles(&[(RoleSource::SpoCalidus, CAL, POOL_A)]),
        ));
        assert_eq!(change_counts(&call), (0, 0, 0));
        assert_ok!(dispatch(call));
        assert!(observed_roles_of(ALICE).is_empty());
    });
}

#[test]
fn observe_carries_chamber_weight_into_the_role_set() {
    new_test_ext().execute_with(|| {
        enforce();
        bind_role(STAKE_OWNER, ALICE);
        observe_snapshot(&snap_roles(
            MAX_REFERENCE - 5,
            &roles_w(&[(
                RoleSource::SpoOwner,
                STAKE_OWNER,
                POOL_A,
                15_000_000_000_000,
            )]),
        ));
        assert_eq!(
            observed_roles_full_of(ALICE),
            vec![(0u8, POOL_A, 15_000_000_000_000)],
            "the spec-207 chamber weight rides through verbatim",
        );
    });
}

#[test]
fn one_account_with_several_credentials_lands_as_one_atomic_set() {
    new_test_ext().execute_with(|| {
        // THE reason the role change unit is an ACCOUNT and not a credential. The sink OVERWRITES an
        // account's whole badge set, and an mSPO reaches its badges through several credentials. A
        // per-credential delta could split them across two blocks, and the first block's overwrite would
        // drop the badges the second was going to restore.
        enforce();
        bind_role(CAL, ALICE);
        bind_role(STAKE_OWNER, ALICE);
        let call = derive(&snap_roles(
            MAX_REFERENCE - 5,
            &roles_w(&[
                (RoleSource::SpoCalidus, CAL, POOL_A, 1_000_000),
                (RoleSource::SpoOwner, STAKE_OWNER, POOL_B, 2_000_000),
            ]),
        ));
        match &call {
            crate::Call::observe { role_changes, .. } => {
                assert_eq!(role_changes.len(), 1, "ONE change, not one per credential");
                assert_eq!(role_changes[0].who, ALICE);
                assert_eq!(
                    role_changes[0].roles.as_ref().unwrap().to_vec(),
                    vec![(0u8, POOL_A, 1_000_000), (0u8, POOL_B, 2_000_000)],
                );
            }
            _ => panic!("expected observe call"),
        }
        assert_ok!(dispatch(call));
        assert_eq!(
            observed_roles_of(ALICE),
            vec![(0u8, POOL_A), (0u8, POOL_B)],
            "both badges, from one write",
        );
    });
}

#[test]
fn a_pool_reached_through_two_paths_is_deduped_once() {
    new_test_ext().execute_with(|| {
        // The mSPO case: several declaring pools each get their own badge, but the SAME pool reached
        // through both the Calidus and the owner path collapses to ONE entry (never double-counted in a
        // chamber tally). First-wins in the canonical order keeps the value byte-stable across nodes.
        enforce();
        bind_role(CAL, ALICE);
        bind_role(STAKE_OWNER, ALICE);
        observe_snapshot(&snap_roles(
            MAX_REFERENCE - 5,
            &roles_w(&[
                (RoleSource::SpoCalidus, CAL, POOL_A, 1_000_000),
                (RoleSource::SpoCalidus, CAL, POOL_B, 2_000_000),
                (RoleSource::SpoOwner, STAKE_OWNER, POOL_B, 2_000_000),
            ]),
        ));
        assert_eq!(
            observed_roles_full_of(ALICE),
            vec![(0u8, POOL_A, 1_000_000), (0u8, POOL_B, 2_000_000)],
        );
    });
}

#[test]
fn a_role_set_that_did_not_move_produces_no_change() {
    new_test_ext().execute_with(|| {
        enforce();
        bind_role(CAL, ALICE);
        let obs = snap_roles(
            MAX_REFERENCE - 5,
            &roles_w(&[(RoleSource::SpoCalidus, CAL, POOL_A, 1_000_000)]),
        );
        observe_snapshot(&obs);
        assert_eq!(change_counts(&derive(&obs)), (0, 0, 0));

        // But a changed chamber WEIGHT at the same badge does move it — the weight is part of the set the
        // diff compares, not decoration.
        let heavier = snap_roles(
            MAX_REFERENCE - 4,
            &roles_w(&[(RoleSource::SpoCalidus, CAL, POOL_A, 9_000_000)]),
        );
        assert_eq!(change_counts(&derive(&heavier)), (0, 0, 1));
        observe_snapshot(&heavier);
        assert_eq!(
            observed_roles_full_of(ALICE),
            vec![(0u8, POOL_A, 9_000_000)],
        );
    });
}

#[test]
fn re_enable_clears_a_role_that_lapsed_during_a_freeze() {
    new_test_ext().execute_with(|| {
        enforce();
        bind_role(CAL, ALICE);
        observe_snapshot(&snap_roles(
            MAX_REFERENCE - 5,
            &roles(&[(RoleSource::SpoCalidus, CAL, POOL_A)]),
        ));
        assert_eq!(observed_roles_of(ALICE), vec![(0u8, POOL_A)]);

        freeze();
        observe_snapshot(&snap_roles(MAX_REFERENCE - 4, &[]));
        assert_eq!(
            observed_roles_of(ALICE),
            vec![(0u8, POOL_A)],
            "frozen: the badge holds",
        );

        enforce();
        observe_snapshot(&snap_roles(MAX_REFERENCE - 3, &[]));
        assert!(
            observed_roles_of(ALICE).is_empty(),
            "and re-enabling clears it, rather than leaving a stale-positive badge",
        );
    });
}

#[test]
fn the_roles_observed_event_reports_change_counts() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        enforce();
        bind_role(CAL, ALICE);
        bind_role(STAKE_OWNER, BOB);
        observe_snapshot(&snap_roles(
            MAX_REFERENCE - 5,
            &roles(&[
                (RoleSource::SpoCalidus, CAL, POOL_A),
                (RoleSource::SpoOwner, STAKE_OWNER, POOL_B),
            ]),
        ));
        System::assert_has_event(RuntimeEvent::CardanoObserver(Event::RolesObserved {
            reference_slot: MAX_REFERENCE - 5,
            credited: 2,
            cleared: 0,
            enforced: true,
        }));

        // BOB's pool retires.
        observe_snapshot(&snap_roles(
            MAX_REFERENCE - 4,
            &roles(&[(RoleSource::SpoCalidus, CAL, POOL_A)]),
        ));
        System::assert_has_event(RuntimeEvent::CardanoObserver(Event::RolesObserved {
            reference_slot: MAX_REFERENCE - 4,
            credited: 0,
            cleared: 1,
            enforced: true,
        }));
    });
}

// ── storage migration v0 → v1 ──────────────────────────────────────────────────────────────────────

mod migration {
    use super::*;
    use crate::migrations::legacy::blob::{
        LastObserved as LastObservedV0, LastObservedRoles as LastObservedRolesV0,
        LastObservedStake as LastObservedStakeV0,
    };
    use crate::migrations::v1::MigrateV0ToV1;
    use frame_support::traits::{GetStorageVersion, OnRuntimeUpgrade, StorageVersion};

    #[test]
    fn legacy_prefixes_match_the_live_items() {
        new_test_ext().execute_with(|| {
            // THE trap this whole `legacy` module exists to avoid. `#[storage_alias]` takes the on-chain
            // item name from the ALIAS TYPE NAME, so a `LastObservedV0` alias would address
            // `twox128("CardanoObserver") ++ twox128("LastObservedV0")` — a prefix nothing has ever
            // written. The migration would then iterate zero rows, report success, and orphan every real
            // one. Unit tests cannot catch that on their own (they read and write through the same wrong
            // prefix, so they agree with themselves), which is why these assert against the PALLET's own
            // items rather than against the aliases.
            //
            // 32 bytes: twox128(pallet) ++ twox128(item). A StorageValue is exactly that; a StorageMap key
            // is that plus the hashed key, so the first 32 bytes have to agree.
            assert_eq!(
                LastObservedV0::<Test>::hashed_key()[..],
                LastObserved::<Test>::hashed_key_for(A)[..32],
                "the v0 LastObserved alias must address the pallet's LastObserved prefix",
            );
            assert_eq!(
                LastObservedStakeV0::<Test>::hashed_key()[..],
                LastObservedStake::<Test>::hashed_key_for(S1)[..32],
                "the v0 LastObservedStake alias must address the pallet's LastObservedStake prefix",
            );
            assert_eq!(
                LastObservedRolesV0::<Test>::hashed_key()[..],
                LastObservedRoles::<Test>::hashed_key_for(ALICE)[..32],
                "the v0 LastObservedRoles alias must address the pallet's LastObservedRoles prefix",
            );
        });
    }

    #[test]
    fn v0_to_v1_repages_the_bases_and_is_idempotent() {
        new_test_ext().execute_with(|| {
            // Pre-v1 state: three whole-set blobs, recording WHO was credited but never with what.
            LastObservedV0::<Test>::put(vec![(A, ALICE), (B, BOB)]);
            LastObservedStakeV0::<Test>::put(vec![(S1, ALICE)]);
            LastObservedRolesV0::<Test>::put(vec![ALICE]);
            assert_eq!(
                CardanoObserver::on_chain_storage_version(),
                StorageVersion::new(0),
                "the pallet declared no version before this migration",
            );

            let _w = MigrateV0ToV1::<Test>::on_runtime_upgrade();

            // Every vault/stake row became a map row, seeded at weight 0 — the old shape carried no value
            // to migrate, so the first observation re-derives it.
            assert_eq!(LastObserved::<Test>::get(A), Some((ALICE, 0)));
            assert_eq!(LastObserved::<Test>::get(B), Some((BOB, 0)));
            assert_eq!(LastObservedStake::<Test>::get(S1), Some((ALICE, 0)));
            // The role accounts are dropped rather than carried as empty rows (an empty row would make the
            // diff emit a redundant clear every block, for ever).
            assert!(LastObservedRoles::<Test>::iter().next().is_none());
            assert_eq!(PendingChanges::<Test>::get(), 0);
            assert_eq!(
                CardanoObserver::on_chain_storage_version(),
                StorageVersion::new(1),
            );

            // The retired blobs are gone, and a re-run is a no-op (the version guard).
            assert!(LastObservedV0::<Test>::get().is_empty());
            let _w = MigrateV0ToV1::<Test>::on_runtime_upgrade();
            assert_eq!(LastObserved::<Test>::iter().count(), 2);
        });
    }

    #[test]
    fn the_first_observation_after_the_migration_re_derives_every_value() {
        new_test_ext().execute_with(|| {
            // The migration's correctness argument, exercised end to end: the seeded zeroes are not a lie
            // that sticks, they are a basis the very next diff corrects. A row that has since unlocked is
            // cleared; a row still locked is re-applied at its true weight.
            enforce();
            bind(A, ALICE);
            bind(B, BOB);
            LastObservedV0::<Test>::put(vec![(A, ALICE), (B, BOB)]);
            let _w = MigrateV0ToV1::<Test>::on_runtime_upgrade();

            // B has unlocked in the meantime; A is still locked.
            let call = derive(&snap(MAX_REFERENCE - 5, &[(A, 200_000_000)]));
            match &call {
                crate::Call::observe { changes, .. } => assert_eq!(
                    changes.to_vec(),
                    vec![(A, Some(200_000_000)), (B, None)],
                    "A is re-applied at its true weight and B is taken back",
                ),
                _ => panic!("expected observe call"),
            }
            assert_ok!(dispatch(call));
            assert_eq!(weight_of(ALICE), 200_000_000);
            assert_eq!(weight_of(BOB), 0);
        });
    }
}
