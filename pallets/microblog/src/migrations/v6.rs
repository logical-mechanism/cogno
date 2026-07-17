//! Storage migration **v5 → v6** (spec 205): stop STORING a vote's weight.
//!
//! Dynamic stake voting drops every frozen weight snapshot from storage and derives the weighted score
//! LIVE at read time (joining the staker set against current `VotingPower`), so a vote re-prices as the
//! voter's stake moves. This migration re-encodes the affected rows to the lighter value types, keeping
//! the exact COUNTS unchanged, and defaults `Poll.close_at` to `None`. It is a pure, lossless re-encode —
//! NO re-derivation: counts are continuous across the upgrade; only the now-recomputed-live weighted
//! numbers change basis, which *is* the fix.
//!
//! What is translated (each drops its `weight` field, or gains `close_at`):
//!   - `Votes` / `AccountVotes`: `VoteRecord { dir, weight }` → `VoteRecord { dir }`
//!   - `PollVotes`: `PollVoteRecord { option, weight }` → `PollVoteRecord { option }`
//!   - `VoteTally` / `AccountVoteTally`: `Tally { up_weight, down_weight, up_count, down_count }`
//!     → `VoteCounts { up_count, down_count }`
//!   - `PollTally`: `OptionTally { weight, count }` → `OptionTally { count }`
//!   - `Polls`: `Poll { options }` → `Poll { options, close_at: None }`
//!   - `PollResults` is a NEW map, empty at genesis — no backfill.
//!
//! The translate is load-bearing, not cosmetic: `translate` re-encodes EVERY row unconditionally (it
//! decodes each as the `Old*` type and rewrites the lighter value), so no residual old-format row can
//! survive a completed run. Note the decode asymmetry it papers over: `Polls` genuinely can't decode
//! un-migrated (the appended `Option<BlockNumber>` needs a trailing byte that isn't there), and the tally
//! maps would MIS-decode (a leftover `u128` shifts the counts) — but the vote/poll RECORD maps
//! (`VoteRecord { dir }`, `PollVoteRecord { option }`) are strict byte-PREFIXES of their old encodings, so
//! SCALE would decode a stray old row silently (ignoring the trailing weight). That is why correctness
//! rests on `translate` visiting every row, not on a decode failure — and why `post_upgrade` verifies the
//! tally COUNTS by value (a mis-decode is caught) rather than relying on a row-count check alone.
//!
//! Wired into the runtime's `SingleBlockMigrations` and guarded by [`VersionedMigration`], so it runs
//! exactly once (when the on-chain storage version is 5) and self-skips on any re-run. The live base is
//! v5 (spec 204 already ran `MigrateV4ToV5`), so the wrapper is APPENDED to the tuple — `MigrateV4ToV5`
//! stays as the self-skipping guard for any node still at v4.

use crate::{
    AccountVoteTally, AccountVotes, Config, OptionTally, Pallet, Poll, PollTally, PollVoteRecord,
    PollVotes, Polls, VoteCounts, VoteDir, VoteRecord, VoteTally, Votes,
};
use frame_support::{
    migrations::VersionedMigration,
    pallet_prelude::*,
    traits::{Get, UncheckedOnRuntimeUpgrade},
    weights::Weight,
    BoundedVec,
};
use frame_system::pallet_prelude::BlockNumberFor;

// `Vec` + `ensure!` are only used by the try-runtime hooks below.
#[cfg(feature = "try-runtime")]
use alloc::vec::Vec;
#[cfg(feature = "try-runtime")]
use frame_support::ensure;

/// The **v5** on-chain encoding of a post / account vote record — `VoteRecord` PLUS the removed `weight`.
#[derive(Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
pub struct OldVoteRecord {
    pub dir: VoteDir,
    pub weight: u128,
}

/// The **v5** on-chain encoding of a vote tally — the four-field weighted `Tally`.
#[derive(Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, Default, TypeInfo, MaxEncodedLen)]
pub struct OldTally {
    pub up_weight: u128,
    pub down_weight: u128,
    pub up_count: u32,
    pub down_count: u32,
}

/// The **v5** on-chain encoding of a poll choice — `PollVoteRecord` PLUS the removed `weight`.
#[derive(Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
pub struct OldPollVoteRecord {
    pub option: u8,
    pub weight: u128,
}

/// The **v5** on-chain encoding of a per-option tally — `OptionTally` PLUS the removed `weight`.
#[derive(Encode, Decode, Clone, Copy, PartialEq, Eq, Debug, Default, TypeInfo, MaxEncodedLen)]
pub struct OldOptionTally {
    pub weight: u128,
    pub count: u32,
}

