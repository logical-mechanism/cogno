//! Unit tests for `pallet-microblog` (posting + the talk-capacity meter).
//!
//! Note: the tests call the dispatchables directly, which BYPASSES the
//! `CheckCapacity` transaction extension (extensions only run in the full tx pipeline) — so
//! they remain valid unchanged. The capacity *gate* (ExhaustsResources at the pool) and the
//! *feeless* fee waiver are exercised end-to-end by the node acceptance harness; here we unit
//! test the pure bucket math + `force_set_capacity` + the anti-farm invariants.

use crate::{
    mock::*, AccountVoteTally, AccountVotes, ByAuthor, ByAuthorCount, Capacity, Error, Event,
    FollowerCount, Following, FollowingCount, NextPostId, NextTopLevelSeq, PollKind, PollTally,
    PollVotes, Polls, Posts, RepliesByParent, ReplyCount, TopLevelByAuthor, TopLevelByAuthorCount,
    TopLevelPosts, VoteDir, VoteTally, Votes, WeightInfo,
};
use frame_support::{assert_noop, assert_ok};
use sp_runtime::DispatchError;

/// The LIVE weighted vote tally for a post `(up_weight, down_weight)`, read through the node read path.
/// Spec 205 no longer STORES a vote's weight — it derives the weighted score from each voter's CURRENT
/// `VotingPower` (the mock's `StakerSet` = the accounts with a `VotingPower` row). `VoteTally::get(id)`
/// still carries the exact COUNTS. `thread(id).focal` enriches any existing post (top-level or reply).
fn post_weight(id: u64) -> (u128, u128) {
    let p = Microblog::thread(id, None).focal.expect("post exists");
    (p.up_weight, p.down_weight)
}

/// The LIVE weighted reputation [`crate::Tally`] for an account — exact counts + current-stake weights,
/// via the same staker-set join the runtime's `profile`/`person_summary` reads use.
fn account_weight(target: u64) -> crate::Tally {
    let stakers = Microblog::staker_weights();
    Microblog::account_tally(&target, &stakers)
}

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
        assert_eq!(ByAuthor::<Test>::get(1, 0), Some(0));
        assert_eq!(ByAuthorCount::<Test>::get(1), 1);
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
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(2),
            b"reply".to_vec(),
            Some(0)
        ));
        assert_eq!(Posts::<Test>::get(1).unwrap().parent, Some(0));
    });
}

#[test]
fn reply_bumps_reply_count_and_records_reverse_index() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // Root post 0, then two direct replies (ids 1, 2) and one reply-to-a-reply (id 3 under 1).
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(2),
            b"r1".to_vec(),
            Some(0)
        ));
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(3),
            b"r2".to_vec(),
            Some(0)
        ));
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(4),
            b"r1.1".to_vec(),
            Some(1)
        ));

        // Per-parent counts: 0 has two direct replies, 1 has one, 2/3 have none.
        assert_eq!(ReplyCount::<Test>::get(0), 2);
        assert_eq!(ReplyCount::<Test>::get(1), 1);
        assert_eq!(ReplyCount::<Test>::get(2), 0);
        assert_eq!(ReplyCount::<Test>::get(3), 0);

        // Reverse index: getEntries(parent) yields exactly that parent's direct children.
        let mut children_of_0: Vec<u64> = RepliesByParent::<Test>::iter_key_prefix(0).collect();
        children_of_0.sort();
        assert_eq!(children_of_0, vec![1, 2]);
        let children_of_1: Vec<u64> = RepliesByParent::<Test>::iter_key_prefix(1).collect();
        assert_eq!(children_of_1, vec![3]);
        assert!(RepliesByParent::<Test>::iter_key_prefix(2).next().is_none());
        assert!(RepliesByParent::<Test>::contains_key(0, 1));
        assert!(RepliesByParent::<Test>::contains_key(0, 2));
    });
}

#[test]
fn top_level_and_quote_posts_do_not_touch_reply_aggregates() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // A plain top-level post (parent None).
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        // A quote of post 0 — `quote = Some`, `parent = None`, so it is NOT a reply of 0.
        assert_ok!(Microblog::quote_post(
            RuntimeOrigin::signed(2),
            b"q".to_vec(),
            0
        ));
        // A poll — also a top-level post (parent None).
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(3),
            b"poll?".to_vec(),
            vec![b"a".to_vec(), b"b".to_vec()],
            Some(50_000),
            PollKind::Stake,
            None
        ));

        // None of these are replies, so the reply aggregates stay empty.
        assert_eq!(ReplyCount::<Test>::get(0), 0);
        assert_eq!(RepliesByParent::<Test>::iter().count(), 0);
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

/// The ACCEPTING side of the same boundary: `BoundedVec` admits `len == bound`, so a body of exactly
/// `MaxLength` is a legal post. The frontend's byte counter gates on this (it must stay live at 512/512
/// — a `>=` there greyed the Post button on the last byte the composer let you type), so pin it.
#[test]
fn exactly_max_length_is_accepted() {
    new_test_ext().execute_with(|| {
        let full = vec![0u8; 512]; // MaxLength = 512, inclusive
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            full.clone(),
            None
        ));
        assert_eq!(NextPostId::<Test>::get(), 1);
        assert_eq!(
            Posts::<Test>::get(0).expect("stored").text.into_inner(),
            full
        );
    });
}

// ── the on-wire variant indices (the codec contract) ────────────────────────────────────────────

#[test]
fn event_and_error_variant_indices_are_pinned_on_the_wire() {
    // A variant's index IS its wire format: the first byte of an encoded Event, and the first byte of a
    // `DispatchError::Module`'s error payload. `Reposted`@6 and `AlreadyReposted`@5 were retired in spec
    // 204 and their indices left VACANT — every surviving variant keeps the index it shipped with, so an
    // already-deployed client cannot silently mis-decode (a shifted Error would report `SelfFollow` for
    // an `AlreadyFollowing` failure). This test fails if anyone renumbers or inserts in the middle.
    use codec::Encode;

    let ev = |e: Event<Test>| e.encode()[0];
    assert_eq!(ev(Event::PostCreated { id: 0, author: 1 }), 0);
    assert_eq!(
        ev(Event::CapacityForced {
            who: 1,
            cap_last: 0
        }),
        1
    );
    // spec 205 dropped the `weight` field from Voted/AccountVoted/PollVoted (weight is now derived live),
    // but the variant INDICES are unchanged — that is the on-wire contract this test guards.
    assert_eq!(
        ev(Event::Voted {
            id: 0,
            who: 1,
            dir: VoteDir::Up,
        }),
        2
    );
    assert_eq!(ev(Event::VoteCleared { id: 0, who: 1 }), 3);
    assert_eq!(
        ev(Event::AccountVoted {
            target: 2,
            who: 1,
            dir: VoteDir::Up,
        }),
        4
    );
    assert_eq!(ev(Event::AccountVoteCleared { target: 2, who: 1 }), 5);
    // 6 = Reposted: VACANT.
    assert_eq!(
        ev(Event::Followed {
            follower: 1,
            followee: 2
        }),
        7
    );
    assert_eq!(
        ev(Event::Unfollowed {
            follower: 1,
            followee: 2
        }),
        8
    );
    assert_eq!(ev(Event::PollCreated { id: 0, author: 1 }), 9);
    assert_eq!(
        ev(Event::PollVoted {
            id: 0,
            who: 1,
            option: 0,
        }),
        10
    );
    // spec 205: PollClosed appended at the next free index.
    assert_eq!(ev(Event::PollClosed { host_id: 0 }), 11);

    let er = |e: Error<Test>| e.encode()[0];
    assert_eq!(er(Error::TooLong), 0);
    assert_eq!(er(Error::NotFound), 1);
    // 2 = TooManyPosts: VACANT (retired in spec 212 with `MaxPostsPerAuthor`).
    assert_eq!(er(Error::NotAllowed), 3);
    assert_eq!(er(Error::NotVoted), 4);
    // 5 = AlreadyReposted: VACANT.
    assert_eq!(er(Error::SelfFollow), 6);
    assert_eq!(er(Error::AlreadyFollowing), 7);
    assert_eq!(er(Error::NotFollowing), 8);
    assert_eq!(er(Error::NotEnoughOptions), 9);
    assert_eq!(er(Error::TooManyOptions), 10);
    assert_eq!(er(Error::OptionTooLong), 11);
    assert_eq!(er(Error::PollNotFound), 12);
    assert_eq!(er(Error::InvalidOption), 13);
    assert_eq!(er(Error::SelfAccountVote), 14);
    assert_eq!(er(Error::TargetNotAllowed), 15);
    // spec 205: PollClosed / PollNotClosable appended at the next free indices.
    assert_eq!(er(Error::PollClosed), 16);
    assert_eq!(er(Error::PollNotClosable), 17);
}

// ── social engagement: quote / vote / follow ────────────────────────────────────────────────────

#[test]
fn quote_post_sets_quote_and_emits_postcreated() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        // Quote post 0 with new text. The quote is a post in its own right (parent None, quote Some).
        assert_ok!(Microblog::quote_post(
            RuntimeOrigin::signed(2),
            b"hot take".to_vec(),
            0
        ));
        let q = Posts::<Test>::get(1).expect("quote exists");
        assert_eq!(q.author, 2);
        assert_eq!(q.parent, None);
        assert_eq!(q.quote, Some(0));
        assert_eq!(NextPostId::<Test>::get(), 2);
        System::assert_last_event(Event::PostCreated { id: 1, author: 2 }.into());
    });
}

#[test]
fn quote_post_nonexistent_target_is_rejected() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // Unlike a reply's parent (unvalidated), a quote target must exist.
        assert_noop!(
            Microblog::quote_post(RuntimeOrigin::signed(1), b"x".to_vec(), 99),
            Error::<Test>::NotFound
        );
        assert_eq!(NextPostId::<Test>::get(), 0);
    });
}

#[test]
fn quote_post_too_long_is_rejected() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        let big = vec![0u8; 513]; // MaxLength = 512
        assert_noop!(
            Microblog::quote_post(RuntimeOrigin::signed(1), big, 0),
            Error::<Test>::TooLong
        );
    });
}

#[test]
fn vote_records_count_and_live_weight() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        TalkStake::apply_voting_power(&2, 100);
        assert_ok!(Microblog::vote(RuntimeOrigin::signed(2), 0, VoteDir::Up));
        // Counts are stored; the weight is derived LIVE from the voter's current VotingPower (100).
        let t = VoteTally::<Test>::get(0);
        assert_eq!(t.up_count, 1);
        assert_eq!(t.down_count, 0);
        assert_eq!(post_weight(0), (100, 0));
        // The stored record keeps only the direction (no weight snapshot).
        assert_eq!(Votes::<Test>::get(0, 2).expect("record").dir, VoteDir::Up);
        System::assert_last_event(
            Event::Voted {
                id: 0,
                who: 2,
                dir: VoteDir::Up,
            }
            .into(),
        );
    });
}

#[test]
fn vote_weight_reprices_live_when_stake_moves() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        TalkStake::apply_voting_power(&2, 100);
        assert_ok!(Microblog::vote(RuntimeOrigin::signed(2), 0, VoteDir::Up));
        assert_eq!(post_weight(0), (100, 0));
        // Stake grows — the SAME already-cast vote re-prices on the next read, no re-vote needed.
        TalkStake::apply_voting_power(&2, 500);
        assert_eq!(post_weight(0), (500, 0));
        // A full unstake drops the vote's weight to 0 while the count still stands.
        TalkStake::apply_voting_power(&2, 0);
        assert_eq!(post_weight(0), (0, 0));
        assert_eq!(VoteTally::<Test>::get(0).up_count, 1);
    });
}

#[test]
fn vote_weight_for_a_fresh_wallet_catches_up_when_stake_lands() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        // A wallet that reads 0 before its epoch snapshot lands still records a (0-weight) vote …
        assert_ok!(Microblog::vote(RuntimeOrigin::signed(2), 0, VoteDir::Up));
        assert_eq!(post_weight(0), (0, 0));
        assert_eq!(VoteTally::<Test>::get(0).up_count, 1);
        // … and it catches up the moment the observer credits its stake — no re-vote.
        TalkStake::apply_voting_power(&2, 250);
        assert_eq!(post_weight(0), (250, 0));
    });
}

#[test]
fn vote_on_nonexistent_post_is_rejected() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_noop!(
            Microblog::vote(RuntimeOrigin::signed(1), 99, VoteDir::Up),
            Error::<Test>::NotFound
        );
    });
}

#[test]
fn revote_flip_moves_count_and_reprices_live() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        // Vote Up at weight 100 …
        TalkStake::apply_voting_power(&2, 100);
        assert_ok!(Microblog::vote(RuntimeOrigin::signed(2), 0, VoteDir::Up));
        // … then stake changes to 300 and the voter flips to Down. The count moves Up→Down (O(1)); the
        // weight is derived live, so Down carries the voter's CURRENT 300 and Up drops to 0.
        TalkStake::apply_voting_power(&2, 300);
        assert_ok!(Microblog::vote(RuntimeOrigin::signed(2), 0, VoteDir::Down));
        let t = VoteTally::<Test>::get(0);
        assert_eq!(t.up_count, 0);
        assert_eq!(t.down_count, 1);
        assert_eq!(post_weight(0), (0, 300));
    });
}

#[test]
fn revote_same_direction_does_not_double_count() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        TalkStake::apply_voting_power(&2, 100);
        assert_ok!(Microblog::vote(RuntimeOrigin::signed(2), 0, VoteDir::Up));
        TalkStake::apply_voting_power(&2, 300);
        assert_ok!(Microblog::vote(RuntimeOrigin::signed(2), 0, VoteDir::Up)); // same dir, new stake
        let t = VoteTally::<Test>::get(0);
        assert_eq!(t.up_count, 1, "count not double-incremented");
        assert_eq!(post_weight(0), (300, 0), "weight reflects current stake");
    });
}

#[test]
fn clear_vote_drops_count_and_weight() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        TalkStake::apply_voting_power(&2, 100);
        assert_ok!(Microblog::vote(RuntimeOrigin::signed(2), 0, VoteDir::Up));
        assert_eq!(post_weight(0), (100, 0));
        assert_ok!(Microblog::clear_vote(RuntimeOrigin::signed(2), 0));
        let t = VoteTally::<Test>::get(0);
        assert_eq!(t.up_count, 0);
        assert_eq!(post_weight(0), (0, 0));
        assert!(Votes::<Test>::get(0, 2).is_none());
        System::assert_last_event(Event::VoteCleared { id: 0, who: 2 }.into());
    });
}

#[test]
fn clear_vote_without_a_vote_is_rejected() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        assert_noop!(
            Microblog::clear_vote(RuntimeOrigin::signed(2), 0),
            Error::<Test>::NotVoted
        );
    });
}

/// The count-fold + live-weight invariant (spec 205). COUNTS still fold cleanly from the `Voted` /
/// `VoteCleared` events (reverse-then-apply on the direction) and must reproduce `VoteTally` exactly. The
/// WEIGHTED score no longer folds from events — it is derived live — so we cross-check it against a hand
/// sum of each currently-voting account's CURRENT `VotingPower`. We drive a sweep of votes/flips/clears
/// with concurrent stake changes and compare both.
#[test]
fn tally_count_fold_and_live_weight_property() {
    use std::collections::BTreeMap;
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        // (voter, weight, action) — action: Some(dir) = vote, None = clear.
        let steps: &[(u64, u128, Option<VoteDir>)] = &[
            (2, 100, Some(VoteDir::Up)),
            (3, 50, Some(VoteDir::Down)),
            (2, 250, Some(VoteDir::Up)), // same-dir reweight
            (4, 70, Some(VoteDir::Up)),
            (3, 50, Some(VoteDir::Up)),    // flip Down -> Up
            (2, 250, None),                // clear
            (4, 999, Some(VoteDir::Down)), // flip Up -> Down at new stake
        ];
        // Independent COUNT fold: last-seen direction per voter, reverse-then-apply.
        let mut seen: BTreeMap<u64, VoteDir> = BTreeMap::new();
        let (mut up_c, mut dn_c) = (0u32, 0u32);
        for &(voter, weight, action) in steps {
            if let Some(dir) = seen.remove(&voter) {
                match dir {
                    VoteDir::Up => up_c = up_c.saturating_sub(1),
                    VoteDir::Down => dn_c = dn_c.saturating_sub(1),
                }
            }
            match action {
                Some(dir) => {
                    TalkStake::apply_voting_power(&voter, weight);
                    assert_ok!(Microblog::vote(RuntimeOrigin::signed(voter), 0, dir));
                    match dir {
                        VoteDir::Up => up_c = up_c.saturating_add(1),
                        VoteDir::Down => dn_c = dn_c.saturating_add(1),
                    }
                    seen.insert(voter, dir);
                }
                None => {
                    assert_ok!(Microblog::clear_vote(RuntimeOrigin::signed(voter), 0));
                }
            }
        }
        // Counts fold exactly.
        let t = VoteTally::<Test>::get(0);
        assert_eq!((t.up_count, t.down_count), (up_c, dn_c));
        // Live weight = sum of each still-voting account's CURRENT VotingPower on its current side.
        let (mut up_w, mut dn_w) = (0u128, 0u128);
        for (&voter, &dir) in seen.iter() {
            let w = pallet_talk_stake::VotingPower::<Test>::get(voter);
            match dir {
                VoteDir::Up => up_w += w,
                VoteDir::Down => dn_w += w,
            }
        }
        assert_eq!(post_weight(0), (up_w, dn_w));
    });
}

// ── account reputation votes (stake-weighted up/down ON accounts) ───────────────────────────────

#[test]
fn account_vote_records_count_and_live_weight() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        TalkStake::apply_voting_power(&2, 100);
        assert_ok!(Microblog::vote_account(
            RuntimeOrigin::signed(2),
            3,
            VoteDir::Up
        ));
        // Counts stored; weight derived live from the voter's current VotingPower (100).
        let stored = AccountVoteTally::<Test>::get(3);
        assert_eq!(stored.up_count, 1);
        assert_eq!(stored.down_count, 0);
        let t = account_weight(3);
        assert_eq!(
            (t.up_weight, t.down_weight, t.up_count, t.down_count),
            (100, 0, 1, 0)
        );
        assert_eq!(
            AccountVotes::<Test>::get(3, 2).expect("record").dir,
            VoteDir::Up
        );
        System::assert_last_event(
            Event::AccountVoted {
                target: 3,
                who: 2,
                dir: VoteDir::Up,
            }
            .into(),
        );
    });
}

#[test]
fn account_reputation_reprices_live_when_stake_moves() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        TalkStake::apply_voting_power(&2, 100);
        assert_ok!(Microblog::vote_account(
            RuntimeOrigin::signed(2),
            3,
            VoteDir::Up
        ));
        assert_eq!(account_weight(3).up_weight, 100);
        // The already-cast reputation vote re-prices as the voter's stake moves — no re-vote.
        TalkStake::apply_voting_power(&2, 400);
        assert_eq!(account_weight(3).up_weight, 400);
        TalkStake::apply_voting_power(&2, 0);
        let t = account_weight(3);
        assert_eq!((t.up_weight, t.up_count), (0, 1));
    });
}

#[test]
fn cannot_account_vote_self() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_noop!(
            Microblog::vote_account(RuntimeOrigin::signed(2), 2, VoteDir::Up),
            Error::<Test>::SelfAccountVote
        );
    });
}

#[test]
fn account_vote_on_unbound_target_is_rejected() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        deny_identity(3); // the target has no bound identity
        assert_noop!(
            Microblog::vote_account(RuntimeOrigin::signed(2), 3, VoteDir::Up),
            Error::<Test>::TargetNotAllowed
        );
    });
}

#[test]
fn account_vote_requires_voter_identity() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        deny_identity(2); // the voter is not identity-bound
        assert_noop!(
            Microblog::vote_account(RuntimeOrigin::signed(2), 3, VoteDir::Up),
            Error::<Test>::NotAllowed
        );
    });
}

#[test]
fn account_revote_flip_moves_count_and_reprices_live() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        TalkStake::apply_voting_power(&2, 100);
        assert_ok!(Microblog::vote_account(
            RuntimeOrigin::signed(2),
            3,
            VoteDir::Up
        ));
        // Stake changes to 300 and the voter flips to Down: the count moves Up→Down; the live weight
        // reflects the CURRENT 300 on the Down side and 0 on the Up side.
        TalkStake::apply_voting_power(&2, 300);
        assert_ok!(Microblog::vote_account(
            RuntimeOrigin::signed(2),
            3,
            VoteDir::Down
        ));
        let stored = AccountVoteTally::<Test>::get(3);
        assert_eq!((stored.up_count, stored.down_count), (0, 1));
        let t = account_weight(3);
        assert_eq!((t.up_weight, t.down_weight), (0, 300));
    });
}

