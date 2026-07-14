//! # Talk-stake pallet (cogno-chain)
//!
//! **The weight source for the regenerating talk-capacity meter.** It is a CALL-LESS ledger: it has no
//! extrinsics at all, and the only thing that writes it is the in-protocol `cardano-observer` inherent.
//! It stores two numbers per account — `AllowedStake` (the lovelace locked in that identity's largest
//! `talk_vault` UTxO, which backs its posting allowance) and `VotingPower` (the total Cardano stake of
//! its bound stake credential, which backs its vote weight).
//!
//! ## No extrinsic, no origin — the observer is the ONLY writer
//! In the all-Rust restart there is **no `set_stake` / `set_voting_power` call and no `SetStakeOrigin`**.
//! Weight enters the chain exclusively through the consensus-verified `cardano-observer` Mandatory
//! inherent, which every importing validator re-derives and rejects on mismatch — so the locked-ADA
//! weight is a consensus-verified OUTPUT, never a trusted oracle injection. The observer applies its own
//! `MaxStakeWeight`/`MaxVotingPower` skip-not-reject BEFORE calling the internal writers here, so a bad
//! value is filtered upstream and never reaches this pallet. A fresh chain with no Cardano (`--dev`/
//! `local`) seeds initial weight via [`GenesisConfig`] (genesis ≠ an extrinsic, so "no external setter"
//! holds).
//!
//! ## Invariants that live here (do not break them)
//! - `apply_weight` writes **only** `AllowedStake`, **never** the `Capacity` row (which lives in
//!   `pallet-microblog`). That separation *is* the going-forward-only rule: raising weight lifts the
//!   future `cap`/`rate` immediately, but the bigger bucket still fills over the window — it never
//!   retroactively credits banked capacity. See docs/ECONOMICS.md.
//! - On **full** unlock the observer writes `weight = 0`; weight is read live, so `cap = rate = 0` and the
//!   next capacity read collapses to `min(0, …) = 0`. The `Capacity` row is **never deleted** (that lives
//!   in microblog), so a relock cannot re-mint a fresh bucket.
//! - `AllowedStake` is `ValueQuery` → an unbound/unlocked account reads `0` for free.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

/// Log target for this pallet's operational diagnostics (off-chain node logs only — the on-chain audit
/// trail is the `StakeSet`/`VotingPowerSet` events; these logs add operator-visible context).
pub const LOG_TARGET: &str = "runtime::talk-stake";

/// The locked lovelace backing one identity's talk capacity — its largest `talk_vault` UTxO, never the
/// sum of them. `u128` (lovelace scale).
pub type StakeWeight = u128;

#[frame_support::pallet]
pub mod pallet {
    use super::*;
    use frame_support::pallet_prelude::*;

    #[pallet::pallet]
    pub struct Pallet<T>(_);

    #[pallet::config]
    pub trait Config: frame_system::Config {
        /// The overarching runtime event type.
        #[allow(deprecated)]
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
    }

    /// Per-account stake weight. `ValueQuery` → unbound/unlocked reads `0` (so `cap` and `rate` fall out
    /// to zero with no special-casing). Written only by `apply_weight` (the observer inherent's sink).
    #[pallet::storage]
    pub type AllowedStake<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, StakeWeight, ValueQuery>;