/// The **v5** on-chain encoding of a poll — `Poll` MINUS the appended `close_at`.
#[derive(
    Encode, Decode, CloneNoBound, PartialEqNoBound, EqNoBound, DebugNoBound, TypeInfo, MaxEncodedLen,
)]
#[scale_info(skip_type_params(T))]
pub struct OldPoll<T: Config> {
    pub options: BoundedVec<BoundedVec<u8, T::MaxPollOptionLen>, T::MaxPollOptions>,
}

/// The v5 tally maps re-declared with their OLD value types, so `pre_upgrade` can read the pre-migration
/// counts to prove they survive the re-encode. `#[storage_alias]` resolves the SAME prefix the live
/// `#[pallet::storage]` items use (pallet name + item name), so these reach the exact rows on chain. Do
/// not copy these anywhere else. try-runtime only.
#[cfg(feature = "try-runtime")]
pub(crate) mod old {
    use super::*;
    use frame_support::{storage_alias, Blake2_128Concat};

    #[storage_alias]
    pub type VoteTally<T: Config> =
        StorageMap<Pallet<T>, Blake2_128Concat, u64, OldTally, ValueQuery>;

    #[storage_alias]
    pub type AccountVoteTally<T: Config> = StorageMap<
        Pallet<T>,
        Blake2_128Concat,
        <T as frame_system::Config>::AccountId,
        OldTally,
        ValueQuery,
    >;

    #[storage_alias]
    pub type PollTally<T: Config> = StorageDoubleMap<
        Pallet<T>,
        Blake2_128Concat,
        u64,
        Blake2_128Concat,
        u8,
        OldOptionTally,
        ValueQuery,
    >;
}

/// The unchecked inner migration wrapped by [`MigrateV5ToV6`]. Register `MigrateV5ToV6` (the
/// version-guarded wrapper), never this directly, so it stays idempotent.
pub struct InnerMigrateV5ToV6<T: Config>(core::marker::PhantomData<T>);

impl<T: Config> UncheckedOnRuntimeUpgrade for InnerMigrateV5ToV6<T> {
    fn on_runtime_upgrade() -> Weight {
        let mut rows: u64 = 0;

        // Post votes: drop the stored weight, keep the direction.
        Votes::<T>::translate::<OldVoteRecord, _>(|_post, _who, old| {
            rows = rows.saturating_add(1);
            Some(VoteRecord { dir: old.dir })
        });
        // Account (reputation) votes: same.
        AccountVotes::<T>::translate::<OldVoteRecord, _>(|_target, _who, old| {
            rows = rows.saturating_add(1);
            Some(VoteRecord { dir: old.dir })
        });
        // Poll choices: drop the stored weight, keep the chosen option.
        PollVotes::<T>::translate::<OldPollVoteRecord, _>(|_poll, _who, old| {
            rows = rows.saturating_add(1);
            Some(PollVoteRecord { option: old.option })
        });
        // Post + account tallies: drop the two weight fields, keep the exact counts.
        VoteTally::<T>::translate::<OldTally, _>(|_post, old| {
            rows = rows.saturating_add(1);
            Some(VoteCounts {
                up_count: old.up_count,
                down_count: old.down_count,
            })
        });
        AccountVoteTally::<T>::translate::<OldTally, _>(|_target, old| {
            rows = rows.saturating_add(1);
            Some(VoteCounts {
                up_count: old.up_count,
                down_count: old.down_count,
            })
        });
        // Per-option poll tallies: drop the weight, keep the count.
        PollTally::<T>::translate::<OldOptionTally, _>(|_poll, _opt, old| {
            rows = rows.saturating_add(1);
            Some(OptionTally { count: old.count })
        });
        // Polls: append `close_at: None` (existing polls float forever, the backward-compatible default).
        Polls::<T>::translate::<OldPoll<T>, _>(|_id, old| {
            rows = rows.saturating_add(1);
            Some(Poll {
                options: old.options,
                close_at: None::<BlockNumberFor<T>>,
            })
        });

        log::info!(
            target: crate::LOG_TARGET,
            "migration v5->v6: re-encoded {rows} vote/tally/poll row(s) to drop stored weight (counts preserved, Poll.close_at = None)",
        );
        // 1 read + 1 write per re-encoded row.
        T::DbWeight::get().reads_writes(rows, rows)
    }