#[test]
fn account_revote_same_direction_does_not_double_count() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        TalkStake::apply_voting_power(&2, 100);
        assert_ok!(Microblog::vote_account(
            RuntimeOrigin::signed(2),
            3,
            VoteDir::Up
        ));
        TalkStake::apply_voting_power(&2, 300);
        assert_ok!(Microblog::vote_account(
            RuntimeOrigin::signed(2),
            3,
            VoteDir::Up
        )); // same dir, new stake
        assert_eq!(
            AccountVoteTally::<Test>::get(3).up_count,
            1,
            "count not double-incremented"
        );
        assert_eq!(
            account_weight(3).up_weight,
            300,
            "weight reflects current stake"
        );
    });
}

#[test]
fn clear_account_vote_drops_count_and_weight() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        TalkStake::apply_voting_power(&2, 100);
        assert_ok!(Microblog::vote_account(
            RuntimeOrigin::signed(2),
            3,
            VoteDir::Up
        ));
        assert_eq!(account_weight(3).up_weight, 100);
        assert_ok!(Microblog::clear_account_vote(RuntimeOrigin::signed(2), 3));
        let t = account_weight(3);
        assert_eq!((t.up_weight, t.up_count), (0, 0));
        assert!(AccountVotes::<Test>::get(3, 2).is_none());
        System::assert_last_event(Event::AccountVoteCleared { target: 3, who: 2 }.into());
    });
}

#[test]
fn clear_account_vote_without_a_vote_is_rejected() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_noop!(
            Microblog::clear_account_vote(RuntimeOrigin::signed(2), 3),
            Error::<Test>::NotVoted
        );
    });
}

/// The account-vote analog of [`tally_count_fold_and_live_weight_property`]: COUNTS fold from the
/// `AccountVoted`/`AccountVoteCleared` events, and the live weighted reputation matches a hand sum of each
/// currently-voting account's CURRENT `VotingPower`.
#[test]
fn account_tally_count_fold_and_live_weight_property() {
    use std::collections::BTreeMap;
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        let target = 9u64; // the account under reputation (bound by default in the mock)
                           // (voter, weight, action) — action: Some(dir) = vote, None = clear.
        let steps: &[(u64, u128, Option<VoteDir>)] = &[
            (2, 100, Some(VoteDir::Up)),
            (3, 50, Some(VoteDir::Down)),
            (2, 250, Some(VoteDir::Up)), // same-dir reweight
            (4, 70, Some(VoteDir::Up)),
            (3, 50, Some(VoteDir::Up)),    // flip Down -> Up
            (2, 250, None),                // clear
            (4, 999, Some(VoteDir::Down)), // flip Up -> Down at new stake
        ];
        let mut seen: BTreeMap<u64, VoteDir> = BTreeMap::new();
        let (mut up_c, mut dn_c) = (0u32, 0u32);
        for &(voter, weight, action) in steps {
            if let Some(dir) = seen.remove(&voter) {
                match dir {
                    VoteDir::Up => up_c = up_c.saturating_sub(1),
                    VoteDir::Down => dn_c = dn_c.saturating_sub(1),
                }
            }
            match action {
                Some(dir) => {
                    TalkStake::apply_voting_power(&voter, weight);
                    assert_ok!(Microblog::vote_account(
                        RuntimeOrigin::signed(voter),
                        target,
                        dir
                    ));
                    match dir {
                        VoteDir::Up => up_c = up_c.saturating_add(1),
                        VoteDir::Down => dn_c = dn_c.saturating_add(1),
                    }
                    seen.insert(voter, dir);
                }
                None => {
                    assert_ok!(Microblog::clear_account_vote(
                        RuntimeOrigin::signed(voter),
                        target
                    ));
                }
            }
        }
        let t = account_weight(target);
        let (mut up_w, mut dn_w) = (0u128, 0u128);
        for (&voter, &dir) in seen.iter() {
            let w = pallet_talk_stake::VotingPower::<Test>::get(voter);
            match dir {
                VoteDir::Up => up_w += w,
                VoteDir::Down => dn_w += w,
            }
        }
        assert_eq!(
            (t.up_weight, t.down_weight, t.up_count, t.down_count),
            (up_w, dn_w, up_c, dn_c)
        );
    });
}

#[test]
fn follow_sets_edge_and_counts() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::follow(RuntimeOrigin::signed(1), 2));
        assert!(Following::<Test>::contains_key(1, 2));
        assert_eq!(FollowingCount::<Test>::get(1), 1);
        assert_eq!(FollowerCount::<Test>::get(2), 1);
        System::assert_last_event(
            Event::Followed {
                follower: 1,
                followee: 2,
            }
            .into(),
        );
    });
}

#[test]
fn follow_self_is_rejected() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_noop!(
            Microblog::follow(RuntimeOrigin::signed(1), 1),
            Error::<Test>::SelfFollow
        );
    });
}

#[test]
fn follow_twice_is_rejected() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::follow(RuntimeOrigin::signed(1), 2));
        assert_noop!(
            Microblog::follow(RuntimeOrigin::signed(1), 2),
            Error::<Test>::AlreadyFollowing
        );
        assert_eq!(FollowingCount::<Test>::get(1), 1); // not double-counted
    });
}

#[test]
fn follow_dangling_followee_is_allowed() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // The followee (account 42) has never been seen on-chain — following still succeeds (mirrors
        // the dangling-parent design; the followee may bind an identity later).
        assert_ok!(Microblog::follow(RuntimeOrigin::signed(1), 42));
        assert_eq!(FollowerCount::<Test>::get(42), 1);
    });
}

#[test]
fn unfollow_clears_edge_and_decrements() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::follow(RuntimeOrigin::signed(1), 2));
        assert_ok!(Microblog::unfollow(RuntimeOrigin::signed(1), 2));
        assert!(!Following::<Test>::contains_key(1, 2));
        assert_eq!(FollowingCount::<Test>::get(1), 0);
        assert_eq!(FollowerCount::<Test>::get(2), 0);
        System::assert_last_event(
            Event::Unfollowed {
                follower: 1,
                followee: 2,
            }
            .into(),
        );
    });
}

#[test]
fn unfollow_without_following_is_rejected() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_noop!(
            Microblog::unfollow(RuntimeOrigin::signed(1), 2),
            Error::<Test>::NotFollowing
        );
    });
}

#[test]
fn engagement_calls_require_identity_gate() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"root".to_vec(),
            None
        ));
        crate::mock::deny_identity(2);
        assert_noop!(
            Microblog::quote_post(RuntimeOrigin::signed(2), b"x".to_vec(), 0),
            Error::<Test>::NotAllowed
        );
        assert_noop!(
            Microblog::vote(RuntimeOrigin::signed(2), 0, VoteDir::Up),
            Error::<Test>::NotAllowed
        );
        assert_noop!(
            Microblog::follow(RuntimeOrigin::signed(2), 1),
            Error::<Test>::NotAllowed
        );
    });
}

// ── stake-weighted polls ────────────────────────────────────────────────────────────────────────

fn opts(n: usize) -> Vec<Vec<u8>> {
    (0..n).map(alloc_opt).collect()
}
fn alloc_opt(i: usize) -> Vec<u8> {
    vec![b'a' + i as u8]
}

#[test]
fn create_poll_makes_a_post_and_stores_options() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"best chain?".to_vec(),
            opts(3),
            Some(50_000),
            PollKind::Stake,
            None
        ));
        // The poll's question is an ordinary post (so it threads/quotes + shows in the feed).
        let p = Posts::<Test>::get(0).expect("host post exists");
        assert_eq!(p.text.to_vec(), b"best chain?".to_vec());
        assert_eq!(p.parent, None);
        assert_eq!(p.quote, None);
        // And the options live in the Polls side-map with the required deadline (spec 211).
        let poll = Polls::<Test>::get(0).expect("poll exists");
        assert_eq!(poll.options.len(), 3);
        assert_eq!(poll.close_at, Some(50_000));
        assert_eq!(NextPostId::<Test>::get(), 1);
        System::assert_has_event(Event::PostCreated { id: 0, author: 1 }.into());
        System::assert_last_event(Event::PollCreated { id: 0, author: 1 }.into());
    });
}

#[test]
fn create_poll_needs_at_least_two_options() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_noop!(
            Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"q".to_vec(),
                opts(1),
                Some(50_000),
                PollKind::Stake,
                None
            ),
            Error::<Test>::NotEnoughOptions
        );
        assert_eq!(NextPostId::<Test>::get(), 0);
    });
}

#[test]
fn create_poll_rejects_too_many_options() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // MaxPollOptions = 4 in the mock.
        assert_noop!(
            Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"q".to_vec(),
                opts(5),
                Some(50_000),
                PollKind::Stake,
                None
            ),
            Error::<Test>::TooManyOptions
        );
    });
}

#[test]
fn create_poll_rejects_overlong_option() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        let long = vec![0u8; 33]; // MaxPollOptionLen = 32
        assert_noop!(
            Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"q".to_vec(),
                vec![b"ok".to_vec(), long],
                Some(50_000),
                PollKind::Stake,
                None
            ),
            Error::<Test>::OptionTooLong
        );
    });
}

/// The live per-option weight for a poll option, read through `poll()` (the node read path).
fn poll_opt_weight(host: u64, option: usize) -> u128 {
    Microblog::poll(host).expect("poll exists").options[option].weight
}

#[test]
fn cast_poll_vote_counts_and_reprices_live_on_recast() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"q".to_vec(),
            opts(3),
            Some(50_000),
            PollKind::Stake,
            None
        ));
        // Account 2 votes option 0 at weight 100. Count is stored; weight is derived live.
        TalkStake::apply_voting_power(&2, 100);
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(2), 0, 0));
        assert_eq!(PollTally::<Test>::get(0, 0).count, 1);
        assert_eq!(poll_opt_weight(0, 0), 100);
        System::assert_last_event(
            Event::PollVoted {
                id: 0,
                who: 2,
                option: 0,
            }
            .into(),
        );

        // Stake grows to 300, account 2 re-casts to option 1: the count moves 0→1; the live weight puts
        // the voter's CURRENT 300 on option 1 and 0 on option 0.
        TalkStake::apply_voting_power(&2, 300);
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(2), 0, 1));
        assert_eq!(PollTally::<Test>::get(0, 0).count, 0);
        assert_eq!(poll_opt_weight(0, 0), 0);
        assert_eq!(PollTally::<Test>::get(0, 1).count, 1);
        assert_eq!(poll_opt_weight(0, 1), 300);
        assert_eq!(PollVotes::<Test>::get(0, 2).expect("record").option, 1);
    });
}

#[test]
fn cast_poll_vote_rejects_non_poll_and_bad_option() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // A plain post is not a poll.
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"not a poll".to_vec(),
            None
        ));
        assert_noop!(
            Microblog::cast_poll_vote(RuntimeOrigin::signed(2), 0, 0),
            Error::<Test>::PollNotFound
        );
        // An out-of-range option on a real poll.
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"q".to_vec(),
            opts(2),
            Some(50_000),
            PollKind::Stake,
            None
        ));
        assert_noop!(
            Microblog::cast_poll_vote(RuntimeOrigin::signed(2), 1, 2), // poll id 1 has options 0,1
            Error::<Test>::InvalidOption
        );
    });
}

#[test]
fn poll_close_rejects_votes_and_freezes_result() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // A poll that closes at block 11.
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"q".to_vec(),
            opts(2),
            Some(11),
            PollKind::Stake,
            None
        ));
        TalkStake::apply_voting_power(&2, 100);
        TalkStake::apply_voting_power(&3, 200);
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(2), 0, 0));
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(3), 0, 1));
        // Before the deadline the result is LIVE (re-prices with stake) and cannot be finalized yet.
        assert_eq!(poll_opt_weight(0, 0), 100);
        // Compare the error, not the whole `Err`: a rejected close now carries a weight refund.
        assert_eq!(
            Microblog::close_poll(RuntimeOrigin::signed(2), 0)
                .unwrap_err()
                .error,
            Error::<Test>::PollNotClosable.into()
        );

        // At/after the deadline: no more votes …
        System::set_block_number(11);
        assert_noop!(
            Microblog::cast_poll_vote(RuntimeOrigin::signed(2), 0, 1),
            Error::<Test>::PollClosed
        );
        // … the result reads live until finalized …
        assert_eq!(poll_opt_weight(0, 1), 200);
        // … then a permissionless close_poll FREEZES it.
        assert_ok!(Microblog::close_poll(RuntimeOrigin::signed(2), 0));
        assert!(crate::PollResults::<Test>::contains_key(0));
        System::assert_last_event(Event::PollClosed { host_id: 0 }.into());
        assert_eq!(poll_opt_weight(0, 0), 100);
        assert_eq!(poll_opt_weight(0, 1), 200);

        // A frozen poll no longer re-prices: moving stake after the close leaves the result unchanged,
        // and a second close_poll is an idempotent no-op.
        TalkStake::apply_voting_power(&3, 5_000);
        assert_eq!(
            poll_opt_weight(0, 1),
            200,
            "frozen result must not re-price"
        );
        assert_ok!(Microblog::close_poll(RuntimeOrigin::signed(2), 0)); // idempotent
    });
}

#[test]
fn close_poll_rejects_floating_and_missing_polls() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // A poll whose deadline has not been reached cannot be finalized yet.
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"q".to_vec(),
            opts(2),
            Some(50_000),
            PollKind::Stake,
            None
        ));
        // These paths now carry a weight REFUND in their `PostDispatchInfo` (see
        // `close_poll_refunds_every_rejected_path_to_the_base_weight`), so compare the error itself
        // rather than the whole `Err` — `assert_noop!` would also compare `actual_weight`.
        assert_eq!(
            Microblog::close_poll(RuntimeOrigin::signed(2), 0)
                .unwrap_err()
                .error,
            Error::<Test>::PollNotClosable.into()
        );
        // A non-poll post cannot be closed.
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"hi".to_vec(),
            None
        ));
        assert_eq!(
            Microblog::close_poll(RuntimeOrigin::signed(2), 1)
                .unwrap_err()
                .error,
            Error::<Test>::PollNotFound.into()
        );
        // A LEGACY floating poll (close_at None, storable only pre-spec-211 — create_poll now
        // rejects None) can never be finalized. Inserted directly, as pre-211 storage would hold it.
        let options: frame_support::BoundedVec<
            frame_support::BoundedVec<u8, <Test as crate::pallet::Config>::MaxPollOptionLen>,
            <Test as crate::pallet::Config>::MaxPollOptions,
        > = vec![
            b"a".to_vec().try_into().unwrap(),
            b"b".to_vec().try_into().unwrap(),
        ]
        .try_into()
        .unwrap();
        crate::Polls::<Test>::insert(
            99,
            crate::pallet::Poll::<Test> {
                options,
                close_at: None,
                kind: PollKind::Stake,
                action: None,
            },
        );
        assert_eq!(
            Microblog::close_poll(RuntimeOrigin::signed(2), 99)
                .unwrap_err()
                .error,
            Error::<Test>::PollNotClosable.into()
        );
    });
}

#[test]
fn create_poll_requires_a_deadline_inside_the_duration_window() {
    // spec 211: `close_at` is required and must land in [now + MinPollDuration, now + MaxPollDuration]
    // (mock: min 10, max 100_000). A `None` poll could never be frozen, so its weighted result would
    // re-price forever — and the shipped UI used to produce exactly that poll by default.
    new_test_ext().execute_with(|| {
        System::set_block_number(100);
        let create = |close_at| {
            Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"q".to_vec(),
                opts(2),
                close_at,
                PollKind::Stake,
                None,
            )
        };
        // No deadline at all.
        assert_noop!(create(None), Error::<Test>::PollCloseRequired);
        // Born closed / sooner than the minimum window (min is 10 blocks from now = 100).
        assert_noop!(create(Some(0)), Error::<Test>::PollDurationTooShort);
        assert_noop!(create(Some(100)), Error::<Test>::PollDurationTooShort);
        assert_noop!(create(Some(109)), Error::<Test>::PollDurationTooShort);
        // Further out than the maximum window (max is 100_000 blocks from now).
        assert_noop!(create(Some(100_101)), Error::<Test>::PollDurationTooLong);
        // Both inclusive boundaries are accepted.
        assert_ok!(create(Some(110)));
        assert_ok!(create(Some(100_100)));
    });
}

#[test]
fn close_poll_with_no_votes_freezes_an_all_zero_result() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // A poll that closes at block 11, on which NOBODY votes — this exercises the `total == 0`
        // short-circuit in `close_poll` (freeze without the staker-set join).
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"q".to_vec(),
            opts(3),
            Some(11),
            PollKind::Stake,
            None
        ));
        System::set_block_number(11);
        assert_ok!(Microblog::close_poll(RuntimeOrigin::signed(2), 0));
        System::assert_last_event(Event::PollClosed { host_id: 0 }.into());

        // The frozen result is present, all-zero, and index-aligned (one entry per option — NOT empty).
        let result = crate::PollResults::<Test>::get(0).expect("finalized");
        assert_eq!(result.option_weights.to_vec(), vec![0u128; 3]);
        assert_eq!(result.option_counts.to_vec(), vec![0u32; 3]);
        // And `poll()` reads the frozen snapshot back with zero voters and zero per-option weight.
        let view = Microblog::poll(0).expect("poll exists");
        assert_eq!(view.total_votes, 0);
        assert_eq!(view.options.len(), 3);
        for o in &view.options {
            assert_eq!((o.weight, o.count), (0, 0));
        }
    });
}

// ── governance polls (spec 207): the SPO + dRep chambers ─────────────────────────────────────────────

const POOL_P: [u8; 28] = [0xAA; 28];
const POOL_Q: [u8; 28] = [0xBB; 28];
const POOL_R: [u8; 28] = [0xCC; 28];
const POOL_S: [u8; 28] = [0xEE; 28];
const DREP_D: [u8; 28] = [0xDD; 28];

#[test]
fn governance_poll_reports_spo_and_drep_chambers_deduped_by_pool() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // Voters need VotingPower to carry the HOLDER lens; the chambers come from their observed roles.
        for who in [10u64, 11, 12, 13] {
            TalkStake::apply_voting_power(&who, 100);
        }
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"ratify?".to_vec(),
            vec![b"yes".to_vec(), b"no".to_vec()],
            Some(50_000),
            PollKind::Governance,
            None,
        ));
        let host = 0u64;
        // Pool P (15M ADA) is CO-OWNED by 10 and 11; pool Q (5M) by 12; dRep D (7M) is held by 13.
        set_chamber_roles(10, vec![(0, POOL_P, 15_000_000)]);
        set_chamber_roles(11, vec![(0, POOL_P, 15_000_000)]); // same pool as 10
        set_chamber_roles(12, vec![(0, POOL_Q, 5_000_000)]);
        set_chamber_roles(13, vec![(1, DREP_D, 7_000_000)]);
        // Votes: 10→yes, 11→yes (same pool + same option ⇒ P counts ONCE), 12→no, 13→yes.
        assert_ok!(Microblog::cast_poll_vote(
            RuntimeOrigin::signed(10),
            host,
            0
        ));
        assert_ok!(Microblog::cast_poll_vote(
            RuntimeOrigin::signed(11),
            host,
            0
        ));
        assert_ok!(Microblog::cast_poll_vote(
            RuntimeOrigin::signed(12),
            host,
            1
        ));
        assert_ok!(Microblog::cast_poll_vote(
            RuntimeOrigin::signed(13),
            host,
            0
        ));

        let view = Microblog::poll(host).expect("poll exists");
        assert_eq!(view.kind, 1, "governance poll");
        // HOLDER lens (own VotingPower, unchanged behaviour): yes = 10+11+13 = 300; no = 12 = 100.
        assert_eq!((view.options[0].weight, view.options[0].count), (300, 3));
        assert_eq!((view.options[1].weight, view.options[1].count), (100, 1));
        // SPO chamber: yes → pool P (15M) counted ONCE despite two owners; no → pool Q (5M).
        assert_eq!(
            (view.options[0].spo_weight, view.options[0].spo_count),
            (15_000_000, 1)
        );
        assert_eq!(
            (view.options[1].spo_weight, view.options[1].spo_count),
            (5_000_000, 1)
        );
        // dRep chamber: yes → D (7M); no → none.
        assert_eq!(
            (view.options[0].drep_weight, view.options[0].drep_count),
            (7_000_000, 1)
        );
        assert_eq!(
            (view.options[1].drep_weight, view.options[1].drep_count),
            (0, 0)
        );
    });
}

