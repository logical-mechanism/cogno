//! Benchmarking for `pallet-microblog` (DR-05).
//!
//! Generates real `WeightInfo` for the **load-bearing feeless post path** — capacity is the only
//! anti-spam, so these weights back the block-weight backstop (`posts_per_block_max`,
//! `L3-chain.md` §5.4). `post_message` is length-parameterized over `0..MaxLength` (the linear
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
		Posts::<T>::insert(0u64, Post::<T> { author: who.clone(), text, parent: None, quote: None, at });
		ByAuthor::<T>::try_mutate(who, |ids| ids.try_push(0u64)).expect("empty index has room; qed");
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
		assert_eq!(Posts::<T>::get(1u64).expect("quote exists").quote, Some(0u64));
		Ok(())
	}

	/// `vote` — worst case is the RE-VOTE flip path (an existing record is reversed, then the new
	/// direction applied), with a non-zero stake so the weight snapshot is real.
	#[benchmark]
	fn vote() -> Result<(), BenchmarkError> {
		let caller: T::AccountId = whitelisted_caller();
		T::IdentityGate::benchmark_set_allowed(&caller);
		seed_post::<T>(&caller);
		pallet_talk_stake::AllowedStake::<T>::insert(&caller, 2_000u128);
		// Pre-existing Up vote (so `vote(Down)` exercises both the reverse and the apply branches).
		Votes::<T>::insert(0u64, &caller, VoteRecord { dir: VoteDir::Up, weight: 1_000u128 });
		VoteTally::<T>::insert(
			0u64,
			Tally { up_weight: 1_000, down_weight: 0, up_count: 1, down_count: 0 },
		);

		#[extrinsic_call]
		_(RawOrigin::Signed(caller.clone()), 0u64, VoteDir::Down);

		let t = VoteTally::<T>::get(0u64);
		assert_eq!(t.up_count, 0);
		assert_eq!(t.down_count, 1);
		Ok(())
	}

	/// `clear_vote` of an existing vote (seeded), reversing its stored weight from the tally.
	#[benchmark]
	fn clear_vote() -> Result<(), BenchmarkError> {
		let caller: T::AccountId = whitelisted_caller();
		T::IdentityGate::benchmark_set_allowed(&caller);
		seed_post::<T>(&caller);
		Votes::<T>::insert(0u64, &caller, VoteRecord { dir: VoteDir::Up, weight: 1_000u128 });
		VoteTally::<T>::insert(
			0u64,
			Tally { up_weight: 1_000, down_weight: 0, up_count: 1, down_count: 0 },
		);

		#[extrinsic_call]
		_(RawOrigin::Signed(caller.clone()), 0u64);

		assert!(Votes::<T>::get(0u64, &caller).is_none());
		Ok(())
	}

	/// `repost` of a seeded post (the permanent amplification edge).
	#[benchmark]
	fn repost() -> Result<(), BenchmarkError> {
		let caller: T::AccountId = whitelisted_caller();
		T::IdentityGate::benchmark_set_allowed(&caller);
		seed_post::<T>(&caller);

		#[extrinsic_call]
		_(RawOrigin::Signed(caller.clone()), 0u64);

		assert_eq!(RepostCount::<T>::get(0u64), 1);
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
		_(RawOrigin::Signed(caller.clone()), question, options);

		assert!(Polls::<T>::contains_key(0u64));
		Ok(())
	}

	/// `cast_poll_vote` — worst case is the RE-CAST path (an existing choice is reversed, then the new
	/// option applied) with a non-zero stake.
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
		Polls::<T>::insert(0u64, Poll::<T> { options });
		pallet_talk_stake::AllowedStake::<T>::insert(&caller, 2_000u128);
		// Pre-existing choice (option 0) so the re-cast exercises reverse + apply.
		PollVotes::<T>::insert(0u64, &caller, PollVoteRecord { option: 0, weight: 1_000u128 });
		PollTally::<T>::insert(0u64, 0u8, OptionTally { weight: 1_000, count: 1 });

		#[extrinsic_call]
		_(RawOrigin::Signed(caller.clone()), 0u64, 1u8);

		assert_eq!(PollTally::<T>::get(0u64, 1u8).count, 1);
		Ok(())
	}

	/// The `CheckCapacity` transaction-extension hot path (DR-05 / `L3-chain.md` §5.4): the reads
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
			CapacityState { cap_last: 1_000_000u128, last_block: now },
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
