//! Benchmarking for `pallet-microblog`.
//!
//! Generates real `WeightInfo` for the **load-bearing feeless post path** — capacity is the only
//! anti-spam, so these weights back the block-weight backstop (`posts_per_block_max`).
//! `post_message` is length-parameterized over `0..MaxLength` (the linear
//! `s` component) and benchmarked end-to-end through the **real** runtime identity gate via the
//! [`IsAllowed::benchmark_set_allowed`] setup hook (the `whitelisted_caller` is otherwise unbound
//! and would be rejected `NotAllowed`). Capacity is consumed in `CheckCapacity::post_dispatch`,
//! not the call body, so the body benchmark needs no charged battery; the gate's two reads
//! (`AllowedStake`, `Capacity`) are measured separately via `current_capacity`/`consume` cost.

use super::*;
#[allow(unused)]
use crate::Pallet as Microblog;
use frame_benchmarking::v2::*;
use frame_support::{
    traits::{EnsureOrigin, Get},
    BoundedVec,
};
use frame_system::RawOrigin;

#[benchmarks]
mod benchmarks {
    use super::*;

    /// `post_message` of `s` text bytes (`0..=MaxLength`), through the real identity gate.
    #[benchmark]
    fn post_message(s: Linear<0, { T::MaxLength::get() }>) -> Result<(), BenchmarkError> {
        let caller: T::AccountId = whitelisted_caller();
        // Admit the caller through the REAL gate (CognoGate in the runtime; no-op in the mock).
        T::IdentityGate::benchmark_set_allowed(&caller);
        let text = alloc::vec![0u8; s as usize];

        #[extrinsic_call]
        _(RawOrigin::Signed(caller.clone()), text, None);

        assert_eq!(NextPostId::<T>::get(), 1);
        assert!(Posts::<T>::contains_key(0u64));
        Ok(())
    }

    /// Seed a single post (id 0) authored by `who`, so the engagement calls have a real target.
    fn seed_post<T: Config>(who: &T::AccountId) {
        let text: BoundedVec<u8, T::MaxLength> =
            alloc::vec![0u8; 1].try_into().expect("1 < MaxLength; qed");
        let at = frame_system::Pallet::<T>::block_number();
        Posts::<T>::insert(
            0u64,
            Post::<T> {
                author: who.clone(),
                text,
                parent: None,
                quote: None,
                at,
            },
        );
        ByAuthor::<T>::try_mutate(who, |ids| ids.try_push(0u64))
            .expect("empty index has room; qed");
        NextPostId::<T>::put(1u64);
    }

    /// `quote_post` of `s` text bytes referencing a seeded target post, through the real gate.
    #[benchmark]
    fn quote_post(s: Linear<0, { T::MaxLength::get() }>) -> Result<(), BenchmarkError> {
        let caller: T::AccountId = whitelisted_caller();
        T::IdentityGate::benchmark_set_allowed(&caller);
        seed_post::<T>(&caller); // the quoted target (id 0)
        let text = alloc::vec![0u8; s as usize];

        #[extrinsic_call]
        _(RawOrigin::Signed(caller.clone()), text, 0u64);

        // id 1 is the new quote post; id 0 was the seeded target.
        assert_eq!(NextPostId::<T>::get(), 2);
        assert_eq!(
            Posts::<T>::get(1u64).expect("quote exists").quote,
            Some(0u64)
        );
        Ok(())
    }

    /// `vote` — worst case is the RE-VOTE flip path (an existing count is decremented on one side, then
    /// incremented on the other). Weight is no longer stored (spec 205), so no stake seed is needed.
    #[benchmark]
    fn vote() -> Result<(), BenchmarkError> {
        let caller: T::AccountId = whitelisted_caller();
        T::IdentityGate::benchmark_set_allowed(&caller);
        seed_post::<T>(&caller);
        // Pre-existing Up vote (so `vote(Down)` exercises both the reverse and the apply branches).
        Votes::<T>::insert(0u64, &caller, VoteRecord { dir: VoteDir::Up });
        VoteTally::<T>::insert(
            0u64,
            VoteCounts {
                up_count: 1,
                down_count: 0,
            },
        );

        #[extrinsic_call]
        _(RawOrigin::Signed(caller.clone()), 0u64, VoteDir::Down);

        let t = VoteTally::<T>::get(0u64);
        assert_eq!(t.up_count, 0);
        assert_eq!(t.down_count, 1);
        Ok(())
    }

    /// `clear_vote` of an existing vote (seeded), decrementing its direction's count.
    #[benchmark]
    fn clear_vote() -> Result<(), BenchmarkError> {
        let caller: T::AccountId = whitelisted_caller();
        T::IdentityGate::benchmark_set_allowed(&caller);
        seed_post::<T>(&caller);
        Votes::<T>::insert(0u64, &caller, VoteRecord { dir: VoteDir::Up });
        VoteTally::<T>::insert(
            0u64,
            VoteCounts {
                up_count: 1,
                down_count: 0,
            },
        );

        #[extrinsic_call]
        _(RawOrigin::Signed(caller.clone()), 0u64);

        assert!(Votes::<T>::get(0u64, &caller).is_none());
        Ok(())
    }