#[test]
fn governance_poll_sums_an_mspos_declaring_pools_deduped_by_pool() {
    // The load-bearing mSPO edge (case b, tally half): a SINGLE account holds SEVERAL SPO roles — one per
    // live pool whose cold key declared its ONE Calidus key (an operator running several pools). The SPO
    // chamber keys on POOL id, so the account's DISTINCT pools SUM into its chamber weight and the count
    // reflects the number of distinct pools — exactly the aggregate stake it would vote with on Cardano.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        for who in [20u64, 21] {
            TalkStake::apply_voting_power(&who, 100);
        }
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"ratify?".to_vec(),
            vec![b"yes".to_vec(), b"no".to_vec()],
            Some(50_000),
            PollKind::Governance,
            None,
        ));
        let host = 0u64;
        // Account 20 is an mSPO: pools P (15M), Q (5M), R (3M) all declare its one Calidus key. The trailing
        // duplicate of P (the SAME pool reached twice — e.g. once via the owner path, once via Calidus) must
        // be deduped by pool id, counted ONCE (case e at the tally level).
        set_chamber_roles(
            20,
            vec![
                (0, POOL_P, 15_000_000),
                (0, POOL_Q, 5_000_000),
                (0, POOL_R, 3_000_000),
                (0, POOL_P, 15_000_000), // shared pool via a second path → deduped, not double-counted
            ],
        );
        // Account 21 holds a single pool S (2M).
        set_chamber_roles(21, vec![(0, POOL_S, 2_000_000)]);
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(20), host, 0)); // yes
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(21), host, 1)); // no

        let view = Microblog::poll(host).expect("poll exists");
        // yes → the mSPO's DISTINCT pools SUM: 15M + 5M + 3M = 23M across 3 distinct pools (P counted once).
        assert_eq!(
            (view.options[0].spo_weight, view.options[0].spo_count),
            (23_000_000, 3),
            "an mSPO's declaring pools sum into its SPO-chamber weight; count = distinct pools (P deduped)"
        );
        // no → account 21's single pool.
        assert_eq!(
            (view.options[1].spo_weight, view.options[1].spo_count),
            (2_000_000, 1)
        );
    });
}

#[test]
fn co_owners_split_makes_the_pool_abstain_and_stake_polls_have_no_chambers() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        for who in [10u64, 11] {
            TalkStake::apply_voting_power(&who, 100);
        }
        // A GOVERNANCE poll where the two co-owners of pool P disagree.
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"gov?".to_vec(),
            vec![b"yes".to_vec(), b"no".to_vec()],
            Some(50_000),
            PollKind::Governance,
            None,
        ));
        set_chamber_roles(10, vec![(0, POOL_P, 15_000_000)]);
        set_chamber_roles(11, vec![(0, POOL_P, 15_000_000)]);
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(10), 0, 0)); // yes
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(11), 0, 1)); // no
        let gov = Microblog::poll(0).expect("poll");
        // Owners split ⇒ the pool casts no chamber vote at all (its weight is dropped, not assigned).
        assert_eq!(gov.options[0].spo_weight, 0);
        assert_eq!(gov.options[1].spo_weight, 0);
        assert_eq!(gov.options[0].spo_count, 0);
        assert_eq!(gov.options[1].spo_count, 0);

        // A STAKE poll (the default) never surfaces chambers, even when the voter holds a role.
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"plain?".to_vec(),
            vec![b"a".to_vec(), b"b".to_vec()],
            Some(50_000),
            PollKind::Stake,
            None,
        ));
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(10), 1, 0));
        let plain = Microblog::poll(1).expect("poll");
        assert_eq!(plain.kind, 0);
        assert_eq!(plain.options[0].weight, 100); // holder lens still works
        for o in &plain.options {
            assert_eq!(
                (o.spo_weight, o.spo_count, o.drep_weight, o.drep_count),
                (0, 0, 0, 0)
            );
        }
    });
}

#[test]
fn governance_poll_skips_zero_weight_roles() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        for who in [10u64, 11, 12, 13, 14] {
            TalkStake::apply_voting_power(&who, 100);
        }
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"gov?".to_vec(),
            vec![b"yes".to_vec(), b"no".to_vec()],
            Some(50_000),
            PollKind::Governance,
            None,
        ));
        let host = 0u64;
        // One genuinely-delegated role per chamber, plus three ZERO-weight roles that must contribute
        // NOTHING (the `if weight == 0 { continue }` skip): two pools with no delegators (weight 0, from
        // either SPO source) and an undelegated dRep.
        set_chamber_roles(10, vec![(0, POOL_P, 15_000_000)]); // real SPO → "yes"
        set_chamber_roles(11, vec![(0, POOL_R, 0)]); // undelegated pool (weight 0) → "yes"
        set_chamber_roles(12, vec![(0, POOL_Q, 0)]); // undelegated pool (weight 0) → "no"
        set_chamber_roles(13, vec![(1, DREP_D, 0)]); // undelegated dRep (weight 0) → "yes"
        set_chamber_roles(14, vec![(1, [0xEE; 28], 7_000_000)]); // real dRep → "no"
        for (who, opt) in [(10u64, 0u8), (11, 0), (12, 1), (13, 0), (14, 1)] {
            assert_ok!(Microblog::cast_poll_vote(
                RuntimeOrigin::signed(who),
                host,
                opt
            ));
        }

        let view = Microblog::poll(host).expect("poll exists");
        // SPO chamber: only the delegated pool P (15M) counts; both undelegated pools (weight 0) are
        // skipped — so "no" has NO pool despite voter 12 holding a (zero-weight) SPO role.
        assert_eq!(
            (view.options[0].spo_weight, view.options[0].spo_count),
            (15_000_000, 1)
        );
        assert_eq!(
            (view.options[1].spo_weight, view.options[1].spo_count),
            (0, 0)
        );
        // dRep chamber: only the delegated dRep (7M, on "no"); the undelegated dRep on "yes" is skipped.
        assert_eq!(
            (view.options[0].drep_weight, view.options[0].drep_count),
            (0, 0)
        );
        assert_eq!(
            (view.options[1].drep_weight, view.options[1].drep_count),
            (7_000_000, 1)
        );
        // The HOLDER lens still counts EVERY voter regardless of chamber weight: yes = 10+11+13 = 300,
        // no = 12+14 = 200.
        assert_eq!((view.options[0].weight, view.options[0].count), (300, 3));
        assert_eq!((view.options[1].weight, view.options[1].count), (200, 2));
    });
}

#[test]
fn finalized_governance_poll_freezes_both_holder_lens_and_chambers() {
    // spec 208: `close_poll` freezes the SPO/dRep chambers into `PollResult` alongside the holder lens, so
    // a concluded governance poll's chambers can no longer be retroactively re-priced by moving delegation
    // — the same guarantee the holder lens already had against an unstake. This test moves BOTH the holder
    // stake and the observed delegated stake AFTER finalization and asserts NEITHER lens changes.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        TalkStake::apply_voting_power(&10, 100);
        TalkStake::apply_voting_power(&11, 200);
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"ratify?".to_vec(),
            vec![b"yes".to_vec(), b"no".to_vec()],
            Some(11),
            PollKind::Governance,
            None,
        ));
        set_chamber_roles(10, vec![(0, POOL_P, 15_000_000)]); // SPO → "yes"
        set_chamber_roles(11, vec![(1, DREP_D, 7_000_000)]); // dRep → "no"
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(10), 0, 0));
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(11), 0, 1));

        // Freeze the poll at its deadline.
        System::set_block_number(11);
        assert_ok!(Microblog::close_poll(RuntimeOrigin::signed(2), 0));
        assert!(crate::PollResults::<Test>::contains_key(0));

        let frozen = Microblog::poll(0).expect("poll");
        assert_eq!(frozen.kind, 1, "kind survives finalization");
        assert_eq!(
            (frozen.options[0].weight, frozen.options[0].count),
            (100, 1)
        );
        assert_eq!(
            (frozen.options[1].weight, frozen.options[1].count),
            (200, 1)
        );
        // Chambers were frozen at close: pool P (15M) on "yes", dRep D (7M) on "no".
        assert_eq!(
            (frozen.options[0].spo_weight, frozen.options[0].spo_count),
            (15_000_000, 1)
        );
        assert_eq!(
            (frozen.options[1].drep_weight, frozen.options[1].drep_count),
            (7_000_000, 1)
        );

        // After the freeze, move BOTH the holder stake AND the observed delegated stake behind each role.
        TalkStake::apply_voting_power(&10, 999); // holder re-stake …
        set_chamber_roles(10, vec![(0, POOL_P, 1_000_000)]); // … pool P sheds delegation …
        set_chamber_roles(11, vec![(1, DREP_D, 2_000_000)]); // … dRep D sheds delegation.

        let after = Microblog::poll(0).expect("poll");
        // BOTH lenses are FROZEN — neither re-prices to the post-close changes.
        assert_eq!((after.options[0].weight, after.options[0].count), (100, 1));
        assert_eq!(
            after.options[0].spo_weight, 15_000_000,
            "frozen SPO chamber must not re-price after close"
        );
        assert_eq!(
            after.options[1].drep_weight, 7_000_000,
            "frozen dRep chamber must not re-price after close"
        );
    });
}

#[test]
fn close_poll_refunds_weight_and_freezes_chambers() {
    // spec 208: close_poll declares a worst-case weight sized for a FULL observed set (both O(MaxObserved)
    // joins) and then REFUNDS via `actual_weight` down to the rows it actually scanned. This locks that the
    // refund is WIRED — a bare `Ok` leaves `actual_weight = None`, whereas the refund always sets it.
    // (The mock's `DbWeight` is zero, so the reads-based surcharge can't be shown by magnitude here; the
    // presence of `actual_weight` is the behavioural lock. `actual ≤ declared` holds by construction — the
    // scanned set is ≤ `MaxObservedAccounts`.)
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        TalkStake::apply_voting_power(&10, 100);
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"gov?".to_vec(),
            vec![b"yes".to_vec(), b"no".to_vec()],
            Some(11),
            PollKind::Governance,
            None,
        ));
        set_chamber_roles(10, vec![(0, POOL_P, 15_000_000)]);
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(10), 0, 0));
        System::set_block_number(11);

        let post = Microblog::close_poll(RuntimeOrigin::signed(2), 0).expect("closes");
        assert!(
            post.actual_weight.is_some(),
            "close_poll must refund via actual_weight (not a bare Ok)"
        );
        // And the freeze happened (chambers stored, non-empty for this governance poll with a voter).
        assert!(
            crate::PollResults::<Test>::get(0).is_some_and(|r| !r.option_spo_weights.is_empty())
        );
    });
}

// ── single-chamber polls + governance-action tag (spec 209) ──────────────────────────────────────────

#[test]
fn spo_only_poll_populates_spo_chamber_and_suppresses_drep() {
    // An `Spo` poll surfaces the SPO chamber only; the dRep chamber must stay zero on EVERY option even
    // when a genuine dRep votes.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        for who in [10u64, 11] {
            TalkStake::apply_voting_power(&who, 100);
        }
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"spo temp check?".to_vec(),
            vec![b"yes".to_vec(), b"no".to_vec()],
            Some(50_000),
            PollKind::Spo,
            None,
        ));
        let host = 0u64;
        set_chamber_roles(10, vec![(0, POOL_P, 15_000_000)]); // SPO pool → "yes"
        set_chamber_roles(11, vec![(1, DREP_D, 7_000_000)]); // dRep → "yes" (must NOT surface)
        assert_ok!(Microblog::cast_poll_vote(
            RuntimeOrigin::signed(10),
            host,
            0
        ));
        assert_ok!(Microblog::cast_poll_vote(
            RuntimeOrigin::signed(11),
            host,
            0
        ));

        let view = Microblog::poll(host).expect("poll exists");
        assert_eq!(view.kind, 2, "spo-only poll");
        // SPO chamber populated on the chosen option; the untouched option stays zero.
        assert_eq!(
            (view.options[0].spo_weight, view.options[0].spo_count),
            (15_000_000, 1)
        );
        assert_eq!(
            (view.options[1].spo_weight, view.options[1].spo_count),
            (0, 0)
        );
        // The dRep chamber is SUPPRESSED on every option (a dRep-only lens must not show on an Spo poll).
        for o in &view.options {
            assert_eq!(
                (o.drep_weight, o.drep_count),
                (0, 0),
                "dRep chamber must be zero on an Spo poll"
            );
        }
    });
}

#[test]
fn drep_only_poll_populates_drep_chamber_and_suppresses_spo() {
    // Symmetric to `spo_only_poll_...`: a `Drep` poll surfaces the dRep chamber only; the SPO chamber must
    // stay zero on EVERY option even when a genuine pool owner votes.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        for who in [10u64, 11] {
            TalkStake::apply_voting_power(&who, 100);
        }
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"drep temp check?".to_vec(),
            vec![b"yes".to_vec(), b"no".to_vec()],
            Some(50_000),
            PollKind::Drep,
            None,
        ));
        let host = 0u64;
        set_chamber_roles(10, vec![(0, POOL_P, 15_000_000)]); // SPO pool → "yes" (must NOT surface)
        set_chamber_roles(11, vec![(1, DREP_D, 7_000_000)]); // dRep → "yes"
        assert_ok!(Microblog::cast_poll_vote(
            RuntimeOrigin::signed(10),
            host,
            0
        ));
        assert_ok!(Microblog::cast_poll_vote(
            RuntimeOrigin::signed(11),
            host,
            0
        ));

        let view = Microblog::poll(host).expect("poll exists");
        assert_eq!(view.kind, 3, "drep-only poll");
        // dRep chamber populated on the chosen option; the untouched option stays zero.
        assert_eq!(
            (view.options[0].drep_weight, view.options[0].drep_count),
            (7_000_000, 1)
        );
        assert_eq!(
            (view.options[1].drep_weight, view.options[1].drep_count),
            (0, 0)
        );
        // The SPO chamber is SUPPRESSED on every option.
        for o in &view.options {
            assert_eq!(
                (o.spo_weight, o.spo_count),
                (0, 0),
                "SPO chamber must be zero on a Drep poll"
            );
        }
    });
}

#[test]
fn finalized_spo_only_poll_freezes_spo_chamber_and_leaves_drep_zero() {
    // Mirror `finalized_governance_poll_freezes_...` for a single-chamber poll: `close_poll` freezes ONLY
    // the declared chamber. A dRep votes too, but the frozen `Spo` snapshot must still show SPO populated
    // and dRep zero on every option.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        for who in [10u64, 11] {
            TalkStake::apply_voting_power(&who, 100);
        }
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"spo temp check?".to_vec(),
            vec![b"yes".to_vec(), b"no".to_vec()],
            Some(11),
            PollKind::Spo,
            None,
        ));
        set_chamber_roles(10, vec![(0, POOL_P, 15_000_000)]); // SPO pool → "yes"
        set_chamber_roles(11, vec![(1, DREP_D, 7_000_000)]); // dRep → "yes" (must NOT surface)
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(10), 0, 0));
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(11), 0, 0));

        // Freeze the poll at its deadline.
        System::set_block_number(11);
        assert_ok!(Microblog::close_poll(RuntimeOrigin::signed(2), 0));
        assert!(crate::PollResults::<Test>::contains_key(0));

        let frozen = Microblog::poll(0).expect("poll");
        assert_eq!(frozen.kind, 2, "kind survives finalization");
        // The frozen SPO chamber is populated on the chosen option …
        assert_eq!(
            (frozen.options[0].spo_weight, frozen.options[0].spo_count),
            (15_000_000, 1)
        );
        // … while the dRep chamber stays zero on every option (it was never frozen on an Spo poll).
        for o in &frozen.options {
            assert_eq!(
                (o.drep_weight, o.drep_count),
                (0, 0),
                "frozen dRep chamber must stay zero on an Spo poll"
            );
        }
    });
}

#[test]
fn finalized_drep_only_poll_freezes_drep_chamber_and_leaves_spo_zero() {
    // The symmetric mirror of the Spo freeze test — exercises the freeze path's `!has_spo()` branch (empty
    // the SPO chamber) on a finalized `Drep` poll: the dRep chamber must be frozen populated while SPO
    // stays zero on every option, even though a real SPO pool voted.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        for who in [10u64, 11] {
            TalkStake::apply_voting_power(&who, 100);
        }
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"drep temp check?".to_vec(),
            vec![b"yes".to_vec(), b"no".to_vec()],
            Some(11),
            PollKind::Drep,
            None,
        ));
        set_chamber_roles(10, vec![(0, POOL_P, 15_000_000)]); // SPO pool → "yes" (must NOT surface)
        set_chamber_roles(11, vec![(1, DREP_D, 7_000_000)]); // dRep → "yes"
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(10), 0, 0));
        assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(11), 0, 0));

        // Freeze the poll at its deadline.
        System::set_block_number(11);
        assert_ok!(Microblog::close_poll(RuntimeOrigin::signed(2), 0));
        assert!(crate::PollResults::<Test>::contains_key(0));

        let frozen = Microblog::poll(0).expect("poll");
        assert_eq!(frozen.kind, 3, "kind survives finalization");
        // The frozen dRep chamber is populated on the chosen option …
        assert_eq!(
            (frozen.options[0].drep_weight, frozen.options[0].drep_count),
            (7_000_000, 1)
        );
        // … while the SPO chamber stays zero on every option (it was never frozen on a Drep poll).
        for o in &frozen.options {
            assert_eq!(
                (o.spo_weight, o.spo_count),
                (0, 0),
                "frozen SPO chamber must stay zero on a Drep poll"
            );
        }
    });
}

#[test]
fn governance_action_tag_round_trips_through_storage_and_view() {
    // A `Governance` poll tagged with a CIP-1694 action stores the typed `GovAction` and surfaces it in
    // the node-served `PollView` with the action type as its pinned u8.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"withdraw from treasury?".to_vec(),
            vec![b"yes".to_vec(), b"no".to_vec()],
            Some(50_000),
            PollKind::Governance,
            Some(crate::GovActionInput {
                action_type: crate::GovActionType::TreasuryWithdrawal,
                anchor_url: b"https://github.com/x/y".to_vec(),
                anchor_hash: None,
            }),
        ));
        let host = 0u64;
        // Stored form: the typed action_type + the bounded anchor bytes.
        let stored = Polls::<Test>::get(host)
            .expect("poll")
            .action
            .expect("action stored");
        assert_eq!(stored.action_type, crate::GovActionType::TreasuryWithdrawal);
        assert_eq!(
            stored.anchor_url.to_vec(),
            b"https://github.com/x/y".to_vec()
        );
        assert_eq!(stored.anchor_hash, None);
        // View form: action_type as the pinned u8 (6 = TreasuryWithdrawal) + the same anchor bytes.
        let view_action = Microblog::poll(host)
            .expect("poll")
            .action
            .expect("action in view");
        assert_eq!(view_action.action_type, 6u8);
        assert_eq!(view_action.anchor_url, b"https://github.com/x/y".to_vec());
        assert_eq!(view_action.anchor_hash, None);
    });
}

#[test]
fn governance_action_tag_allowed_on_single_chamber_kinds() {
    // The gov-action tag is gated on `kind.has_chambers()`, which the single-chamber `Spo`/`Drep` kinds
    // satisfy — so an action tag rides on them exactly like on `Governance` (this guards the `Stake`-only
    // rejection from ever widening to reject a valid single-chamber tag). Both round-trip: the typed
    // `GovAction` in storage and the pinned-u8 action type in the node-served view.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // (host id, poll kind, action type, its pinned u8) — NextPostId allocates 0 then 1.
        let cases = [
            (0u64, PollKind::Spo, crate::GovActionType::ParamChange, 5u8),
            (
                1u64,
                PollKind::Drep,
                crate::GovActionType::NewConstitution,
                3u8,
            ),
        ];
        for (host, kind, action_type, ix) in cases {
            assert_ok!(Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"gov?".to_vec(),
                vec![b"yes".to_vec(), b"no".to_vec()],
                Some(50_000),
                kind,
                Some(crate::GovActionInput {
                    action_type,
                    anchor_url: b"https://ipfs.io/ipfs/cid".to_vec(),
                    anchor_hash: None,
                }),
            ));
            let stored = Polls::<Test>::get(host)
                .expect("poll")
                .action
                .expect("action stored on a single-chamber poll");
            assert_eq!(stored.action_type, action_type);
            assert_eq!(
                stored.anchor_url.to_vec(),
                b"https://ipfs.io/ipfs/cid".to_vec()
            );
            let view_action = Microblog::poll(host)
                .expect("poll")
                .action
                .expect("action in view");
            assert_eq!(view_action.action_type, ix);
            assert_eq!(view_action.anchor_url, b"https://ipfs.io/ipfs/cid".to_vec());
        }
    });
}

#[test]
fn governance_action_on_stake_poll_is_rejected() {
    // A governance-action tag is only valid on a CHAMBER poll — a `Stake` poll has no chamber body to
    // signal to, so it is rejected.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_noop!(
            Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"plain?".to_vec(),
                vec![b"yes".to_vec(), b"no".to_vec()],
                Some(50_000),
                PollKind::Stake,
                Some(crate::GovActionInput {
                    action_type: crate::GovActionType::Info,
                    anchor_url: b"https://github.com/x/y".to_vec(),
                    anchor_hash: None,
                }),
            ),
            Error::<Test>::GovActionRequiresChamber
        );
    });
}