    /// Per-account VOTING POWER — the total Cardano stake of the account's bound stake credential
    /// (cogno-gate `StakeCredOf`), observed from `epoch_stake`. Distinct from [`AllowedStake`]: that (the
    /// locked-ADA deposit) meters POSTING capacity; this drives stake-weighted VOTES and POLLS in
    /// `pallet-microblog`. `ValueQuery` → an account with no stake bind / no stake reads `0` (its votes
    /// carry no weight). Written only by `apply_voting_power` (the observer inherent's sink).
    #[pallet::storage]
    pub type VotingPower<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, StakeWeight, ValueQuery>;

    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        /// An account's stake weight was set (idempotent overwrite; reorg-safe re-derive).
        StakeSet {
            who: T::AccountId,
            weight: StakeWeight,
        },
        /// An account's voting power (total observed Cardano stake) was set (idempotent overwrite).
        VotingPowerSet {
            who: T::AccountId,
            weight: StakeWeight,
        },
    }

    /// Genesis seed for chains with no Cardano to observe (`--dev` / `local`). EMPTY on preprod/mainnet —
    /// there the `cardano-observer` inherent credits real vault lovelace → `AllowedStake` and `epoch_stake`
    /// → `VotingPower` from block 0. `(account, allowed_stake, voting_power)` triples. Genesis is NOT an
    /// extrinsic, so this preserves the "the observer is the only runtime setter" invariant.
    #[pallet::genesis_config]
    #[derive(frame_support::DefaultNoBound)]
    pub struct GenesisConfig<T: Config> {
        pub initial_weights: alloc::vec::Vec<(T::AccountId, StakeWeight, StakeWeight)>,
    }

    #[pallet::genesis_build]
    impl<T: Config> BuildGenesisConfig for GenesisConfig<T> {
        fn build(&self) {
            for (who, allowed, voting) in &self.initial_weights {
                AllowedStake::<T>::insert(who, allowed);
                VotingPower::<T>::insert(who, voting);
            }
        }
    }

    impl<T: Config> Pallet<T> {
        /// Write `who`'s stake weight (insert `AllowedStake` + emit `StakeSet`). Writes **only**
        /// `AllowedStake` (the going-forward-only rule): the lazy capacity meter reads this live, so a raise
        /// lifts the future `cap`/`rate` and `weight = 0` collapses capacity on the next read — without
        /// touching the (relock-safe) capacity row in `pallet-microblog`.
        ///
        /// ⚠ **Do NOT call this directly.** It is `pub` only because the meter lives in another crate. The
        /// single legal caller is `pallet_microblog::Pallet::apply_observed_weight`, which SETTLES the
        /// capacity bucket at the OLD weight before this overwrites it (and skips the write entirely when
        /// the weight is unchanged). Reaching `apply_weight` around that helper changes the weight without
        /// settling, so the account's whole idle window is re-priced at the NEW weight on the next read —
        /// the retro-credit farm (a first-time locker gets a full battery; a relock springs the old bucket
        /// back). The observer inherent reaches it through the runtime's `WeightSink`, which delegates to
        /// that helper; it applies its OWN `MaxStakeWeight` skip-not-reject *before* calling, so a bad value
        /// is filtered out and never reaches here.
        pub fn apply_weight(who: &T::AccountId, weight: StakeWeight) {
            let previous = AllowedStake::<T>::get(who);
            AllowedStake::<T>::insert(who, weight);
            if weight == 0 {
                log::debug!(target: LOG_TARGET, "apply_weight: who={who:?} UNLOCKED (weight 0); previous={previous}");
            } else if weight == previous {
                log::debug!(target: LOG_TARGET, "apply_weight: who={who:?} weight={weight} unchanged (idempotent re-derive)");
            } else {
                log::debug!(target: LOG_TARGET, "apply_weight: who={who:?} weight {previous} -> {weight}");
            }
            Self::deposit_event(Event::StakeSet {
                who: who.clone(),
                weight,
            });
        }

        /// Write `who`'s voting power (insert `VotingPower` + emit `VotingPowerSet`). The sole entry point:
        /// the cardano-observer inherent calls it from its verified projection (after its own
        /// `MaxVotingPower` skip). Writes ONLY `VotingPower` — microblog reads it live for vote/poll weight,
        /// so a change lifts/drops future votes; existing recorded votes keep their stored snapshot.
        pub fn apply_voting_power(who: &T::AccountId, weight: StakeWeight) {
            let previous = VotingPower::<T>::get(who);
            VotingPower::<T>::insert(who, weight);
            if weight == previous {
                log::debug!(target: LOG_TARGET, "apply_voting_power: who={who:?} weight={weight} unchanged");
            } else {
                log::debug!(target: LOG_TARGET, "apply_voting_power: who={who:?} weight {previous} -> {weight}");
            }
            Self::deposit_event(Event::VotingPowerSet {
                who: who.clone(),
                weight,
            });
        }
    }
}