    /// `vote_account` — worst case is the RE-VOTE flip path on an account target (an existing count is
    /// decremented on one side, then incremented on the other). Both caller AND target go through the real
    /// identity gate — the target gate is a load-bearing read (`vote_account` rejects an unbound target
    /// `TargetNotAllowed`).
    #[benchmark]
    fn vote_account() -> Result<(), BenchmarkError> {
        let caller: T::AccountId = whitelisted_caller();
        T::IdentityGate::benchmark_set_allowed(&caller);
        let target: T::AccountId = account("target", 0, 0);
        T::IdentityGate::benchmark_set_allowed(&target);
        // Pre-existing Up vote (so `vote_account(Down)` exercises both the reverse and apply branches).
        AccountVotes::<T>::insert(&target, &caller, VoteRecord { dir: VoteDir::Up });
        AccountVoteTally::<T>::insert(
            &target,
            VoteCounts {
                up_count: 1,
                down_count: 0,
            },
        );

        #[extrinsic_call]
        _(
            RawOrigin::Signed(caller.clone()),
            target.clone(),
            VoteDir::Down,
        );

        let t = AccountVoteTally::<T>::get(&target);
        assert_eq!(t.up_count, 0);
        assert_eq!(t.down_count, 1);
        Ok(())
    }

    /// `clear_account_vote` of an existing account vote (seeded), decrementing its direction's count from
    /// the target's tally. Only the caller is gated (clear does not re-check the target).
    #[benchmark]
    fn clear_account_vote() -> Result<(), BenchmarkError> {
        let caller: T::AccountId = whitelisted_caller();
        T::IdentityGate::benchmark_set_allowed(&caller);
        let target: T::AccountId = account("target", 0, 0);
        AccountVotes::<T>::insert(&target, &caller, VoteRecord { dir: VoteDir::Up });
        AccountVoteTally::<T>::insert(
            &target,
            VoteCounts {
                up_count: 1,
                down_count: 0,
            },
        );

        #[extrinsic_call]
        _(RawOrigin::Signed(caller.clone()), target.clone());

        assert!(AccountVotes::<T>::get(&target, &caller).is_none());
        Ok(())
    }

    /// `follow` a distinct target through the real gate.
    #[benchmark]
    fn follow() -> Result<(), BenchmarkError> {
        let caller: T::AccountId = whitelisted_caller();
        T::IdentityGate::benchmark_set_allowed(&caller);
        let target: T::AccountId = account("target", 0, 0);

        #[extrinsic_call]
        _(RawOrigin::Signed(caller.clone()), target.clone());

        assert!(Following::<T>::contains_key(&caller, &target));
        Ok(())
    }

    /// `unfollow` an existing follow edge (seeded).
    #[benchmark]
    fn unfollow() -> Result<(), BenchmarkError> {
        let caller: T::AccountId = whitelisted_caller();
        T::IdentityGate::benchmark_set_allowed(&caller);
        let target: T::AccountId = account("target", 0, 0);
        Following::<T>::insert(&caller, &target, ());
        FollowingCount::<T>::mutate(&caller, |c| *c = c.saturating_add(1));
        FollowerCount::<T>::mutate(&target, |c| *c = c.saturating_add(1));

        #[extrinsic_call]
        _(RawOrigin::Signed(caller.clone()), target.clone());

        assert!(!Following::<T>::contains_key(&caller, &target));
        Ok(())
    }

    /// `create_poll` of an `s`-byte question with the max number of options, through the real gate.
    #[benchmark]
    fn create_poll(s: Linear<0, { T::MaxLength::get() }>) -> Result<(), BenchmarkError> {
        let caller: T::AccountId = whitelisted_caller();
        T::IdentityGate::benchmark_set_allowed(&caller);
        let question = alloc::vec![0u8; s as usize];
        // Worst case: the maximum number of max-length options.
        let opt = alloc::vec![0u8; T::MaxPollOptionLen::get() as usize];
        let options = alloc::vec![opt; T::MaxPollOptions::get() as usize];

        #[extrinsic_call]
        _(
            RawOrigin::Signed(caller.clone()),
            question,
            options,
            None,
            crate::PollKind::Stake,
        );

        assert!(Polls::<T>::contains_key(0u64));
        Ok(())
    }