#[test]
fn governance_action_with_empty_anchor_is_rejected() {
    // The anchor URL must be present: an empty anchor is rejected as an invalid anchor.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_noop!(
            Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"gov?".to_vec(),
                vec![b"yes".to_vec(), b"no".to_vec()],
                Some(50_000),
                PollKind::Governance,
                Some(crate::GovActionInput {
                    action_type: crate::GovActionType::Info,
                    anchor_url: vec![],
                    anchor_hash: None,
                }),
            ),
            Error::<Test>::InvalidAnchor
        );
    });
}

#[test]
fn governance_action_with_over_long_anchor_is_rejected() {
    // MaxAnchorUrlLen is 256 in the mock; a 257-byte anchor exceeds the bound and is rejected.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_noop!(
            Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"gov?".to_vec(),
                vec![b"yes".to_vec(), b"no".to_vec()],
                Some(50_000),
                PollKind::Governance,
                Some(crate::GovActionInput {
                    action_type: crate::GovActionType::Info,
                    anchor_url: vec![b'a'; 257],
                    anchor_hash: None,
                }),
            ),
            Error::<Test>::InvalidAnchor
        );
    });
}

// Spec 212 replaces `too_many_posts_is_rejected_without_consuming_id`. The old mock capped an author
// at `MaxPostsPerAuthor = 8`, and that test pinned the BRICK: the 9th post reverted `TooManyPosts`, and
// with no `delete_post` and no pruning it reverted forever. The cap is gone with the bounded-vec shape,
// so the property to pin now is the opposite one.
#[test]
fn an_author_posts_past_the_old_cap_and_the_index_stays_dense() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // Well past the retired `MaxPostsPerAuthor = 8` mock bound, mixing top-level and replies so
        // both indexes are exercised (a reply lands in `ByAuthor` only).
        for i in 0..25u64 {
            let parent = if i % 5 == 4 { Some(0) } else { None };
            assert_ok!(Microblog::post_message(
                RuntimeOrigin::signed(1),
                vec![b'x'],
                parent
            ));
        }
        assert_eq!(NextPostId::<Test>::get(), 25);

        // Every post is indexed, the counter agrees, and the seq keys are dense 0..count with the ids
        // ascending — the invariant the seq-descending readers walk.
        assert_eq!(ByAuthorCount::<Test>::get(1), 25);
        let ids: Vec<u64> = (0..25)
            .map(|s| ByAuthor::<Test>::get(1, s).unwrap())
            .collect();
        assert_eq!(ids, (0..25).collect::<Vec<u64>>());
        assert!(ByAuthor::<Test>::get(1, 25).is_none(), "dense 0..count");

        // 5 of the 25 were replies, so the reply-free index (and the profile post count) holds 20.
        assert_eq!(TopLevelByAuthorCount::<Test>::get(1), 20);
        assert_eq!(Microblog::top_level_post_count(&1), 20);
        let top: Vec<u64> = (0..20)
            .map(|s| TopLevelByAuthor::<Test>::get(1, s).unwrap())
            .collect();
        assert!(top.windows(2).all(|w| w[0] < w[1]), "ascending id order");
        assert!(top.iter().all(|id| id % 5 != 4), "reply-free");

        // A different author starts its own sequence at 0 (the maps are per-author).
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(2),
            vec![b'z'],
            None
        ));
        assert_eq!(ByAuthorCount::<Test>::get(2), 1);
        assert_eq!(ByAuthor::<Test>::get(2, 0), Some(25));

        assert_ok!(Microblog::check_tally_consistency());
    });
}

// ── talk-capacity meter (mock constants: cap = min(weight·10, 5000); rate = weight·1/block;
//    cost = 100 + 1·len) ───────────────────────────────────────────────────────────────────

#[test]
fn first_touch_capacity_is_zero() {
    new_test_ext().execute_with(|| {
        // Weighted but never bound: cap is positive, but the bucket has no row yet → 0.
        TalkStake::apply_weight(&1, 100); // cap would be 1000
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
        assert!(
            Microblog::post_cost(huge) < u128::MAX,
            "no saturation for the mock's PerByteCost=1"
        );
    });
}

#[test]
fn capacity_regenerates_then_clamps_to_cap() {
    new_test_ext().execute_with(|| {
        System::set_block_number(10);
        TalkStake::apply_weight(&1, 100); // cap=1000, rate=100/block
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
        TalkStake::apply_weight(&1, 100); // rate 100/block
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
        TalkStake::apply_weight(&1, 5); // rate 5/block, cap min(50,5000)=50
        assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 1, 0)); // empty, dated @10
                                                                                // Exactly one block ⇒ exactly one regen tick of weight·RegenPerBlock = 5 (not a constant
                                                                                // offset, not exponential): the curve is linear at the per-block rate.
        assert_eq!(Microblog::current_capacity(&1, 11), 5);
        // Linear across multiple blocks: 5·k for k = 1..=10 until the ceiling (50) clamps it.
        for k in 1..=10u64 {
            let expected = core::cmp::min(5 * k as u128, 50);
            assert_eq!(
                Microblog::current_capacity(&1, 10 + k),
                expected,
                "block +{k} regen is linear"
            );
        }
        // Past the fill point it stays clamped at the ceiling, never overshoots.
        assert_eq!(Microblog::current_capacity(&1, 100), 50);
    });
}

#[test]
fn consume_reduces_banked_capacity() {
    new_test_ext().execute_with(|| {
        System::set_block_number(10);
        TalkStake::apply_weight(&1, 100);
        assert_ok!(Microblog::force_set_capacity(
            RuntimeOrigin::root(),
            1,
            1000
        )); // full
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
        TalkStake::apply_weight(&1, 1000);
        assert_ok!(Microblog::force_set_capacity(
            RuntimeOrigin::root(),
            1,
            9999
        ));
        assert_eq!(Microblog::current_capacity(&1, 1), 5000); // clamped to the ceiling
    });
}

#[test]
fn unlock_clamps_capacity_to_zero() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        observe_weight(&1, 100);
        assert_ok!(Microblog::force_set_capacity(
            RuntimeOrigin::root(),
            1,
            1000
        ));
        assert_eq!(Microblog::current_capacity(&1, 1), 1000);
        // Full unlock: weight → 0 makes cap = 0, so current clamps to min(0, …) = 0 — even though
        // the banked cap_last is 1000 and the row is NOT deleted.
        observe_weight(&1, 0);
        assert_eq!(Microblog::current_capacity(&1, 5), 0);
        assert!(Capacity::<Test>::get(1).is_some()); // row persists (relock-farm guard)

        // RELOCK. Zero capacity while unlocked is only half the invariant — the bucket must not spring
        // back when the weight returns. The 24 blocks spent at weight 0 earned nothing, and the pre-unlock
        // bank is not restored, so the relocked account starts from EMPTY and charges up.
        System::set_block_number(25);
        observe_weight(&1, 100);
        assert_eq!(
            Microblog::current_capacity(&1, 25),
            0,
            "relock starts from empty — the zero-weight window banks nothing"
        );
        assert_eq!(Microblog::current_capacity(&1, 30), 500); // 5 blocks · weight 100
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
                                      // The observer credits weight 20 blocks after the bind (the real gap: a first lock is only
                                      // observable a stability window after it lands). Raising weight lifts the future cap/rate but
                                      // must not retroactively credit cap_last for a window the account spent with NO weight.
        System::set_block_number(30);
        observe_weight(&1, 100);
        let row = Capacity::<Test>::get(1).expect("row exists");
        assert_eq!(row.cap_last, 0); // going-forward-only: the credit banks nothing
                                     // Restamped to the credit block. Without the restamp the 20 unweighted blocks would be
                                     // re-priced at the NEW weight on the very next read — the retro-credit.
        assert_eq!(row.last_block, 30);
        // The stored row alone does NOT prove the invariant: `current_capacity` regenerates on READ, so
        // assert it there too — the bucket charges up from empty, it does not arrive full.
        assert_eq!(Microblog::current_capacity(&1, 30), 0);
        assert_eq!(Microblog::current_capacity(&1, 40), 1_000); // full only after cap/rate = 10 blocks
    });
}

// ── the observer weight sink: settle-at-the-old-weight (the going-forward-only rule) ────────────
// These drive `observe_weight`, the mock's thin alias for `Pallet::apply_observed_weight` — the SAME
// function the runtime's `WeightSink` calls, so these tests exercise the code that actually runs rather
// than a copy of it. `apply_observed_weight` is what carries the settle (not the sink, and certainly not
// `TalkStake::apply_weight` — never reach for that directly here, it changes weight without settling).
// Weight only ever enters a real chain through this path.

#[test]
fn zero_weight_period_earns_no_regen() {
    new_test_ext().execute_with(|| {
        // Bind at 10, but weight is only observed at 30: on the live chain a first lock is not visible
        // until a stability window after the bind. Those 20 blocks are spent at ZERO weight.
        System::set_block_number(10);
        Microblog::on_first_bind(&1);
        System::set_block_number(30);
        observe_weight(&1, 100);

        // The bucket regenerates at the weight held DURING the window, and that was zero — so the first
        // lock buys an EMPTY bucket that charges up, not a full one. (Fill time is weight-independent:
        // CapRatio/RegenPerBlock, here 10 blocks, so an un-settled window hands over a full battery.)
        assert_eq!(Microblog::current_capacity(&1, 30), 0);
        // Regen starts at the credit block, at the new weight: 5 blocks · 100 = 500 (ceiling 1000).
        assert_eq!(Microblog::current_capacity(&1, 35), 500);
    });
}

#[test]
fn relock_after_observer_unlock_starts_from_empty() {
    new_test_ext().execute_with(|| {
        // Earn a full bucket: weight 100 ⇒ ceiling 1000, rate 100/block ⇒ full 10 blocks after the bind.
        System::set_block_number(10);
        observe_weight(&1, 100);
        System::set_block_number(20);
        assert_eq!(Microblog::current_capacity(&1, 20), 1_000, "bucket is full");

        // The observer clamps the weight to 0 (the vault was emptied). Distinct from `on_revoke`, which
        // restamps the row itself — nothing here restamps it but the sink's settle.
        observe_weight(&1, 0);
        assert_eq!(Microblog::current_capacity(&1, 20), 0);

        // Idle 20 blocks unlocked, then relock.
        System::set_block_number(40);
        assert_eq!(Microblog::current_capacity(&1, 40), 0, "still zero unlocked");
        observe_weight(&1, 100);
        assert_eq!(
            Microblog::current_capacity(&1, 40),
            0,
            "the relocked bucket starts EMPTY: the zero-weight window banked nothing and the pre-unlock \
             bank is not restored"
        );
        assert_eq!(Microblog::current_capacity(&1, 45), 500);
    });
}

#[test]
fn unchanged_weight_writes_nothing_and_emits_no_event() {
    new_test_ext().execute_with(|| {
        let stake_set_events = || {
            System::events()
                .into_iter()
                .filter(|e| {
                    matches!(
                        e.event,
                        RuntimeEvent::TalkStake(pallet_talk_stake::Event::StakeSet { .. })
                    )
                })
                .count()
        };

        System::set_block_number(10);
        observe_weight(&1, 100); // first credit: one write, one StakeSet
        assert_eq!(stake_set_events(), 1);

        // The observer re-derives the FULL vault set every block and re-applies every credited account.
        // An unchanged weight must cost NOTHING: no `AllowedStake` write, no event, and — critically — no
        // capacity settle. Without the `previous != weight` guard this is an O(MaxObserved) write storm in
        // a Mandatory inherent, and the settle would restamp every bucket on every block.
        System::set_block_number(20);
        observe_weight(&1, 100);
        assert_eq!(
            stake_set_events(),
            1,
            "no second StakeSet for an unchanged weight"
        );
        let row = Capacity::<Test>::get(1).expect("row exists");
        assert_eq!(
            row.last_block, 10,
            "an unchanged weight does NOT restamp the bucket (no per-block settle storm)"
        );
        // And the bucket kept regenerating across the no-op observation, exactly as before.
        assert_eq!(Microblog::current_capacity(&1, 20), 1_000);
    });
}

#[test]
fn raising_weight_does_not_retro_credit_at_the_new_weight() {
    new_test_ext().execute_with(|| {
        // A small lock idles for a long time: weight 10 ⇒ ceiling 100, so the bucket sits capped at 100.
        System::set_block_number(10);
        observe_weight(&1, 10);
        System::set_block_number(1_010);
        assert_eq!(
            Microblog::current_capacity(&1, 1_010),
            100,
            "capped at the small lock's ceiling"
        );

        // Now escalate to weight 1000 (ceiling min(10_000, 5_000) = 5_000). The idle window was spent at
        // weight 10 and is settled at weight 10 — it must NOT be re-priced at the new rate, which would
        // hand over a full 5_000 battery for a lock that arrived one block ago.
        observe_weight(&1, 1_000);
        assert_eq!(
            Microblog::current_capacity(&1, 1_010),
            100,
            "the raise carries over exactly the 100 settled at the OLD weight"
        );
        // From here it regenerates at the NEW rate toward the NEW ceiling. Weight 1000 is PAST the
        // mock's knee (Ceiling/CapRatio = 500), so since spec 212 that rate is the FLATTENED
        // ceiling/window = 5_000/10 = 500 per block, not the unclamped weight·RegenPerBlock = 1_000.
        assert_eq!(Microblog::current_capacity(&1, 1_011), 600);
        assert_eq!(Microblog::current_capacity(&1, 1_020), 5_000);
    });
}

#[test]
fn the_refill_rate_flattens_at_the_same_knee_as_the_bucket() {
    // Spec 212. Before this, `capacity_ceiling` clamped only the BUCKET and the refill rate was a bare
    // `weight · RegenPerBlock` that grew without limit — so above the bucket knee the burst flattened
    // while SUSTAINED throughput, the thing that actually competes for block space, stayed linear. The
    // rate's own knee sat a whole refill window further out (Ceiling/RegenPerBlock), undocumented.
    // Mock: CapRatio 10, RegenPerBlock 1, Ceiling 5_000 ⇒ knee at weight 500, window 10 blocks.
    new_test_ext().execute_with(|| {
        const KNEE: u128 = 500; // Ceiling / CapRatio
        const WINDOW: u128 = 10; // CapRatio / RegenPerBlock

        // BELOW the knee the derived rate is EXACTLY the old `weight · RegenPerBlock` — the division
        // by CapRatio cancels, so no under-ceiling account sees any change at all.
        for w in [1u128, 7, 100, KNEE] {
            assert_eq!(
                Microblog::regen_per_block(w),
                w,
                "below the knee the rate is unchanged"
            );
        }
        // ABOVE it, the rate stops growing with the bucket.
        for w in [KNEE + 1, 1_000, 10_000, u128::MAX] {
            assert_eq!(
                Microblog::regen_per_block(w),
                KNEE,
                "past the knee the rate flattens; a whale cannot out-post the ceiling"
            );
        }
        // The property this buys: EVERY account refills empty→full in the SAME window, whatever its
        // stake. Stake sets how big the bucket is, never how fast it fills.
        for w in [1u128, KNEE, KNEE * 100, u128::MAX] {
            let cap = Microblog::capacity_ceiling(w);
            let rate = Microblog::regen_per_block(w);
            assert_eq!(cap / rate, WINDOW, "weight-independent refill window");
        }
        // And it is live, not just arithmetic: a 20x-over-knee account still needs the full window.
        System::set_block_number(1);
        observe_weight(&1, KNEE * 20);
        assert_eq!(
            Microblog::current_capacity(&1, 1),
            0,
            "first touch is empty"
        );
        System::set_block_number(1 + WINDOW as u64);
        assert_eq!(
            Microblog::current_capacity(&1, 1 + WINDOW as u64),
            5_000,
            "full after exactly the window, not sooner"
        );
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
        // No stake ⇒ ceiling 0 ⇒ a force cannot mint capacity unbacked by locked stake.
        assert_ok!(Microblog::force_set_capacity(
            RuntimeOrigin::root(),
            1,
            1_000
        ));
        assert_eq!(Capacity::<Test>::get(1).unwrap().cap_last, 0);
        System::assert_last_event(
            Event::CapacityForced {
                who: 1,
                cap_last: 0,
            }
            .into(),
        );

        // weight 100 ⇒ ceiling min(100·10, 5000) = 1000 ⇒ a force above it is clamped to 1000.
        TalkStake::apply_weight(&2, 100);
        assert_ok!(Microblog::force_set_capacity(
            RuntimeOrigin::root(),
            2,
            9_999
        ));
        assert_eq!(Capacity::<Test>::get(2).unwrap().cap_last, 1_000);

        // A force within the ceiling is stored verbatim (the legitimate priming path).
        assert_ok!(Microblog::force_set_capacity(RuntimeOrigin::root(), 2, 400));
        assert_eq!(Capacity::<Test>::get(2).unwrap().cap_last, 400);

        // Boundary: cap_last == ceiling EXACTLY passes through unclamped (not clamped to < ceiling).
        // weight 100 ⇒ ceiling 1000; force exactly 1000.
        assert_ok!(Microblog::force_set_capacity(
            RuntimeOrigin::root(),
            2,
            1_000
        ));
        assert_eq!(Capacity::<Test>::get(2).unwrap().cap_last, 1_000);
        System::assert_last_event(
            Event::CapacityForced {
                who: 2,
                cap_last: 1_000,
            }
            .into(),
        );

        // Boundary: ceiling + 1 is clamped down to exactly the ceiling (off-by-one guard).
        assert_ok!(Microblog::force_set_capacity(
            RuntimeOrigin::root(),
            2,
            1_001
        ));
        assert_eq!(Capacity::<Test>::get(2).unwrap().cap_last, 1_000);
        // The event reports the CLAMPED value, never the requested over-ceiling input.
        System::assert_last_event(
            Event::CapacityForced {
                who: 2,
                cap_last: 1_000,
            }
            .into(),
        );
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
        assert_eq!(
            providers(1),
            base + 1,
            "on_bind takes exactly one provider ref"
        );
        let row = Capacity::<Test>::get(1).expect("on_bind primes the (empty, dated) row");
        assert_eq!(row.cap_last, 0);
        assert_eq!(row.last_block, 10);

        // A second on_bind (e.g. a relock path) re-takes a provider ref (the trait is symmetric per
        // bind), but must NOT re-mint the capacity bucket — the row stays empty and dated @10, so a
        // relock cannot read a None first-touch and start a fresh full-charging bucket.
        System::set_block_number(50);
        <Microblog as OnIdentityBind<u64>>::on_bind(&1);
        let row2 = Capacity::<Test>::get(1).expect("row still exists");
        assert_eq!(
            row2.last_block, 10,
            "row is NOT re-dated on a second bind (relock-farm guard)"
        );
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
        observe_weight(&1, 100);
        assert_ok!(Microblog::force_set_capacity(
            RuntimeOrigin::root(),
            1,
            1_000
        ));
        System::set_block_number(20);
        assert!(
            Microblog::current_capacity(&1, 20) > 0,
            "banked capacity is live before revoke"
        );

        // Revoke: provider ref released (back to baseline, no leak), capacity zeroed, ROW KEPT.
        <Microblog as OnIdentityBind<u64>>::on_revoke(&1);
        assert_eq!(
            providers(1),
            base,
            "revoke releases the bind provider ref (no leak)"
        );
        let row = Capacity::<Test>::get(1).expect("row kept on revoke (relock-farm guard)");
        assert_eq!(row.cap_last, 0, "banked capacity zeroed on revoke");
        assert_eq!(row.last_block, 20, "revoke re-dates the zeroed row to now");
        // Capacity is observably zero even though weight is still 100 (the row was zeroed).
        assert_eq!(
            Microblog::current_capacity(&1, 20),
            0,
            "no usable capacity right after revoke"
        );

        // Rebind: provider ref re-taken, but the KEPT row must NOT be re-minted into a fresh full
        // bucket — on_first_bind is a no-op because the row already exists. This is the relock-farm
        // guard: a bind/revoke/rebind cycle cannot manufacture a fresh first-touch bucket.
        System::set_block_number(30);
        <Microblog as OnIdentityBind<u64>>::on_bind(&1);
        assert_eq!(providers(1), base + 1, "rebind re-takes the provider ref");
        let row2 = Capacity::<Test>::get(1).expect("row still exists after rebind");
        assert_eq!(row2.cap_last, 0, "rebind does NOT re-mint a fresh bucket");
        assert_eq!(
            row2.last_block, 20,
            "rebind does NOT re-date the kept row (no relock first-touch)"
        );

        // ── The OTHER way to zero: the OBSERVER clamp (the user empties their vault). `on_revoke` above
        // restamps the row itself; the observer's weight write does not, so on this path the settle in the
        // sink is the ONLY thing standing between an unlock/relock cycle and a re-minted bucket.
        // Weight is still 100 and the row was zeroed @20, so by block 40 it has legitimately recharged.
        System::set_block_number(40);
        assert_eq!(
            Microblog::current_capacity(&1, 40),
            1_000,
            "recharged at the still-live weight"
        );
        observe_weight(&1, 0); // vault emptied — the observer clamps the weight to 0
        assert_eq!(
            Microblog::current_capacity(&1, 40),
            0,
            "zero weight ⇒ zero ceiling ⇒ no usable capacity"
        );

        // Idle 20 blocks unlocked, then relock. The zero-weight window earns nothing and the pre-unlock
        // bank does not return: the relocked bucket starts EMPTY, exactly as at first bind.
        System::set_block_number(60);
        observe_weight(&1, 100);
        assert_eq!(
            Microblog::current_capacity(&1, 60),
            0,
            "observer-clamp relock starts from empty (relock-farm guard)"
        );
        assert_eq!(
            Microblog::current_capacity(&1, 65),
            500,
            "and charges up from there at weight 100"
        );
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
        assert_eq!(
            Capacity::<Test>::get(1).expect("row still kept").cap_last,
            0
        );
        // The capacity row is unchanged by a redundant revoke.
        assert!(
            providers(1) <= providers_before,
            "redundant revoke never inflates the provider ref"
        );
    });
}