    #[cfg(feature = "try-runtime")]
    fn pre_upgrade() -> Result<Vec<u8>, sp_runtime::TryRuntimeError> {
        // Snapshot the exact COUNTS (never the weights — those are being dropped) so `post_upgrade` can
        // prove they survive byte-for-byte, plus the row cardinalities of the vote maps.
        let vote_tallies: Vec<(u64, (u32, u32))> = old::VoteTally::<T>::iter()
            .map(|(id, t)| (id, (t.up_count, t.down_count)))
            .collect();
        let account_tallies: Vec<(T::AccountId, (u32, u32))> = old::AccountVoteTally::<T>::iter()
            .map(|(who, t)| (who, (t.up_count, t.down_count)))
            .collect();
        let poll_tallies: Vec<((u64, u8), u32)> = old::PollTally::<T>::iter()
            .map(|(poll, opt, t)| ((poll, opt), t.count))
            .collect();
        // Row counts (via `iter_keys`, which decodes only keys — value-type-independent).
        let votes = Votes::<T>::iter_keys().count() as u64;
        let account_votes = AccountVotes::<T>::iter_keys().count() as u64;
        let poll_votes = PollVotes::<T>::iter_keys().count() as u64;
        let polls = Polls::<T>::iter_keys().count() as u64;

        log::info!(
            target: crate::LOG_TARGET,
            "migration v5->v6 pre: {} VoteTally, {} AccountVoteTally, {} PollTally rows; {votes} Votes, {account_votes} AccountVotes, {poll_votes} PollVotes, {polls} Polls",
            vote_tallies.len(), account_tallies.len(), poll_tallies.len(),
        );
        Ok((
            vote_tallies,
            account_tallies,
            poll_tallies,
            (votes, account_votes, poll_votes, polls),
        )
            .encode())
    }

    #[cfg(feature = "try-runtime")]
    fn post_upgrade(state: Vec<u8>) -> Result<(), sp_runtime::TryRuntimeError> {
        #[allow(clippy::type_complexity)]
        let (
            vote_tallies,
            account_tallies,
            poll_tallies,
            (votes, account_votes, poll_votes, polls),
        ): (
            Vec<(u64, (u32, u32))>,
            Vec<(T::AccountId, (u32, u32))>,
            Vec<((u64, u8), u32)>,
            (u64, u64, u64, u64),
        ) = Decode::decode(&mut &state[..]).map_err(|_| {
            sp_runtime::TryRuntimeError::Other("microblog v6: bad pre_upgrade state")
        })?;

        // Every vote-map row still DECODES under the new (lighter) type — i.e. no `weight` byte survived.
        // `iter().count()` fully decodes each value; comparing to `iter_keys().count()` catches any row
        // that failed to re-encode.
        ensure!(
            Votes::<T>::iter().count() as u64 == votes
                && Votes::<T>::iter_keys().count() as u64 == votes,
            "microblog v6: Votes row count changed / a row failed to decode"
        );
        ensure!(
            AccountVotes::<T>::iter().count() as u64 == account_votes
                && AccountVotes::<T>::iter_keys().count() as u64 == account_votes,
            "microblog v6: AccountVotes row count changed / a row failed to decode"
        );
        ensure!(
            PollVotes::<T>::iter().count() as u64 == poll_votes
                && PollVotes::<T>::iter_keys().count() as u64 == poll_votes,
            "microblog v6: PollVotes row count changed / a row failed to decode"
        );
        ensure!(
            Polls::<T>::iter().count() as u64 == polls,
            "microblog v6: Polls row count changed / a row failed to decode"
        );

        // Counts are byte-identical before/after (the weighted numbers changed basis, the counts did not).
        for (id, (up, down)) in &vote_tallies {
            let t = VoteTally::<T>::get(id);
            ensure!(
                t.up_count == *up && t.down_count == *down,
                "microblog v6: a VoteTally count changed during the re-encode"
            );
        }
        for (who, (up, down)) in &account_tallies {
            let t = AccountVoteTally::<T>::get(who);
            ensure!(
                t.up_count == *up && t.down_count == *down,
                "microblog v6: an AccountVoteTally count changed during the re-encode"
            );
        }
        for ((poll, opt), count) in &poll_tallies {
            let t = PollTally::<T>::get(poll, opt);
            ensure!(
                t.count == *count,
                "microblog v6: a PollTally count changed during the re-encode"
            );
        }

        // Every migrated poll defaults to a floating (never-closing) deadline; no result is finalized yet.
        ensure!(
            Polls::<T>::iter().all(|(_, p)| p.close_at.is_none()),
            "microblog v6: every migrated poll must default to close_at == None"
        );
        ensure!(
            crate::PollResults::<T>::iter_keys().next().is_none(),
            "microblog v6: PollResults must start empty"
        );
        Ok(())
    }
}

/// The public migration: gates [`InnerMigrateV5ToV6`] on `Pallet`'s storage version moving 5 → 6.
/// Idempotent — runs the inner migration only when the on-chain version is exactly 5, then writes 6.
pub type MigrateV5ToV6<T> = VersionedMigration<
    5,
    6,
    InnerMigrateV5ToV6<T>,
    Pallet<T>,
    <T as frame_system::Config>::DbWeight,
>;