    /// `cast_poll_vote` — worst case is the RE-CAST path (an existing choice's count is decremented, then
    /// the new option's incremented).
    #[benchmark]
    fn cast_poll_vote() -> Result<(), BenchmarkError> {
        let caller: T::AccountId = whitelisted_caller();
        T::IdentityGate::benchmark_set_allowed(&caller);
        // Seed a 2-option poll at id 0.
        seed_post::<T>(&caller);
        let opt: BoundedVec<u8, T::MaxPollOptionLen> =
            alloc::vec![b'a'].try_into().expect("1 <= MaxPollOptionLen");
        let mut options: BoundedVec<BoundedVec<u8, T::MaxPollOptionLen>, T::MaxPollOptions> =
            Default::default();
        options.try_push(opt.clone()).expect("room");
        options.try_push(opt).expect("room");
        Polls::<T>::insert(
            0u64,
            Poll::<T> {
                options,
                close_at: None,
                kind: crate::PollKind::Stake,
            },
        );
        // Pre-existing choice (option 0) so the re-cast exercises the reverse + apply count branches.
        PollVotes::<T>::insert(0u64, &caller, PollVoteRecord { option: 0 });
        PollTally::<T>::insert(0u64, 0u8, OptionTally { count: 1 });

        #[extrinsic_call]
        _(RawOrigin::Signed(caller.clone()), 0u64, 1u8);

        assert_eq!(PollTally::<T>::get(0u64, 1u8).count, 1);
        Ok(())
    }

    /// `close_poll` — worst case finalizes a GOVERNANCE poll past its deadline: it joins the staker set
    /// against `VotingPower` + `PollVotes` to freeze the HOLDER weight AND (spec 208) runs the bounded
    /// role-holder join to freeze the SPO/dRep chambers. `PollKind::Governance` exercises that freeze
    /// branch; seed one staker + one poll vote so the holder join has a real row to sum (the runtime's
    /// role-holder set is empty here, so the chamber join measures its branch overhead). The block is
    /// advanced past `close_at` so the finalize path (not the `PollNotClosable` reject) is measured.
    #[benchmark]
    fn close_poll() -> Result<(), BenchmarkError> {
        let caller: T::AccountId = whitelisted_caller();
        T::IdentityGate::benchmark_set_allowed(&caller);
        seed_post::<T>(&caller);
        let opt: BoundedVec<u8, T::MaxPollOptionLen> =
            alloc::vec![b'a'].try_into().expect("1 <= MaxPollOptionLen");
        let mut options: BoundedVec<BoundedVec<u8, T::MaxPollOptionLen>, T::MaxPollOptions> =
            Default::default();
        options.try_push(opt.clone()).expect("room");
        options.try_push(opt).expect("room");
        // A poll whose deadline is block 0 — already reached, so `close_poll` finalizes. Governance so the
        // spec-208 chamber-freeze branch is exercised.
        Polls::<T>::insert(
            0u64,
            Poll::<T> {
                options,
                close_at: Some(0u32.into()),
                kind: crate::PollKind::Governance,
            },
        );
        // One staker with a live poll vote, so the weighted join sums a real row.
        pallet_talk_stake::VotingPower::<T>::insert(&caller, 1_000u128);
        PollVotes::<T>::insert(0u64, &caller, PollVoteRecord { option: 0 });
        PollTally::<T>::insert(0u64, 0u8, OptionTally { count: 1 });
        // Advance a block so `now >= close_at` holds under any block-number type.
        frame_system::Pallet::<T>::set_block_number(1u32.into());

        #[extrinsic_call]
        _(RawOrigin::Signed(caller.clone()), 0u64);

        assert!(crate::PollResults::<T>::contains_key(0u64));
        Ok(())
    }

    /// The `CheckCapacity` transaction-extension hot path: the reads
    /// `validate()` performs (`AllowedStake` + `Capacity`, via `current_capacity`) plus the
    /// `Capacity` write `consume()` performs in `post_dispatch`. Worst case: a bound, weighted,
    /// charged account (populated rows). This backs the extension's real `weight()`, so the
    /// feeless post path's FULL cost (call body + this gate) lands in the block-weight backstop.
    #[benchmark]
    fn check_capacity() {
        let who: T::AccountId = whitelisted_caller();
        pallet_talk_stake::AllowedStake::<T>::insert(&who, 1_000_000u128);
        let now = frame_system::Pallet::<T>::block_number();
        Capacity::<T>::insert(
            &who,
            CapacityState {
                cap_last: 1_000_000u128,
                last_block: now,
            },
        );
        let cost = Microblog::<T>::post_cost(T::MaxLength::get());

        #[block]
        {
            // Exactly what validate() reads then what post_dispatch() consumes.
            let _ = Microblog::<T>::current_capacity(&who, now);
            Microblog::<T>::consume(&who, now, cost);
        }

        assert!(Capacity::<T>::get(&who).is_some());
    }

    /// `force_set_capacity` (gated by `ForceOrigin`); exercises `on_first_bind` + the row write.
    #[benchmark]
    fn force_set_capacity() -> Result<(), BenchmarkError> {
        let who: T::AccountId = whitelisted_caller();
        let origin =
            T::ForceOrigin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?;

        #[extrinsic_call]
        _(origin as T::RuntimeOrigin, who.clone(), 1_000_000u128);

        assert!(Capacity::<T>::contains_key(&who));
        Ok(())
    }

    impl_benchmark_test_suite!(Microblog, crate::mock::new_test_ext(), crate::mock::Test);
}