// ── CheckCapacity transaction extension — the WHOLE feeless anti-spam budget ───────────────────
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
        TalkStake::apply_weight(&who, weight);
        assert_ok!(Microblog::force_set_capacity(
            RuntimeOrigin::root(),
            who,
            cap
        ));
    }

    #[test]
    fn over_budget_post_rejected_at_pool() {
        new_test_ext().execute_with(|| {
            System::set_block_number(10);
            prime(1, 100, 50); // cap ceiling 1000, but bucket only 50 < cost(5)=105
            let err = validate(1, &post_call(b"hello".to_vec()))
                .map(|_| ())
                .unwrap_err();
            assert_eq!(
                err,
                TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources)
            );
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
            let err = validate(1, &post_call(b"hello".to_vec()))
                .map(|_| ())
                .unwrap_err();
            assert_eq!(
                err,
                TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources)
            );
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
            assert_eq!(
                err,
                TransactionValidityError::Invalid(InvalidTransaction::Call)
            );
        });
    }

    /// `validate` with the REAL encoded length of the call, which is what the pool passes in.
    fn validate_len(
        who: u64,
        call: &RuntimeCall,
    ) -> Result<(u64, crate::Pre<Test>), TransactionValidityError> {
        let info = call.get_dispatch_info();
        Ext::new()
            .validate(
                RuntimeOrigin::signed(who),
                call,
                &info,
                codec::Encode::encoded_size(call),
                (),
                &TxBaseImplication(()),
                TransactionSource::External,
            )
            .map(|(vt, pre, _origin)| (vt.priority, pre))
    }

    #[test]
    fn an_oversized_metered_call_is_rejected_whatever_field_carries_the_bytes() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            prime(1, 1_000, 5_000); // plenty of capacity, so only the length gate can reject
            // The hole this closes: `create_poll` is priced on `question.len()` ALONE, so an empty
            // question carrying a multi-megabyte OPTION was admitted, gossiped and included for the
            // price of one empty post, then failed `OptionTooLong` in dispatch with the bytes already
            // in the block body forever. The per-field `over_len` check never looked at `options`.
            let attack = RuntimeCall::Microblog(crate::Call::create_poll {
                question: vec![],
                options: vec![vec![0u8; 3_600_000], vec![1u8]],
                close_at: None,
                kind: PollKind::Stake,
                action: None,
            });
            assert_eq!(
                validate_len(1, &attack).map(|_| ()).unwrap_err(),
                TransactionValidityError::Invalid(InvalidTransaction::Call),
                "an oversized metered call must be rejected at the pool as MALFORMED, never retried",
            );

            // And the gate must not touch a well-formed call: every field at its documented maximum
            // still validates, so the ceiling can only ever catch calls the dispatch would reject.
            let legit = RuntimeCall::Microblog(crate::Call::create_poll {
                question: vec![b'q'; 512],
                options: vec![vec![b'o'; 80], vec![b'o'; 80], vec![b'o'; 80], vec![b'o'; 80]],
                close_at: None,
                kind: PollKind::Stake,
                action: None,
            });
            assert!(
                validate_len(1, &legit).is_ok(),
                "a maximal but WELL-FORMED metered call must still pass the pool",
            );
        });
    }

    #[test]
    fn non_metered_calls_pass_through_without_consuming() {
        new_test_ext().execute_with(|| {
            System::set_block_number(10);
            prime(1, 100, 1_000);
            // force_set_capacity is a Microblog call but is NOT metered: validate passes through and
            // post_dispatch consumes nothing (the `metered_cost` helper returns None for it).
            let call = RuntimeCall::Microblog(crate::Call::force_set_capacity {
                who: 1,
                cap_last: 0,
            });
            let (_p, pre) = validate(1, &call).expect("non-metered passes");
            post_dispatch(pre, Ok(()));
            assert_eq!(Microblog::current_capacity(&1, 10), 1_000); // unchanged
        });
    }

    #[test]
    fn each_engagement_call_is_metered_at_its_constant() {
        new_test_ext().execute_with(|| {
            System::set_block_number(10);
            // VoteCost 50, FollowCost 30 in the mock; cap ceiling 1000.
            let vote = RuntimeCall::Microblog(crate::Call::vote {
                post_id: 0,
                dir: crate::VoteDir::Up,
            });
            let unfollow = RuntimeCall::Microblog(crate::Call::unfollow { target: 2 });
            let follow = RuntimeCall::Microblog(crate::Call::follow { target: 2 });
            for (call, cost) in [(vote, 50u128), (unfollow, 30), (follow, 30)] {
                prime(1, 100, 1_000); // reset to a full bucket each iteration
                let (priority, pre) = validate(1, &call).expect("affordable");
                assert_eq!(
                    priority as u128,
                    1_000 - cost,
                    "priority is remaining headroom"
                );
                post_dispatch(pre, Ok(()));
                assert_eq!(
                    Microblog::current_capacity(&1, 10),
                    1_000 - cost,
                    "debited exactly the cost"
                );
            }
        });
    }

    #[test]
    fn over_budget_vote_is_rejected_at_pool() {
        new_test_ext().execute_with(|| {
            System::set_block_number(10);
            prime(1, 100, 40); // < VoteCost 50
            let call = RuntimeCall::Microblog(crate::Call::vote {
                post_id: 0,
                dir: crate::VoteDir::Up,
            });
            let err = validate(1, &call).map(|_| ()).unwrap_err();
            assert_eq!(
                err,
                TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources)
            );
        });
    }

    #[test]
    fn over_length_quote_is_rejected_at_pool() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            prime(1, 1_000, 5_000); // plenty, so only the length gate can reject
            let big = vec![0u8; 513]; // > MaxLength 512
            let call = RuntimeCall::Microblog(crate::Call::quote_post {
                text: big,
                quoted_id: 0,
            });
            let err = validate(1, &call).map(|_| ()).unwrap_err();
            // Call (malformed), NOT ExhaustsResources — the length gate covers quote_post too.
            assert_eq!(
                err,
                TransactionValidityError::Invalid(InvalidTransaction::Call)
            );
        });
    }

    #[test]
    fn metered_cost_matches_constants() {
        new_test_ext().execute_with(|| {
            use crate::Call;
            let cost = |c: Call<Test>| Microblog::metered_cost(&c);
            assert_eq!(
                cost(Call::post_message {
                    text: vec![0u8; 5],
                    parent: None
                }),
                Some(105)
            ); // 100 + 5
            assert_eq!(
                cost(Call::quote_post {
                    text: vec![0u8; 5],
                    quoted_id: 0
                }),
                Some(105)
            );
            assert_eq!(
                cost(Call::vote {
                    post_id: 0,
                    dir: crate::VoteDir::Up
                }),
                Some(50)
            );
            assert_eq!(cost(Call::clear_vote { post_id: 0 }), Some(50));
            assert_eq!(cost(Call::follow { target: 2 }), Some(30));
            assert_eq!(cost(Call::unfollow { target: 2 }), Some(30));
            assert_eq!(
                cost(Call::create_poll {
                    question: vec![0u8; 5],
                    options: vec![],
                    close_at: None,
                    kind: PollKind::Stake,
                    action: None
                }),
                Some(105)
            ); // post_cost
            assert_eq!(
                cost(Call::cast_poll_vote {
                    post_id: 0,
                    option: 0
                }),
                Some(50)
            ); // VoteCost
            assert_eq!(cost(Call::close_poll { host_id: 0 }), Some(50)); // VoteCost (finalize)
                                                                         // Not metered.
            assert_eq!(
                cost(Call::force_set_capacity {
                    who: 1,
                    cap_last: 0
                }),
                None
            );
        });
    }

    #[test]
    fn foreign_call_is_metered_via_foreign_cost() {
        new_test_ext().execute_with(|| {
            System::set_block_number(10);
            // A NON-microblog call (System::remark) the runtime prices via the `ForeignCost` seam at 200
            // (the mock's `MockForeignCost`). It must draw on the SAME battery and be gated at the pool —
            // exactly how pallet-profile's feeless writes are metered against `ProfileCost` in the runtime.
            let foreign = RuntimeCall::System(frame_system::Call::remark { remark: vec![] });

            // Affordable: priced 200, priority == remaining headroom, consumes exactly 200.
            prime(1, 100, 1_000);
            let (priority, pre) = validate(1, &foreign).expect("affordable foreign call passes");
            assert_eq!(
                priority as u128,
                1_000 - 200,
                "priority is remaining headroom after the foreign cost"
            );
            post_dispatch(pre, Ok(()));
            assert_eq!(
                Microblog::current_capacity(&1, 10),
                800,
                "debited exactly the foreign cost (200)"
            );

            // Over budget: < 200 banked ⇒ rejected at the pool, just like an over-budget post.
            prime(2, 100, 150);
            let err = validate(2, &foreign).map(|_| ()).unwrap_err();
            assert_eq!(
                err,
                TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources)
            );
        });
    }

    #[test]
    fn unpayable_foreign_call_is_rejected_as_malformed_not_as_a_rate_limit() {
        new_test_ext().execute_with(|| {
            System::set_block_number(10);
            // A brim-full battery: nothing about this rejection is a budget shortfall.
            prime(1, 100, 1_000);
            let doomed = RuntimeCall::System(frame_system::Call::kill_prefix {
                prefix: vec![],
                subkeys: 0,
            });
            let err = validate(1, &doomed).map(|_| ()).unwrap_err();
            // `Call` (malformed), NOT `ExhaustsResources`. The call can never succeed for this signer,
            // so retrying it is pointless — and `ExhaustsResources` is exactly what the client reads as
            // "you are posting too fast", which would be the wrong thing to tell them here.
            assert_eq!(
                err,
                TransactionValidityError::Invalid(InvalidTransaction::Call)
            );
            // …and nothing was consumed: the reject happens before the battery is touched.
            assert_eq!(Microblog::current_capacity(&1, 10), 1_000);
            // A genuinely over-budget call still gets the RETRIABLE code, so the two arms stay distinct.
            prime(2, 100, 150);
            let foreign = RuntimeCall::System(frame_system::Call::remark { remark: vec![] });
            assert_eq!(
                validate(2, &foreign).map(|_| ()).unwrap_err(),
                TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources)
            );
        });
    }

    #[test]
    fn unpriced_foreign_call_passes_through_unmetered() {
        new_test_ext().execute_with(|| {
            System::set_block_number(10);
            prime(1, 100, 1_000);
            // A foreign call the runtime does NOT price (`MockForeignCost` returns `None` for anything but
            // `remark`) passes through untouched — same as microblog's own unmetered `force_set_capacity`.
            let unpriced =
                RuntimeCall::System(frame_system::Call::remark_with_event { remark: vec![] });
            let (_p, pre) = validate(1, &unpriced).expect("unpriced foreign call passes through");
            post_dispatch(pre, Ok(()));
            assert_eq!(
                Microblog::current_capacity(&1, 10),
                1_000,
                "nothing consumed for an unpriced call"
            );
        });
    }

    #[test]
    fn capacity_is_consumed_even_when_the_post_body_fails() {
        new_test_ext().execute_with(|| {
            System::set_block_number(10);
            prime(1, 100, 1_000);
            let (_p, pre) = validate(1, &post_call(b"hello".to_vec())).expect("valid");
            // A failed dispatch (e.g. a reply to a post that fails a body check) must STILL burn
            // capacity — else a doomed post is free spam. post_dispatch ignores the result by design.
            let failed: sp_runtime::DispatchResult = Err(crate::Error::<Test>::NotFound.into());
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
            let (priority, pre) =
                validate(1, &post_call(b"hello".to_vec())).expect("have == need is valid");
            // priority = have - need = 0 (the inequality is `have < need`, so equality passes). An
            // off-by-one (`have <= need`) would reject here, or an underflow would wrap to u64::MAX.
            assert_eq!(
                priority, 0,
                "exact-cost post has zero remaining-headroom priority"
            );
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
            let err = validate(1, &post_call(b"hello".to_vec()))
                .map(|_| ())
                .unwrap_err();
            assert_eq!(
                err,
                TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources)
            );
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
            TalkStake::apply_weight(&1, 0); // full unlock ⇒ ceiling 0
            assert!(
                Capacity::<Test>::get(1).is_some(),
                "row persists (relock-farm guard)"
            );

            // A post is now rejected at the pool with ExhaustsResources — NOT because the banked
            // cap_last is zero (it isn't), but because the stake-backed ceiling collapsed to 0.
            let err = validate(1, &post_call(b"hello".to_vec()))
                .map(|_| ())
                .unwrap_err();
            assert_eq!(
                err,
                TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources)
            );
        });
    }
}

// ── storage migration v0 → v1 (the project's first migration) ───────────────────────────────────
// Validates the `Post` re-encode deterministically: write OLD-encoded rows (no `quote`) directly
// under the Posts prefix, run the migration, and assert they decode as the new `Post` with
// `quote: None` and all other fields preserved — plus the VersionedMigration version-guard
// idempotency (a second run is a no-op).
mod migration_v1 {
    use super::*;
    use crate::migrations::v1::{MigrateV0ToV1, OldPost};
    use crate::Pallet;
    use codec::Encode;
    use frame_support::traits::{GetStorageVersion, OnRuntimeUpgrade, StorageVersion};

    /// Write an OLD (pre-quote) Post encoding directly under the `Posts` storage key for `id`.
    fn put_old_post(id: u64, author: u64, text: &[u8], parent: Option<u64>, at: u64) {
        let old = OldPost::<Test> {
            author,
            text: text.to_vec().try_into().expect("fits MaxLength"),
            parent,
            at,
        };
        let key = Posts::<Test>::hashed_key_for(id);
        sp_io::storage::set(&key, &old.encode());
    }

    #[test]
    fn v0_to_v1_translates_posts_and_is_idempotent() {
        new_test_ext().execute_with(|| {
            System::set_block_number(7);
            // On-chain storage version starts at 0 (nothing written) — the FROM the guard checks.
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(0)
            );

            put_old_post(0, 1, b"root", None, 5);
            put_old_post(1, 2, b"reply", Some(0), 6);

            // Run the real (version-guarded) migration. (Weight is mock-DbWeight-dependent — zero in
            // this test runtime — so we assert the OBSERVABLE effect: the rows are translated.)
            let _w = MigrateV0ToV1::<Test>::on_runtime_upgrade();

            // Storage version advanced to 1.
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(1)
            );

            // Both rows decode as the NEW Post with quote=None and all other fields preserved.
            let p0 = Posts::<Test>::get(0).expect("post 0 migrated");
            assert_eq!(
                (p0.author, p0.text.to_vec(), p0.parent, p0.at, p0.quote),
                (1, b"root".to_vec(), None, 5, None)
            );
            let p1 = Posts::<Test>::get(1).expect("post 1 migrated");
            assert_eq!(
                (p1.author, p1.parent, p1.at, p1.quote),
                (2, Some(0), 6, None)
            );

            // Idempotency: a second run is a no-op (the version guard skips the inner translate now
            // that the on-chain version is 1, not the FROM=0 it requires).
            let w2 = MigrateV0ToV1::<Test>::on_runtime_upgrade();
            // Only the cheap version read is charged; the rows are untouched.
            assert_eq!(Posts::<Test>::get(0).expect("still there").quote, None);
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(1)
            );
            let _ = w2;
        });
    }

    #[test]
    fn v0_to_v1_on_empty_posts_is_safe() {
        new_test_ext().execute_with(|| {
            // No posts: the migration still advances the version and translates zero rows.
            let _ = MigrateV0ToV1::<Test>::on_runtime_upgrade();
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(1)
            );
        });
    }
}

// ── storage migration v2 → v3 (backfill the reply aggregates) ────────────────────────────────────
// Validates the backfill: write Posts rows DIRECTLY (bypassing `post_message`, so the live reply
// maintenance never runs and ReplyCount/RepliesByParent start empty — the genuine pre-v3 state), pin
// the on-chain version at 2, run the migration, and assert the aggregates are reconstructed from each
// row's `parent`, the version advances to 3, and a second run is the version-guarded no-op.
mod migration_v3 {
    use super::*;
    use crate::migrations::v3::MigrateV2ToV3;
    use crate::{Pallet, Post};
    use frame_support::traits::{GetStorageVersion, OnRuntimeUpgrade, StorageVersion};

    /// Insert a Post row directly under the `Posts` prefix (bypassing `post_message`, so the reply
    /// aggregates stay EMPTY — exactly the pre-v3 on-chain state the migration must backfill).
    fn put_post(id: u64, author: u64, parent: Option<u64>) {
        let post = Post::<Test> {
            author,
            text: b"x".to_vec().try_into().expect("fits MaxLength"),
            parent,
            quote: None,
            at: 1,
        };
        Posts::<Test>::insert(id, post);
    }

    #[test]
    fn v2_to_v3_backfills_reply_aggregates_and_is_idempotent() {
        new_test_ext().execute_with(|| {
            // Pre-v3 state: posts exist (some are replies), aggregates empty, on-chain version is 2.
            StorageVersion::new(2).put::<Pallet<Test>>();
            put_post(0, 1, None); // root
            put_post(1, 2, Some(0)); // reply of 0
            put_post(2, 3, Some(0)); // reply of 0
            put_post(3, 4, Some(1)); // reply of 1
            put_post(4, 5, None); // another top-level

            // Nothing maintained the aggregates yet.
            assert_eq!(ReplyCount::<Test>::get(0), 0);
            assert_eq!(RepliesByParent::<Test>::iter().count(), 0);

            let _w = MigrateV2ToV3::<Test>::on_runtime_upgrade();

            // Version advanced and the aggregates are reconstructed from each row's parent.
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(3)
            );
            assert_eq!(ReplyCount::<Test>::get(0), 2);
            assert_eq!(ReplyCount::<Test>::get(1), 1);
            assert_eq!(ReplyCount::<Test>::get(4), 0);
            let mut c0: Vec<u64> = RepliesByParent::<Test>::iter_key_prefix(0).collect();
            c0.sort();
            assert_eq!(c0, vec![1, 2]);
            assert_eq!(RepliesByParent::<Test>::iter().count(), 3);

            // Idempotency: a second run is the version-guarded no-op — counts unchanged, NOT doubled.
            let _ = MigrateV2ToV3::<Test>::on_runtime_upgrade();
            assert_eq!(ReplyCount::<Test>::get(0), 2);
            assert_eq!(RepliesByParent::<Test>::iter().count(), 3);
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(3)
            );
        });
    }

    #[test]
    fn v2_to_v3_on_empty_posts_is_safe() {
        new_test_ext().execute_with(|| {
            StorageVersion::new(2).put::<Pallet<Test>>();
            let _ = MigrateV2ToV3::<Test>::on_runtime_upgrade();
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(3)
            );
            assert_eq!(RepliesByParent::<Test>::iter().count(), 0);
        });
    }
}

mod migration_v4 {
    use super::*;
    use crate::migrations::v4::MigrateV3ToV4;
    // ⚑ v4 runs at on-chain version 3, so it writes the per-author index in its ORIGINAL blob shape.
    // Assert against that alias, NOT against the current `TopLevelByAuthor` double map — the repage is
    // `MigrateV9ToV10`'s job, later in the same tuple.
    use crate::migrations::legacy::blob::TopLevelByAuthor as TopLevelByAuthorV9;
    use crate::{NextTopLevelSeq, Pallet, Post, TopLevelPosts};
    use frame_support::traits::{GetStorageVersion, OnRuntimeUpgrade, StorageVersion};

    /// Insert a Post row directly (bypassing the dispatch path, so the top-level index stays EMPTY —
    /// exactly the pre-v4 on-chain state the migration must backfill).
    fn put_post(id: u64, author: u64, parent: Option<u64>) {
        let post = Post::<Test> {
            author,
            text: b"x".to_vec().try_into().expect("fits MaxLength"),
            parent,
            quote: None,
            at: 1,
        };
        Posts::<Test>::insert(id, post);
    }

    #[test]
    fn v3_to_v4_backfills_index_in_id_order_and_is_idempotent() {
        new_test_ext().execute_with(|| {
            // Pre-v4 state: a mix of top-level + reply posts at NON-CONTIGUOUS ids, index empty,
            // on-chain version 3.
            StorageVersion::new(3).put::<Pallet<Test>>();
            put_post(10, 1, None); // top (author 1)
            put_post(11, 2, Some(10)); // reply — excluded
            put_post(20, 1, None); // top (author 1)
            put_post(21, 3, None); // top (author 3)
            put_post(22, 2, Some(20)); // reply — excluded

            assert_eq!(NextTopLevelSeq::<Test>::get(), 0);

            let _w = MigrateV3ToV4::<Test>::on_runtime_upgrade();

            // Version advanced; the spine is dense 0..3 mapping to the top-level ids in ASCENDING id
            // order (10, 20, 21) — the reply ids 11/22 are excluded.
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(4)
            );
            assert_eq!(NextTopLevelSeq::<Test>::get(), 3);
            assert_eq!(TopLevelPosts::<Test>::get(0), Some(10));
            assert_eq!(TopLevelPosts::<Test>::get(1), Some(20));
            assert_eq!(TopLevelPosts::<Test>::get(2), Some(21));
            assert_eq!(TopLevelPosts::<Test>::get(3), None);

            // Per-author lists exclude replies: author 1 [10, 20], author 3 [21], author 2 none.
            assert_eq!(TopLevelByAuthorV9::<Test>::get(1), vec![10, 20]);
            assert_eq!(TopLevelByAuthorV9::<Test>::get(3), vec![21]);
            assert!(TopLevelByAuthorV9::<Test>::get(2).is_empty());

            // Idempotency: a second run is the version-guarded no-op — NOT doubled.
            let _ = MigrateV3ToV4::<Test>::on_runtime_upgrade();
            assert_eq!(NextTopLevelSeq::<Test>::get(), 3);
            assert_eq!(TopLevelPosts::<Test>::iter().count(), 3);
            assert_eq!(TopLevelByAuthorV9::<Test>::get(1), vec![10, 20]);
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(4)
            );
        });
    }

    #[test]
    fn v3_to_v4_matches_the_live_incremental_path() {
        // The one-shot backfill must reproduce EXACTLY what the live `index_top_level` path builds.
        // Build a reference index by replaying the same posts through the dispatch path, then assert
        // the migration (from a raw `Posts` state) yields the identical spine + per-author lists.
        let live = new_test_ext().execute_with(|| {
            System::set_block_number(1);
            // ids 0, 1(reply), 2(quote), 3(poll): author 1 top-level x3, author 2 one reply.
            assert_ok!(Microblog::post_message(
                RuntimeOrigin::signed(1),
                b"a".to_vec(),
                None
            ));
            assert_ok!(Microblog::post_message(
                RuntimeOrigin::signed(2),
                b"r".to_vec(),
                Some(0)
            ));
            assert_ok!(Microblog::quote_post(
                RuntimeOrigin::signed(1),
                b"q".to_vec(),
                0
            ));
            assert_ok!(Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"p".to_vec(),
                vec![b"x".to_vec(), b"y".to_vec()],
                Some(50_000),
                PollKind::Stake,
                None
            ));
            let mut spine: Vec<(u64, u64)> = TopLevelPosts::<Test>::iter().collect();
            spine.sort();
            // The LIVE path writes the current double map; flatten it to per-author id lists in seq
            // order so it can be compared against the migration's blob output.
            let mut by_author: Vec<(u64, Vec<u64>)> = crate::TopLevelByAuthorCount::<Test>::iter()
                .map(|(a, n)| {
                    let ids = (0..n)
                        .map(|s| TopLevelByAuthor::<Test>::get(a, s).expect("dense 0..count"))
                        .collect::<Vec<u64>>();
                    (a, ids)
                })
                .collect();
            by_author.sort();
            (NextTopLevelSeq::<Test>::get(), spine, by_author)
        });

        new_test_ext().execute_with(|| {
            // The same posts as raw rows + pre-v4 version, then the one-shot backfill.
            StorageVersion::new(3).put::<Pallet<Test>>();
            put_post(0, 1, None);
            put_post(1, 2, Some(0));
            put_post(2, 1, None);
            put_post(3, 1, None);
            let _ = MigrateV3ToV4::<Test>::on_runtime_upgrade();

            let mut spine: Vec<(u64, u64)> = TopLevelPosts::<Test>::iter().collect();
            spine.sort();
            let mut by_author: Vec<(u64, Vec<u64>)> = TopLevelByAuthorV9::<Test>::iter().collect();
            by_author.sort();

            assert_eq!(NextTopLevelSeq::<Test>::get(), live.0);
            assert_eq!(
                spine, live.1,
                "backfilled spine must equal the live-path spine"
            );
            assert_eq!(
                by_author, live.2,
                "backfilled per-author lists must equal the live path"
            );
        });
    }

    #[test]
    fn v3_to_v4_on_empty_posts_is_safe() {
        new_test_ext().execute_with(|| {
            StorageVersion::new(3).put::<Pallet<Test>>();
            let _ = MigrateV3ToV4::<Test>::on_runtime_upgrade();
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(4)
            );
            assert_eq!(NextTopLevelSeq::<Test>::get(), 0);
            assert_eq!(TopLevelPosts::<Test>::iter().count(), 0);
        });
    }
}

mod migration_v5 {
    use super::*;
    use crate::migrations::v5::{retired, MigrateV4ToV5};
    use crate::{CapacityState, Pallet};
    use frame_support::traits::{GetStorageVersion, OnRuntimeUpgrade, StorageVersion};

    #[test]
    fn v4_to_v5_drops_repost_rows_and_settles_capacity_without_changing_it() {
        new_test_ext().execute_with(|| {
            System::set_block_number(100);
            StorageVersion::new(4).put::<Pallet<Test>>();

            // Pre-v5 state. The retired maps are NOT empty on the live chain — this migration deletes
            // real rows, so seed some.
            retired::Reposts::<Test>::insert(0u64, 9u64, ());
            retired::Reposts::<Test>::insert(6u64, 9u64, ());
            retired::RepostCount::<Test>::insert(0u64, 1u32);
            retired::RepostCount::<Test>::insert(6u64, 1u32);

            // Capacity rows with STALE `last_block`s — the pre-v5 norm, since only consume / on_revoke /
            // force_set_capacity ever restamped one.
            // acct 1: weight 100 (ceiling 1000), empty @90 ⇒ reads min(1000, 0 + 100·10) = 1000 (full).
            TalkStake::apply_weight(&1, 100);
            Capacity::<Test>::insert(
                1,
                CapacityState {
                    cap_last: 0,
                    last_block: 90,
                },
            );
            // acct 2: weight 10 (ceiling 100), 40 banked @95 ⇒ reads min(100, 40 + 10·5) = 90.
            TalkStake::apply_weight(&2, 10);
            Capacity::<Test>::insert(
                2,
                CapacityState {
                    cap_last: 40,
                    last_block: 95,
                },
            );
            // acct 3: UNLOCKED (weight 0) but still carrying a stale bank ⇒ reads min(0, …) = 0.
            Capacity::<Test>::insert(
                3,
                CapacityState {
                    cap_last: 500,
                    last_block: 50,
                },
            );

            let before: Vec<u128> = (1..=3)
                .map(|a| Microblog::current_capacity(&a, 100))
                .collect();
            assert_eq!(before, vec![1_000, 90, 0]);

            let _w = MigrateV4ToV5::<Test>::on_runtime_upgrade();

            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(5)
            );
            // (a) Both retired maps are fully drained — nothing orphaned under an undeclared prefix.
            assert_eq!(retired::Reposts::<Test>::iter().count(), 0);
            assert_eq!(retired::RepostCount::<Test>::iter().count(), 0);

            // (b) Settling is OBSERVABLY NEUTRAL: every account reads back exactly what it read before.
            let after: Vec<u128> = (1..=3)
                .map(|a| Microblog::current_capacity(&a, 100))
                .collect();
            assert_eq!(after, before, "settling must not change readable capacity");
            // It only MATERIALIZES that read into the row and restamps it, so no stale `last_block`
            // survives the upgrade — including acct 3, whose unreachable 500 bank is now really gone.
            for a in 1..=3u64 {
                let row = Capacity::<Test>::get(a).expect("row kept");
                assert_eq!(row.last_block, 100, "restamped to the upgrade block");
                assert_eq!(row.cap_last, before[(a - 1) as usize]);
            }
            // And regen continues from there at the live weight (acct 2: 90 + 10 = its ceiling).
            assert_eq!(Microblog::current_capacity(&2, 101), 100);
        });
    }

    #[test]
    fn v4_to_v5_is_version_guarded_so_a_re_run_cannot_re_settle() {
        new_test_ext().execute_with(|| {
            System::set_block_number(100);
            StorageVersion::new(4).put::<Pallet<Test>>();
            TalkStake::apply_weight(&1, 100);
            Capacity::<Test>::insert(
                1,
                CapacityState {
                    cap_last: 0,
                    last_block: 90,
                },
            );

            let _ = MigrateV4ToV5::<Test>::on_runtime_upgrade();
            let settled = Capacity::<Test>::get(1).expect("row");
            assert_eq!((settled.cap_last, settled.last_block), (1_000, 100));

            // A re-run 100 blocks later must be a TRUE no-op — the version guard, not the settle math,
            // is what makes that safe (a re-settle would restamp every row to the new block).
            System::set_block_number(200);
            let _ = MigrateV4ToV5::<Test>::on_runtime_upgrade();
            let again = Capacity::<Test>::get(1).expect("row");
            assert_eq!(
                (again.cap_last, again.last_block),
                (1_000, 100),
                "the version guard makes a re-run a no-op"
            );
        });
    }

    #[test]
    fn v4_to_v5_on_an_empty_chain_is_safe() {
        // The `--dev` / fresh-chain case: no repost rows, no capacity rows. Must still advance cleanly.
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            StorageVersion::new(4).put::<Pallet<Test>>();
            let _ = MigrateV4ToV5::<Test>::on_runtime_upgrade();
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(5)
            );
            assert_eq!(Capacity::<Test>::iter().count(), 0);
        });
    }
}

// Validates the v5 → v6 re-encode: write OLD-encoded (weight-bearing) vote / tally / poll rows directly
// under the live prefixes, run the migration, and assert they decode as the lighter v6 types with the
// DIRECTIONS / OPTIONS / COUNTS preserved, `Poll.close_at == None`, and the version-guard idempotency.
mod migration_v6 {
    use super::*;
    use crate::migrations::v6::{
        MigrateV5ToV6, OldOptionTally, OldPoll, OldPollVoteRecord, OldTally, OldVoteRecord,
    };
    use crate::{
        AccountVotes, OptionTally, Pallet, PollResults, PollVoteRecord, VoteCounts, VoteRecord,
    };
    use codec::Encode;
    use frame_support::traits::{GetStorageVersion, OnRuntimeUpgrade, StorageVersion};
    use frame_support::BoundedVec;

    fn put(key: Vec<u8>, bytes: Vec<u8>) {
        sp_io::storage::set(&key, &bytes);
    }

    #[test]
    fn v5_to_v6_drops_weight_keeps_counts_and_is_idempotent() {
        new_test_ext().execute_with(|| {
            System::set_block_number(3);
            // The guard fires only at on-chain version 5.
            StorageVersion::new(5).put::<Pallet<Test>>();

            // Old post-vote rows + tally (weights present).
            put(
                Votes::<Test>::hashed_key_for(0, 2),
                OldVoteRecord {
                    dir: VoteDir::Up,
                    weight: 100,
                }
                .encode(),
            );
            put(
                Votes::<Test>::hashed_key_for(0, 3),
                OldVoteRecord {
                    dir: VoteDir::Down,
                    weight: 50,
                }
                .encode(),
            );
            put(
                VoteTally::<Test>::hashed_key_for(0),
                OldTally {
                    up_weight: 100,
                    down_weight: 50,
                    up_count: 1,
                    down_count: 1,
                }
                .encode(),
            );
            // Old account-vote rows + tally.
            put(
                AccountVotes::<Test>::hashed_key_for(9, 2),
                OldVoteRecord {
                    dir: VoteDir::Up,
                    weight: 77,
                }
                .encode(),
            );
            put(
                AccountVoteTally::<Test>::hashed_key_for(9),
                OldTally {
                    up_weight: 77,
                    down_weight: 0,
                    up_count: 1,
                    down_count: 0,
                }
                .encode(),
            );
            // Old poll: choice + per-option tally + the poll itself (no close_at in v5).
            put(
                PollVotes::<Test>::hashed_key_for(0, 2),
                OldPollVoteRecord {
                    option: 1,
                    weight: 200,
                }
                .encode(),
            );
            put(
                PollTally::<Test>::hashed_key_for(0, 1),
                OldOptionTally {
                    weight: 200,
                    count: 1,
                }
                .encode(),
            );
            let mut options: BoundedVec<BoundedVec<u8, _>, _> = Default::default();
            options.try_push(b"a".to_vec().try_into().unwrap()).unwrap();
            options.try_push(b"b".to_vec().try_into().unwrap()).unwrap();
            put(
                Polls::<Test>::hashed_key_for(0),
                OldPoll::<Test> { options }.encode(),
            );

            let _w = MigrateV5ToV6::<Test>::on_runtime_upgrade();
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(6)
            );

            // Directions preserved; the stored records now carry ONLY the direction / option.
            assert_eq!(
                Votes::<Test>::get(0, 2),
                Some(VoteRecord { dir: VoteDir::Up })
            );
            assert_eq!(
                Votes::<Test>::get(0, 3),
                Some(VoteRecord { dir: VoteDir::Down })
            );
            assert_eq!(
                AccountVotes::<Test>::get(9, 2),
                Some(VoteRecord { dir: VoteDir::Up })
            );
            assert_eq!(
                PollVotes::<Test>::get(0, 2),
                Some(PollVoteRecord { option: 1 })
            );
            // Counts preserved byte-for-byte; weights gone from the value types.
            assert_eq!(
                VoteTally::<Test>::get(0),
                VoteCounts {
                    up_count: 1,
                    down_count: 1
                }
            );
            assert_eq!(
                AccountVoteTally::<Test>::get(9),
                VoteCounts {
                    up_count: 1,
                    down_count: 0
                }
            );
            assert_eq!(PollTally::<Test>::get(0, 1), OptionTally { count: 1 });
            // The poll re-encodes with the options preserved and a defaulted (floating) deadline.
            let poll = Polls::<Test>::get(0).expect("poll migrated");
            assert_eq!(poll.options.len(), 2);
            assert_eq!(poll.close_at, None);
            // No results are finalized by the migration.
            assert_eq!(PollResults::<Test>::iter().count(), 0);

            // Idempotency: a second run is a no-op (the guard skips now that on-chain version is 6).
            let _ = MigrateV5ToV6::<Test>::on_runtime_upgrade();
            assert_eq!(
                VoteTally::<Test>::get(0),
                VoteCounts {
                    up_count: 1,
                    down_count: 1
                }
            );
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(6)
            );
        });
    }
}

// Validates the v8 → v9 re-encode: write an OLD 3-field poll (options + close_at + kind, NO action) raw
// under the live `Polls` prefix, run the migration, and assert it decodes as the v9 `Poll` with the fields
// preserved and the appended `action == None`, plus the version-guard idempotency.
mod migration_v9 {
    use super::*;
    use crate::migrations::v9::{MigrateV8ToV9, OldPoll};
    use crate::{Pallet, Polls};
    use codec::Encode;
    use frame_support::traits::{GetStorageVersion, OnRuntimeUpgrade, StorageVersion};
    use frame_support::BoundedVec;

    #[test]
    fn v8_to_v9_appends_action_none_and_is_idempotent() {
        new_test_ext().execute_with(|| {
            System::set_block_number(3);
            // The guard fires only at on-chain version 8.
            StorageVersion::new(8).put::<Pallet<Test>>();

            // A v8 poll: options + close_at + kind, with NO `action` field.
            let mut options: BoundedVec<BoundedVec<u8, _>, _> = Default::default();
            options.try_push(b"a".to_vec().try_into().unwrap()).unwrap();
            options.try_push(b"b".to_vec().try_into().unwrap()).unwrap();
            sp_io::storage::set(
                &Polls::<Test>::hashed_key_for(0),
                &OldPoll::<Test> {
                    options,
                    close_at: Some(42),
                    kind: PollKind::Governance,
                }
                .encode(),
            );

            let _w = MigrateV8ToV9::<Test>::on_runtime_upgrade();
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(9)
            );

            // Re-decodes under the new type: options + close_at + kind preserved, `action` defaults to None.
            let poll = Polls::<Test>::get(0).expect("poll migrated");
            assert_eq!(poll.options.len(), 2);
            assert_eq!(poll.close_at, Some(42));
            assert_eq!(poll.kind, PollKind::Governance);
            assert_eq!(poll.action, None);

            // Idempotency: a second run is a no-op (the guard skips now that on-chain version is 9).
            let _ = MigrateV8ToV9::<Test>::on_runtime_upgrade();
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(9)
            );
            assert_eq!(Polls::<Test>::get(0).expect("poll").action, None);
        });
    }
}

mod migration_v10 {
    use super::*;
    use crate::migrations::legacy::blob::{
        ByAuthor as ByAuthorV9, TopLevelByAuthor as TopLevelByAuthorV9,
    };
    use crate::migrations::v10::MigrateV9ToV10;
    use crate::Pallet;
    use frame_support::traits::{GetStorageVersion, OnRuntimeUpgrade, StorageVersion};

    /// The test that the FIRST cut of this migration needed and did not have.
    ///
    /// v10 reads the old rows through a hand-rolled alias, and every other test in this module both
    /// WRITES and READS through that same alias — so if the alias addresses the wrong prefix they all
    /// still pass, in perfect agreement, against a prefix no real chain has ever written. That is
    /// exactly what happened: the alias was a `#[storage_alias]` named `ByAuthorV9`, the macro takes
    /// the storage item name from the TYPE name, and it silently addressed `ByAuthorV9`. The migration
    /// found zero rows on live preprod state, reported success, and orphaned all six authors' indexes.
    ///
    /// So anchor the alias to something it cannot be self-consistent with: the PALLET's own items,
    /// which are what the chain actually holds. Compare full storage prefixes (pallet ++ item hash),
    /// which is precisely the part the alias gets to choose.
    #[test]
    fn alias_prefixes_match_the_live_items() {
        new_test_ext().execute_with(|| {
            // 32 bytes: twox128(pallet) ++ twox128(item). Everything after is key hashing, which is
            // Blake2_128Concat on the first key for both shapes.
            let alias = ByAuthorV9::<Test>::hashed_key_for(1u64);
            let live = ByAuthor::<Test>::hashed_key_for(1u64, 0u64);
            assert_eq!(
                alias[..32],
                live[..32],
                "the v9 ByAuthor alias must address the SAME prefix the pallet's ByAuthor does"
            );
            // And the account key hashing agrees too, so the alias reads the real per-author rows —
            // the old key is exactly the new key minus the trailing seq.
            assert_eq!(alias[..], live[..alias.len()]);

            let alias = TopLevelByAuthorV9::<Test>::hashed_key_for(1u64);
            let live = TopLevelByAuthor::<Test>::hashed_key_for(1u64, 0u64);
            assert_eq!(
                alias[..32],
                live[..32],
                "the v9 TopLevelByAuthor alias must address the pallet's TopLevelByAuthor prefix"
            );
            assert_eq!(alias[..], live[..alias.len()]);
        });
    }

    #[test]
    fn v9_to_v10_repages_both_indexes_and_is_idempotent() {
        new_test_ext().execute_with(|| {
            StorageVersion::new(9).put::<Pallet<Test>>();
            // Pre-v10 state: the blob shape. Author 1 has three posts of which two are top-level;
            // author 2 has one reply only (so no top-level row at all); author 3 has an EMPTY blob,
            // which `ValueQuery` could leave behind and which must NOT become a counter row.
            ByAuthorV9::<Test>::insert(1, vec![10u64, 11, 12]);
            ByAuthorV9::<Test>::insert(2, vec![13u64]);
            ByAuthorV9::<Test>::insert(3, Vec::<u64>::new());
            TopLevelByAuthorV9::<Test>::insert(1, vec![10u64, 12]);

            let _w = MigrateV9ToV10::<Test>::on_runtime_upgrade();

            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(10)
            );
            // Ids preserved in order, seq dense from 0, counters exact.
            assert_eq!(ByAuthorCount::<Test>::get(1), 3);
            assert_eq!(
                (0..3)
                    .map(|s| ByAuthor::<Test>::get(1, s).unwrap())
                    .collect::<Vec<u64>>(),
                vec![10, 11, 12]
            );
            assert!(ByAuthor::<Test>::get(1, 3).is_none(), "dense 0..count");
            assert_eq!(ByAuthorCount::<Test>::get(2), 1);
            assert_eq!(ByAuthor::<Test>::get(2, 0), Some(13));
            assert_eq!(TopLevelByAuthorCount::<Test>::get(1), 2);
            assert_eq!(TopLevelByAuthor::<Test>::get(1, 0), Some(10));
            assert_eq!(TopLevelByAuthor::<Test>::get(1, 1), Some(12));
            // The empty blob leaves NO counter row: `who_to_follow` ranks over exactly the accounts
            // that have one, so a post-less author must not become a suggestion.
            assert_eq!(ByAuthorCount::<Test>::get(3), 0);
            assert!(!ByAuthorCount::<Test>::contains_key(3));
            // Author 2 posted only a reply, so it has no top-level row.
            assert!(!TopLevelByAuthorCount::<Test>::contains_key(2));

            // Total rows == total ids: nothing dropped, nothing duplicated, and — the reason the
            // remove-before-write order matters — no orphaned v9 row left under the shared prefix.
            assert_eq!(ByAuthor::<Test>::iter().count(), 4);
            assert_eq!(TopLevelByAuthor::<Test>::iter().count(), 2);

            // Idempotency: the version guard makes a second run a no-op, NOT a doubling.
            let _ = MigrateV9ToV10::<Test>::on_runtime_upgrade();
            assert_eq!(ByAuthorCount::<Test>::get(1), 3);
            assert_eq!(ByAuthor::<Test>::iter().count(), 4);
        });
    }

    #[test]
    fn v9_to_v10_output_matches_what_the_live_path_would_have_built() {
        // The repage must land on EXACTLY the state the live `index_by_author` / `index_top_level`
        // path builds — otherwise a migrated chain and a fresh one page differently.
        let live = new_test_ext().execute_with(|| {
            System::set_block_number(1);
            assert_ok!(Microblog::post_message(
                RuntimeOrigin::signed(1),
                b"a".to_vec(),
                None
            ));
            assert_ok!(Microblog::post_message(
                RuntimeOrigin::signed(1),
                b"r".to_vec(),
                Some(0)
            ));
            assert_ok!(Microblog::quote_post(
                RuntimeOrigin::signed(1),
                b"q".to_vec(),
                0
            ));
            let by: Vec<(u64, u64, u64)> = {
                let mut v: Vec<_> = ByAuthor::<Test>::iter().collect();
                v.sort();
                v
            };
            let top: Vec<(u64, u64, u64)> = {
                let mut v: Vec<_> = TopLevelByAuthor::<Test>::iter().collect();
                v.sort();
                v
            };
            (by, top, ByAuthorCount::<Test>::get(1))
        });

        new_test_ext().execute_with(|| {
            // The same three posts as pre-v10 blobs (ids 0,1,2; 1 is the reply).
            StorageVersion::new(9).put::<Pallet<Test>>();
            ByAuthorV9::<Test>::insert(1, vec![0u64, 1, 2]);
            TopLevelByAuthorV9::<Test>::insert(1, vec![0u64, 2]);
            let _ = MigrateV9ToV10::<Test>::on_runtime_upgrade();

            let mut by: Vec<(u64, u64, u64)> = ByAuthor::<Test>::iter().collect();
            by.sort();
            let mut top: Vec<(u64, u64, u64)> = TopLevelByAuthor::<Test>::iter().collect();
            top.sort();
            assert_eq!(
                by, live.0,
                "repaged ByAuthor must equal the live-path index"
            );
            assert_eq!(
                top, live.1,
                "repaged TopLevelByAuthor must equal the live path"
            );
            assert_eq!(ByAuthorCount::<Test>::get(1), live.2);
        });
    }

    #[test]
    fn v9_to_v10_rescales_every_capacity_bucket_into_the_new_units() {
        new_test_ext().execute_with(|| {
            StorageVersion::new(9).put::<Pallet<Test>>();
            // Spec 212 rescales the micro-capacity UNIT 60x (BaseCost 5e7 -> 3e9). `cap_last` is
            // stored in those units, so without this every live bucket would silently read as 1/60th
            // of what its holder banked, and they would be throttled for a full 5-hour refill.
            Capacity::<Test>::insert(
                1u64,
                crate::CapacityState {
                    cap_last: 5_000,
                    last_block: 7,
                },
            );
            Capacity::<Test>::insert(
                2u64,
                crate::CapacityState {
                    cap_last: 0,
                    last_block: 3,
                },
            );

            let _ = MigrateV9ToV10::<Test>::on_runtime_upgrade();

            let a = Capacity::<Test>::get(1).expect("bucket 1");
            assert_eq!(
                a.cap_last,
                5_000 * 60,
                "banked capacity scales with the unit"
            );
            assert_eq!(
                a.last_block, 7,
                "the stamp is a block number, NOT a capacity unit"
            );
            let b = Capacity::<Test>::get(2).expect("bucket 2");
            assert_eq!(b.cap_last, 0, "an empty bucket stays empty");
            assert_eq!(b.last_block, 3);
            assert_eq!(
                Capacity::<Test>::iter().count(),
                2,
                "no bucket added or dropped"
            );

            // Idempotent with the rest of the migration: the version guard means a second run does
            // NOT square the factor.
            let _ = MigrateV9ToV10::<Test>::on_runtime_upgrade();
            assert_eq!(
                Capacity::<Test>::get(1).expect("bucket 1").cap_last,
                5_000 * 60
            );
        });
    }

    #[test]
    fn v9_to_v10_on_empty_state_is_safe() {
        // The fresh-mainnet-genesis case: nothing to repage.
        new_test_ext().execute_with(|| {
            StorageVersion::new(9).put::<Pallet<Test>>();
            let _ = MigrateV9ToV10::<Test>::on_runtime_upgrade();
            assert_eq!(
                Pallet::<Test>::on_chain_storage_version(),
                StorageVersion::new(10)
            );
            assert_eq!(ByAuthor::<Test>::iter().count(), 0);
            assert_eq!(ByAuthorCount::<Test>::iter().count(), 0);
            assert_eq!(TopLevelByAuthor::<Test>::iter().count(), 0);
        });
    }
}

// ── Asymmetric-safety property test ─────────────────────────────────────────────────────────

/// **Clamp-latency ≤ grant-latency.** The weight writer's
/// failure modes are asymmetric: a slow GRANT is safe-but-stale, but a slow CLAMP leaves a
/// stale-positive weight — voice no longer backed by locked ADA — which is the dangerous one.
/// So a clamp (weight → 0 on unlock) must take effect no slower than a
/// grant. This falls out of the capacity math: a grant only raises the future ceiling and
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
            TalkStake::apply_weight(&who, weight);
            let cap = core::cmp::min(weight.saturating_mul(10), 5000);
            assert!(cap > 0);
            assert_eq!(
                Microblog::current_capacity(&who, t0),
                0,
                "a grant is never instantaneous"
            );
            let mut grant_latency = 0u64;
            while Microblog::current_capacity(&who, t0 + grant_latency) < cap {
                grant_latency += 1;
                assert!(grant_latency < 1_000_000, "bucket must fill in finite time");
            }
            assert!(
                grant_latency > 0,
                "grant takes > 0 blocks to fully take effect"
            );

            // ── CLAMP: fill the bucket, then unlock (weight → 0); capacity drops to 0 at once. ──
            let tf = t0 + grant_latency;
            assert_ok!(Microblog::force_set_capacity(
                RuntimeOrigin::root(),
                who,
                cap
            ));
            assert_eq!(Microblog::current_capacity(&who, tf), cap);
            TalkStake::apply_weight(&who, 0);
            let mut clamp_latency = 0u64;
            while Microblog::current_capacity(&who, tf + clamp_latency) > 0 {
                clamp_latency += 1;
                assert!(
                    clamp_latency < 1_000_000,
                    "bucket must clamp in finite time"
                );
            }
            assert_eq!(clamp_latency, 0, "clamp is instantaneous (same-block)");

            // The asymmetric-safety property: the dangerous direction is never the slower one.
            assert!(clamp_latency <= grant_latency);
        }
    });
}

// ── spec-120 node-served reads: the `MicroblogApi` read helpers (feed / author / following / thread) ──
//
// These exercise the pure pallet read helpers directly (AccountId = u64). Author-profile fields
// (`author_display_name`/`author_avatar`) are filled by the RUNTIME from pallet-profile, not the
// pallet, so they stay empty here — covered by the runtime/client parity path, not these units.
mod node_reads {
    use super::*;
    use crate::FeedPage;

    /// Seed a top-level post by `author`; returns the id it was assigned.
    fn post(author: u64, text: &[u8]) -> u64 {
        let id = NextPostId::<Test>::get();
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(author),
            text.to_vec(),
            None
        ));
        id
    }

    /// Seed a reply to `parent` by `author`; returns the id it was assigned.
    fn reply(author: u64, text: &[u8], parent: u64) -> u64 {
        let id = NextPostId::<Test>::get();
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(author),
            text.to_vec(),
            Some(parent)
        ));
        id
    }

    /// The post ids of a page, in returned order.
    fn ids(page: &FeedPage<u64>) -> Vec<u64> {
        page.posts.iter().map(|p| p.id).collect()
    }

    #[test]
    fn feed_page_is_top_level_newest_first_and_skips_replies() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            let p0 = post(1, b"root"); // 0 top-level
            let _r = reply(2, b"reply", p0); // 1 reply — skipped
            let p2 = post(1, b"second"); // 2 top-level
                                         // a quote is top-level (parent None) and DOES appear in the feed
            let p3 = NextPostId::<Test>::get();
            assert_ok!(Microblog::quote_post(
                RuntimeOrigin::signed(3),
                b"q".to_vec(),
                p0
            ));

            let page = Microblog::feed_page(None, 10, None);
            assert_eq!(ids(&page), vec![p3, p2, p0]);
            assert_eq!(page.next_cursor, None);

            let top = page.posts.iter().find(|p| p.id == p0).unwrap();
            assert_eq!(top.author, 1);
            assert_eq!(top.text, b"root".to_vec());
            assert_eq!(top.parent, None);
        });
    }

    #[test]
    fn feed_page_pages_by_cursor() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            for _ in 0..6 {
                post(1, b"x"); // ids 0..=5, all top-level
            }

            let p1 = Microblog::feed_page(None, 2, None);
            assert_eq!(ids(&p1), vec![5, 4]);
            let c1 = p1.next_cursor.expect("more to come");

            let p2 = Microblog::feed_page(Some(c1), 2, None);
            assert_eq!(ids(&p2), vec![3, 2]);
            let c2 = p2.next_cursor.expect("more to come");

            let p3 = Microblog::feed_page(Some(c2), 2, None);
            assert_eq!(ids(&p3), vec![1, 0]);
            assert_eq!(p3.next_cursor, None);
        });
    }

    #[test]
    fn feed_page_stamps_viewer_overlay() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            let p0 = post(1, b"root");
            // give voter 2 a non-zero voting power so the tally weight is observable, then Up-vote
            pallet_talk_stake::VotingPower::<Test>::insert(2u64, 500u128);
            assert_ok!(Microblog::vote(RuntimeOrigin::signed(2), p0, VoteDir::Up));

            // the voter sees their own vote; the tally weight is derived LIVE from current stake
            let seen = Microblog::feed_page(None, 10, Some(2));
            let mine = &seen.posts[0];
            assert_eq!(mine.my_vote, Some(VoteDir::Up));
            assert_eq!(mine.up_count, 1);
            assert_eq!(mine.up_weight, 500);
            // The two vestigial repost fields are still ON THE WIRE (the deployed frontend decodes them)
            // but are now always 0/false — reposting was retired in spec 204.
            assert_eq!(mine.repost_count, 0);
            assert!(!mine.reposted);

            // a different viewer has no overlay, but the aggregates are still present
            let other = Microblog::feed_page(None, 10, Some(3));
            assert_eq!(other.posts[0].my_vote, None);
            assert_eq!(other.posts[0].up_count, 1);

            // no viewer ⇒ no overlay
            let anon = Microblog::feed_page(None, 10, None);
            assert_eq!(anon.posts[0].my_vote, None);
        });
    }

    #[test]
    fn feed_page_enriches_aggregates_poll_and_quote() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            let p0 = post(1, b"root");
            // a quote of p0 by author 2
            let p1 = NextPostId::<Test>::get();
            assert_ok!(Microblog::quote_post(
                RuntimeOrigin::signed(2),
                b"quoting".to_vec(),
                p0
            ));
            // engagement on p0: one reply
            let _r = reply(4, b"re", p0);
            // a poll (top-level) by author 5
            let p3 = NextPostId::<Test>::get();
            assert_ok!(Microblog::create_poll(
                RuntimeOrigin::signed(5),
                b"poll?".to_vec(),
                vec![b"a".to_vec(), b"b".to_vec()],
                Some(50_000),
                PollKind::Stake,
                None
            ));

            let page = Microblog::feed_page(None, 10, None);
            assert_eq!(ids(&page), vec![p3, p1, p0]);

            let root = page.posts.iter().find(|p| p.id == p0).unwrap();
            assert_eq!(root.reply_count, 1);
            assert_eq!(root.repost_count, 0); // vestigial since spec 204 — always 0
            assert!(!root.is_poll);
            assert_eq!(root.quoted, None);

            // the quote carries a one-level resolved summary of its target
            let q = page.posts.iter().find(|p| p.id == p1).unwrap();
            assert_eq!(q.quote, Some(p0));
            let qs = q.quoted.as_ref().expect("quote resolved");
            assert_eq!(qs.id, p0);
            assert_eq!(qs.author, 1);
            assert_eq!(qs.text, b"root".to_vec());

            let poll = page.posts.iter().find(|p| p.id == p3).unwrap();
            assert!(poll.is_poll);
        });
    }

    #[test]
    fn author_feed_page_scopes_to_author_top_level() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            let a0 = post(1, b"a-root"); // 0 author 1 top
            let _b = post(2, b"b"); // 1 author 2 top
            let _ar = reply(1, b"a-reply", a0); // 2 author 1 reply — skipped
            let a3 = post(1, b"a-2"); // 3 author 1 top

            let page = Microblog::author_feed_page(1, None, 10, None);
            assert_eq!(ids(&page), vec![a3, a0]);
            assert_eq!(page.next_cursor, None);

            // author 2 sees only their own post
            let p2 = Microblog::author_feed_page(2, None, 10, None);
            assert_eq!(ids(&p2), vec![1]);
        });
    }

    #[test]
    fn following_feed_page_only_followees_top_level() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            // viewer 1 follows 2 and 3, not 4
            assert_ok!(Microblog::follow(RuntimeOrigin::signed(1), 2));
            assert_ok!(Microblog::follow(RuntimeOrigin::signed(1), 3));
            let f0 = post(2, b"by2"); // 0 followee
            let _f1 = post(4, b"by4"); // 1 not followed — skipped
            let f2 = post(3, b"by3"); // 2 followee
            let _f3 = reply(2, b"r", f0); // 3 reply by a followee — skipped (not top-level)

            let page = Microblog::following_feed_page(1, None, 10);
            assert_eq!(ids(&page), vec![f2, f0]);
            assert_eq!(page.next_cursor, None);
        });
    }

    #[test]
    fn thread_reconstructs_ancestors_and_replies() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            let root = post(1, b"root"); // 0
            let mid = reply(2, b"mid", root); // 1 (reply of 0)
            let focal = reply(3, b"focal", mid); // 2 (reply of 1)
            let r_a = reply(4, b"ra", focal); // 3 (reply of 2)
            let r_b = reply(5, b"rb", focal); // 4 (reply of 2)

            let t = Microblog::thread(focal, None);
            assert_eq!(t.focal.as_ref().map(|p| p.id), Some(focal));
            // ancestors are root-first
            assert_eq!(
                t.ancestors.iter().map(|p| p.id).collect::<Vec<_>>(),
                vec![root, mid]
            );
            // direct replies are chronological (ascending id)
            assert_eq!(
                t.replies.iter().map(|p| p.id).collect::<Vec<_>>(),
                vec![r_a, r_b]
            );

            // a root has no ancestors and one direct reply
            let troot = Microblog::thread(root, None);
            assert!(troot.ancestors.is_empty());
            assert_eq!(
                troot.replies.iter().map(|p| p.id).collect::<Vec<_>>(),
                vec![mid]
            );

            // a missing focal ⇒ everything empty
            let missing = Microblog::thread(999, None);
            assert!(missing.focal.is_none());
            assert!(missing.ancestors.is_empty());
            assert!(missing.replies.is_empty());
        });
    }

    #[test]
    fn feed_page_empty_and_limit_clamp() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            // empty chain
            let empty = Microblog::feed_page(None, 10, None);
            assert!(empty.posts.is_empty());
            assert_eq!(empty.next_cursor, None);

            // before_id == 0 ⇒ nothing strictly below
            post(1, b"x");
            let below0 = Microblog::feed_page(Some(0), 10, None);
            assert!(below0.posts.is_empty());
            assert_eq!(below0.next_cursor, None);

            // limit 0 clamps up to 1
            post(1, b"y");
            post(1, b"z");
            let clamped = Microblog::feed_page(None, 0, None);
            assert_eq!(clamped.posts.len(), 1);
        });
    }

    #[test]
    fn feed_page_reads_top_level_directly_past_replies() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            // Feature 3: feed_page pages the reply-free `TopLevelPosts` spine, so a top-level post is
            // returned DIRECTLY no matter how many replies sit between top-level posts in the id space.
            let p0 = post(1, b"root");
            for _ in 0..8 {
                reply(2, b"r", p0);
            }

            let page = Microblog::feed_page(None, 1, None);
            assert_eq!(ids(&page), vec![p0]);
            assert_eq!(page.next_cursor, None);
        });
    }

    #[test]
    fn top_level_index_excludes_replies_and_counts_per_author() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            let p0 = post(1, b"root"); // 0 top (author 1)
            let _r = reply(2, b"r", p0); // 1 reply (author 2) — NOT indexed
                                         // a quote and a poll (both author 1) are top-level
            let p2 = NextPostId::<Test>::get();
            assert_ok!(Microblog::quote_post(
                RuntimeOrigin::signed(1),
                b"q".to_vec(),
                p0
            ));
            let p3 = NextPostId::<Test>::get();
            assert_ok!(Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"poll?".to_vec(),
                vec![b"a".to_vec(), b"b".to_vec()],
                Some(50_000),
                PollKind::Stake,
                None
            ));

            // Three top-level posts (root + quote + poll); the reply is excluded from the spine.
            assert_eq!(NextTopLevelSeq::<Test>::get(), 3);
            assert_eq!(TopLevelPosts::<Test>::get(0), Some(p0));
            assert_eq!(TopLevelPosts::<Test>::get(1), Some(p2));
            assert_eq!(TopLevelPosts::<Test>::get(2), Some(p3));
            assert_eq!(TopLevelPosts::<Test>::get(3), None);

            // Per-author top-level index: author 1 has 3 (dense seq 0..3), author 2 has 0 (its only
            // post was a reply, so it never got a counter row at all).
            assert_eq!(TopLevelByAuthorCount::<Test>::get(1), 3);
            let ids: Vec<u64> = (0..3)
                .map(|s| TopLevelByAuthor::<Test>::get(1, s).expect("dense 0..count"))
                .collect();
            assert_eq!(ids, vec![p0, p2, p3]);
            assert_eq!(TopLevelByAuthorCount::<Test>::get(2), 0);
            assert!(TopLevelByAuthor::<Test>::get(2, 0).is_none());
        });
    }

    #[test]
    fn thread_ancestor_walk_breaks_on_a_cyclic_parent() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            // `parent` is unvalidated, so a post can target its own (about-to-be-assigned) id.
            let self_id = NextPostId::<Test>::get();
            assert_ok!(Microblog::post_message(
                RuntimeOrigin::signed(1),
                b"self".to_vec(),
                Some(self_id)
            ));

            // The cycle guard (visited-set seeded with the focal) stops the walk immediately — the
            // post does NOT recurse into its own ancestors (mirrors the client's getThread `seen` set).
            let t = Microblog::thread(self_id, None);
            assert_eq!(t.focal.as_ref().map(|p| p.id), Some(self_id));
            assert!(
                t.ancestors.is_empty(),
                "a self-parent must not recurse into ancestors"
            );
        });
    }

    #[test]
    fn following_feed_page_with_no_followees_short_circuits() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            // top-level posts exist, but viewer 1 follows nobody
            post(2, b"a");
            post(3, b"b");
            let page = Microblog::following_feed_page(1, None, 10);
            assert!(page.posts.is_empty());
            // no wasted scan + no misleading cursor: an empty follow set ends the feed cleanly
            assert_eq!(page.next_cursor, None);
        });
    }

    // ── The folded indexer reads (pallet-side helpers) ──

    #[test]
    fn author_replies_page_returns_only_replies_newest_first() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            let root = post(9, b"root"); // 0, by 9
            let _top = post(1, b"my top-level"); // 1, author 1 — top-level, NOT a reply
            let r1 = reply(1, b"reply one", root); // 2, author 1 reply
            let r2 = reply(1, b"reply two", root); // 3, author 1 reply

            // only author 1's replies, newest-first — the top-level post is excluded
            let page = Microblog::author_replies_page(1, None, 10, None);
            assert_eq!(ids(&page), vec![r2, r1]);
            assert_eq!(page.next_cursor, None);
            assert!(page.posts.iter().all(|p| p.parent.is_some()));

            // paging one at a time, cursor resumes correctly past the top-level post
            let p1 = Microblog::author_replies_page(1, None, 1, None);
            assert_eq!(ids(&p1), vec![r2]);
            let c = p1.next_cursor.expect("more to come");
            let p2 = Microblog::author_replies_page(1, Some(c), 1, None);
            assert_eq!(ids(&p2), vec![r1]);
            assert_eq!(p2.next_cursor, None);
        });
    }

    // Spec 212 bounded the two per-author readers. Before the repage a `before_id` cursor was resolved
    // by scanning a single in-memory blob, so skipping was free and the index was capped at 10_000
    // anyway. Keyed by seq, a skip is one trie read per entry over an index that now has NO cap — so a
    // deep page became O(index) and a full scroll quadratic, on a public unmetered runtime API. These
    // pin the two mechanisms that fix it.
    #[test]
    fn a_deep_author_page_resolves_its_cursor_by_binary_search() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            // 60 top-level posts by author 1, ids 0..60.
            let ids_all: Vec<u64> = (0..60u64)
                .map(|i| post(1, &[b'a' + (i % 26) as u8]))
                .collect();
            assert_eq!(TopLevelByAuthorCount::<Test>::get(1), 60);

            // A cursor deep in the index returns the right window, in the right order, regardless of
            // how far down it sits — the property the skip-based walk gave and the binary search must
            // preserve exactly.
            for &cursor in &[ids_all[59], ids_all[40], ids_all[10], ids_all[1]] {
                let page = Microblog::author_feed_page(1, Some(cursor), 5, None);
                let expected: Vec<u64> = ids_all
                    .iter()
                    .rev()
                    .filter(|&&id| id < cursor)
                    .take(5)
                    .copied()
                    .collect();
                assert_eq!(ids(&page), expected, "cursor {cursor}");
            }
            // The oldest post has nothing below it.
            let page = Microblog::author_feed_page(1, Some(ids_all[0]), 5, None);
            assert!(page.posts.is_empty());
            assert_eq!(page.next_cursor, None);
            // Walking the whole index page by page returns every post exactly once, in order.
            let mut seen = Vec::new();
            let mut cursor = None;
            loop {
                let page = Microblog::author_feed_page(1, cursor, 7, None);
                seen.extend(ids(&page));
                match page.next_cursor {
                    Some(c) if !page.posts.is_empty() => cursor = Some(c),
                    _ => break,
                }
            }
            let mut expected = ids_all.clone();
            expected.reverse();
            assert_eq!(
                seen, expected,
                "a full scroll loses nothing and repeats nothing"
            );
        });
    }

    #[test]
    fn author_replies_page_bounds_its_over_scan_and_hands_back_a_cursor() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            let root = post(9, b"root");
            // A long top-level run: author 1 posts 40 top-level posts and exactly one reply, the
            // OLDEST of their entries. Asking for replies must not walk all 41 entries in one call.
            let r = reply(1, b"the only reply", root);
            let _top: Vec<u64> = (0..40u64).map(|_| post(1, b"t")).collect();
            assert_eq!(ByAuthorCount::<Test>::get(1), 41);

            // limit 1 => max_scan = MAX_SCAN_FACTOR = 8 examined entries. The reply is 40 entries
            // down, so the first call cannot reach it: it returns nothing plus a cursor to continue.
            let p1 = Microblog::author_replies_page(1, None, 1, None);
            assert!(
                p1.posts.is_empty(),
                "the budget stopped the walk before the reply"
            );
            let c = p1
                .next_cursor
                .expect("a bounded stop must hand back a cursor");

            // Chasing that cursor makes progress and eventually reaches the reply — the client's
            // `chasePage` does exactly this loop.
            let mut cursor = Some(c);
            let mut found = Vec::new();
            for _ in 0..20 {
                let page = Microblog::author_replies_page(1, cursor, 1, None);
                found.extend(ids(&page));
                match page.next_cursor {
                    Some(next) => {
                        assert!(next < cursor.unwrap(), "the cursor must strictly decrease");
                        cursor = Some(next);
                    }
                    None => break,
                }
            }
            assert_eq!(found, vec![r], "the chase finds the reply and nothing else");

            // A generous limit raises the budget with it, so an ordinary page is unaffected.
            let big = Microblog::author_replies_page(1, None, 10, None);
            assert_eq!(
                ids(&big),
                vec![r],
                "limit 10 => 80 examined, enough to reach it"
            );
        });
    }

    #[test]
    fn likes_page_returns_upvoted_posts_and_reflects_clear() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            let a = post(1, b"a"); // 0
            let b = post(1, b"b"); // 1
            let c = post(1, b"c"); // 2
                                   // account 5 up-votes a + c, down-votes b (a down-vote is NOT a like)
            assert_ok!(Microblog::vote(RuntimeOrigin::signed(5), a, VoteDir::Up));
            assert_ok!(Microblog::vote(RuntimeOrigin::signed(5), b, VoteDir::Down));
            assert_ok!(Microblog::vote(RuntimeOrigin::signed(5), c, VoteDir::Up));

            // newest-liked-first (highest id first): c then a; b (down-vote) excluded
            let page = Microblog::likes_page(5, None, 10, None);
            assert_eq!(ids(&page), vec![c, a]);

            // clearing the up-vote on c drops it from the likes set
            assert_ok!(Microblog::clear_vote(RuntimeOrigin::signed(5), c));
            let page2 = Microblog::likes_page(5, None, 10, None);
            assert_eq!(ids(&page2), vec![a]);
        });
    }

    #[test]
    fn search_posts_matches_substring_case_insensitively_newest_first() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            let p0 = post(1, b"Hello Cardano world"); // 0
            let _p1 = post(2, b"nothing here"); // 1 — no match
            let p2 = post(3, b"cardano rocks"); // 2

            // ASCII-case-insensitive substring "cardano" hits p0 + p2, newest-first
            let page = Microblog::search_posts(b"CARDANO".to_vec(), None, 10, None);
            assert_eq!(ids(&page), vec![p2, p0]);
            assert_eq!(page.next_cursor, None);

            // a term matching nothing returns an empty page
            let empty = Microblog::search_posts(b"zzz".to_vec(), None, 10, None);
            assert!(empty.posts.is_empty());
            assert_eq!(empty.next_cursor, None);
        });
    }

    #[test]
    fn poll_returns_options_tally_and_total_voters() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            // a plain post is not a poll
            let plain = post(1, b"not a poll");
            assert!(Microblog::poll(plain).is_none());

            let host = NextPostId::<Test>::get();
            assert_ok!(Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"fav?".to_vec(),
                vec![b"red".to_vec(), b"blue".to_vec()],
                Some(50_000),
                PollKind::Stake,
                None
            ));
            pallet_talk_stake::VotingPower::<Test>::insert(2u64, 300u128);
            pallet_talk_stake::VotingPower::<Test>::insert(3u64, 200u128);
            assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(2), host, 0)); // red
            assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(3), host, 0)); // red

            let view = Microblog::poll(host).expect("is a poll");
            assert_eq!(view.host_id, host);
            assert_eq!(view.options.len(), 2);
            assert_eq!(view.options[0].index, 0);
            assert_eq!(view.options[0].label, b"red".to_vec());
            assert_eq!(view.options[0].weight, 500);
            assert_eq!(view.options[0].count, 2);
            assert_eq!(view.options[1].label, b"blue".to_vec());
            assert_eq!(view.options[1].count, 0);
            assert_eq!(view.total_votes, 2);

            // a re-cast moves voter 3 red→blue: total voters stays 2, weights follow live stake
            assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(3), host, 1));
            let view2 = Microblog::poll(host).unwrap();
            assert_eq!((view2.options[0].count, view2.options[0].weight), (1, 300));
            assert_eq!((view2.options[1].count, view2.options[1].weight), (1, 200));
            assert_eq!(view2.total_votes, 2);
        });
    }

    #[test]
    fn poll_choice_reflects_the_voters_current_option() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            let host = NextPostId::<Test>::get();
            assert_ok!(Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"q".to_vec(),
                vec![b"x".to_vec(), b"y".to_vec()],
                Some(50_000),
                PollKind::Stake,
                None
            ));
            assert_eq!(Microblog::poll_choice(2, host), None); // not voted yet
            assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(2), host, 1));
            assert_eq!(Microblog::poll_choice(2, host), Some(1));
        });
    }

    #[test]
    fn viewer_states_stamps_vote_per_id() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            let a = post(1, b"a"); // 0
            let b = post(1, b"b"); // 1
            let c = post(1, b"c"); // 2 — not voted
            pallet_talk_stake::VotingPower::<Test>::insert(7u64, 100u128);
            assert_ok!(Microblog::vote(RuntimeOrigin::signed(7), a, VoteDir::Up));
            assert_ok!(Microblog::vote(RuntimeOrigin::signed(7), b, VoteDir::Down));

            let st = Microblog::viewer_states(7, vec![a, b, c]);
            assert_eq!(st.len(), 3);
            assert_eq!((st[0].post_id, st[0].my_vote), (a, Some(VoteDir::Up)));
            assert_eq!(st[1].my_vote, Some(VoteDir::Down));
            assert_eq!(st[2].my_vote, None);
            // `reposted` is vestigial since spec 204: on the wire (the deployed frontend decodes it),
            // always false.
            assert!(st.iter().all(|s| !s.reposted));
        });
    }

    #[test]
    fn follow_edges_reports_exact_counts_and_edge_lists() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            // 1 follows 2 + 3; 4 follows 1
            assert_ok!(Microblog::follow(RuntimeOrigin::signed(1), 2));
            assert_ok!(Microblog::follow(RuntimeOrigin::signed(1), 3));
            assert_ok!(Microblog::follow(RuntimeOrigin::signed(4), 1));

            let e = Microblog::follow_edges(1);
            assert_eq!(e.following_count, 2);
            assert_eq!(e.follower_count, 1);
            let mut following = e.following.clone();
            following.sort();
            assert_eq!(following, vec![2, 3]);
            assert_eq!(e.followers, vec![4]);
        });
    }
}

/// Property-based protocol-invariant tests (spec 205+). Generator-driven, complementing the hand-rolled
/// table sweeps above. The headline check is the storage-consistency invariant that the new
/// `Pallet::try_state` hook enforces at upgrade time: every denormalized counter equals the records it
/// counts, and every reverse index mirrors its forward edge.
#[cfg(test)]
mod invariant_props {
    use crate::mock::*;
    use crate::{FollowerCount, Followers, PollKind, PollResults, VoteCounts, VoteDir, VoteTally};
    use frame_support::assert_ok;
    use proptest::prelude::*;

    /// One engagement action against a fixed cast of actors and seeded posts. The `u8` selectors are
    /// reduced modulo the small cardinalities in [`apply`], so every generated op is addressable.
    #[derive(Debug, Clone)]
    enum Op {
        Vote(u8, u8, bool),
        ClearVote(u8, u8),
        VoteAccount(u8, u8, bool),
        ClearAccountVote(u8, u8),
        Follow(u8, u8),
        Unfollow(u8, u8),
        PollVote(u8, u8),
        Reply(u8, u8),
    }

    fn any_op() -> impl Strategy<Value = Op> {
        (0u8..8, any::<u8>(), any::<u8>(), any::<bool>()).prop_map(|(kind, a, b, up)| match kind {
            0 => Op::Vote(a, b, up),
            1 => Op::ClearVote(a, b),
            2 => Op::VoteAccount(a, b, up),
            3 => Op::ClearAccountVote(a, b),
            4 => Op::Follow(a, b),
            5 => Op::Unfollow(a, b),
            6 => Op::PollVote(a, b),
            _ => Op::Reply(a, b),
        })
    }

    const ACTORS: [u64; 4] = [1, 2, 3, 4];
    /// Seeded post ids: `0` is the poll host, `1` and `2` are plain posts.
    const POSTS: [u64; 3] = [0, 1, 2];

    fn dir(up: bool) -> VoteDir {
        if up {
            VoteDir::Up
        } else {
            VoteDir::Down
        }
    }

    /// Every op's `Result` is intentionally IGNORED: an invalid op (self-vote, unfollow-when-not-
    /// following, a poll option out of range) rolls back and must leave the invariant intact — which is
    /// exactly what the caller then asserts. The generator deliberately produces such invalid ops.
    fn apply(op: &Op) {
        let origin = |i: u8| RuntimeOrigin::signed(ACTORS[(i as usize) % ACTORS.len()]);
        let acct = |i: u8| ACTORS[(i as usize) % ACTORS.len()];
        let post = |i: u8| POSTS[(i as usize) % POSTS.len()];
        match *op {
            Op::Vote(x, p, up) => {
                let _ = Microblog::vote(origin(x), post(p), dir(up));
            }
            Op::ClearVote(x, p) => {
                let _ = Microblog::clear_vote(origin(x), post(p));
            }
            Op::VoteAccount(x, t, up) => {
                let _ = Microblog::vote_account(origin(x), acct(t), dir(up));
            }
            Op::ClearAccountVote(x, t) => {
                let _ = Microblog::clear_account_vote(origin(x), acct(t));
            }
            Op::Follow(x, t) => {
                let _ = Microblog::follow(origin(x), acct(t));
            }
            Op::Unfollow(x, t) => {
                let _ = Microblog::unfollow(origin(x), acct(t));
            }
            Op::PollVote(x, o) => {
                let _ = Microblog::cast_poll_vote(origin(x), 0, o % 2);
            }
            Op::Reply(x, p) => {
                let _ = Microblog::post_message(origin(x), b"r".to_vec(), Some(post(p)));
            }
        }
    }

    fn seed() {
        System::set_block_number(1);
        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"poll?".to_vec(),
            vec![b"a".to_vec(), b"b".to_vec()],
            Some(50_000),
            PollKind::Stake,
            None
        ));
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"p1".to_vec(),
            None
        ));
        assert_ok!(Microblog::post_message(
            RuntimeOrigin::signed(1),
            b"p2".to_vec(),
            None
        ));
        // Give every actor voting power so the live weighted-tally join is exercised too (the invariant
        // under test is the COUNTS, which are independent of weight).
        for who in ACTORS {
            TalkStake::apply_voting_power(&who, 100);
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        /// After an ARBITRARY sequence of engagement actions (valid and invalid), every denormalized
        /// counter still equals the records it counts and every reverse index still mirrors its forward
        /// edge — the invariant `try_state` pins. The generator-based analogue of the hand-rolled
        /// `tally_count_fold_and_live_weight_property` sweep.
        #[test]
        fn tally_consistency_holds_under_arbitrary_engagement(
            ops in prop::collection::vec(any_op(), 0..30),
        ) {
            new_test_ext().execute_with(|| {
                seed();
                for op in &ops {
                    apply(op);
                    let res = Microblog::check_tally_consistency();
                    prop_assert!(res.is_ok(), "consistency broke after {:?}: {:?}", op, res);
                }
                Ok(())
            })?;
        }
    }

    #[test]
    fn check_tally_consistency_catches_a_vote_counter_drift() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            assert_ok!(Microblog::post_message(
                RuntimeOrigin::signed(1),
                b"root".to_vec(),
                None
            ));
            TalkStake::apply_voting_power(&2, 100);
            assert_ok!(Microblog::vote(RuntimeOrigin::signed(2), 0, VoteDir::Up));
            assert!(Microblog::check_tally_consistency().is_ok());
            // Inflate the counter with no matching record — exactly the drift the live zero-count
            // short-circuit would silently mis-read as zero weight.
            VoteTally::<Test>::insert(
                0,
                VoteCounts {
                    up_count: 99,
                    down_count: 0,
                },
            );
            assert!(Microblog::check_tally_consistency().is_err());
        });
    }

    #[test]
    fn check_tally_consistency_catches_a_follow_mirror_drift() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            assert_ok!(Microblog::follow(RuntimeOrigin::signed(1), 2));
            assert!(Microblog::check_tally_consistency().is_ok());
            // Drop the reverse mirror AND its follower-count together, so the counters stay internally
            // consistent (0 followers == FollowerCount 0) and it is the reverse-index *mirror* check —
            // not the count check — that must catch the now-unpaired forward edge Following[1][2].
            Followers::<Test>::remove(2, 1);
            FollowerCount::<Test>::insert(2, 0u32);
            assert!(Microblog::check_tally_consistency().is_err());
        });
    }

    #[test]
    fn poll_result_is_frozen_against_a_later_unstake() {
        new_test_ext().execute_with(|| {
            System::set_block_number(1);
            assert_ok!(Microblog::create_poll(
                RuntimeOrigin::signed(1),
                b"q".to_vec(),
                vec![b"a".to_vec(), b"b".to_vec()],
                Some(11),
                PollKind::Stake,
                None
            ));
            TalkStake::apply_voting_power(&2, 100);
            TalkStake::apply_voting_power(&3, 50);
            assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(2), 0, 0));
            assert_ok!(Microblog::cast_poll_vote(RuntimeOrigin::signed(3), 0, 1));
            System::set_block_number(11);
            assert_ok!(Microblog::close_poll(RuntimeOrigin::signed(1), 0));
            let frozen = PollResults::<Test>::get(0).expect("poll finalized");
            // The snapshot is index-aligned with the options, exact-counted, and weight-snapshotted.
            assert_eq!(frozen.option_weights.len(), 2);
            assert_eq!(frozen.option_counts.to_vec(), vec![1, 1]);
            assert_eq!(frozen.option_weights.to_vec(), vec![100, 50]);
            // The counts-consistency invariant must still hold once the poll is CLOSED — `close_poll`
            // writes `PollResults` but leaves `PollVotes`/`PollTally` intact, so the checker (and the
            // `try_state` hook it backs) must accept the coexistence. try_state runs against live chains
            // that WILL contain closed polls; the proptest's floating poll never reaches this state.
            assert!(Microblog::check_tally_consistency().is_ok());
            // A voter unstakes AFTER close: the finalized result must NOT re-price.
            TalkStake::apply_voting_power(&2, 0);
            let after = PollResults::<Test>::get(0).expect("still finalized");
            assert_eq!(after.option_weights.to_vec(), vec![100, 50]);
            // …and the invariant still holds after the unstake (weight moved, counts unchanged).
            assert!(Microblog::check_tally_consistency().is_ok());
        });
    }
}

#[test]
fn close_poll_refunds_every_rejected_path_to_the_base_weight() {
    // `close_poll`'s DECLARED weight reserves `6 × MaxObservedAccounts` reads for two observed-set
    // joins. FRAME charges the FULL declared weight for an `Err` unless the error carries a
    // `PostDispatchInfo` — so before this, every rejection billed the block a full worst-case slot for
    // work it never did. Not free (`metered_cost` prices `close_poll` at `VoteCost` and `CheckCapacity`
    // debits it whatever the dispatch returned), but mispriced: one vote's worth of battery bought
    // ~10% of a block's Normal weight, and `PollNotClosable` on a not-yet-due poll is repeatable by
    // anyone who can pay it, so the cheapest griefing vector on the chain was a loop over one open poll.
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        // What FRAME keys on is whether `actual_weight` is Some or None: `None` means "charge the full
        // declared weight", which is what every path below used to do. The mock's `WeightInfo = ()`
        // resolves to the GENERATED `impl WeightInfo for ()` in weights.rs, so `base` is the real
        // measured close_poll weight, not zero — what the mock does not model is the DECLARED total,
        // since its `MaxObservedAccounts` is 64 rather than the runtime's 1024.
        let base = <Test as crate::pallet::Config>::WeightInfo::close_poll();
        assert!(
            base.ref_time() > 0,
            "base must be the real measured weight, or Some(base) proves little",
        );

        assert_ok!(Microblog::create_poll(
            RuntimeOrigin::signed(1),
            b"q".to_vec(),
            opts(2),
            Some(50_000),
            PollKind::Stake,
            None
        ));

        // Not yet due — the repeatable one.
        let err = Microblog::close_poll(RuntimeOrigin::signed(2), 0).unwrap_err();
        assert_eq!(err.error, Error::<Test>::PollNotClosable.into());
        assert_eq!(
            err.post_info.actual_weight,
            Some(base),
            "a rejected close must not be charged for joins it never ran",
        );

        // Missing poll.
        let err = Microblog::close_poll(RuntimeOrigin::signed(2), 99).unwrap_err();
        assert_eq!(err.error, Error::<Test>::PollNotFound.into());
        assert_eq!(err.post_info.actual_weight, Some(base));

        // Unbound caller.
        deny_identity(404);
        let err = Microblog::close_poll(RuntimeOrigin::signed(404), 0).unwrap_err();
        assert_eq!(err.error, Error::<Test>::NotAllowed.into());
        assert_eq!(err.post_info.actual_weight, Some(base));
    });
}
