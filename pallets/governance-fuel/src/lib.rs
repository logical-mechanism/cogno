#![cfg_attr(not(feature = "std"), no_std)]

//! # governance-fuel pallet — sudo-free committee-administered REGENERATING admin budget (index 18)
//!
//! cogno-chain runs two independent token systems. Social posting/voting is feeless, metered by a
//! regenerating, Cardano-stake-weighted **talk-capacity** (pallet-microblog). Separately, the native
//! token (`pallet-balances`) pays the handful of fee-bearing **admin** extrinsics an operator ever
//! submits: a new validator's self-signed `Session::set_keys`, and committee
//! `propose`/`vote`/`close`. Transaction fees are **burned** (`FungibleAdapter<Balances, ()>`), so
//! without a mint path the native supply is finite and monotonically decreasing — governance would
//! eventually **brick itself** — and, because `vote`/`close` refund `Pays::No` only *post*-dispatch, a
//! member drained to zero cannot even vote to approve their own top-up (a self-refund deadlock).
//!
//! This pallet closes both gaps as the admin-side analogue of talk-capacity. The 3-of-5
//! [`Config::GrantOrigin`] sets a per-account **standing allowance** ([`Call::set_allowance`]); an
//! [`on_initialize`](Hooks::on_initialize) hook, on a [`Config::RegenPeriod`] cadence, mints each funded
//! account's balance back **up toward** its allowance. So fuel **regenerates** — a drained member
//! recovers next period (no deadlock) and the supply floats with mint-on-demand (never depletes). The
//! committee cuts a spammer off with [`Call::revoke`] (drop the allowance + claw back the balance).
//!
//! **Invariants that must hold.**
//! - **Fuel can never post.** Posting/voting eligibility flows from Cardano-observed stake weight →
//!   talk-stake → microblog capacity, gated by a cogno-gate identity binding — *none* of which reads
//!   `pallet-balances`. Granting fuel confers **zero** social power. A change that makes a social call
//!   fee-bearing would break this — don't.
//! - **Non-transferable.** The runtime base call filter (`CognoCallFilter`) blocks `Balances::transfer*`,
//!   so fuel is a pure committee-administered budget and [`Call::revoke`] is escape-proof (a rogue can't
//!   sweep balance to dodge a clawback). This pallet does not enforce that (it's a runtime concern) but
//!   its design assumes it.
//! - **Least privilege.** The only mint/burn authority is these two `GrantOrigin`-gated calls + the
//!   regeneration hook (bounded by the committee-set allowances). No other post-genesis mint path exists.

pub mod weights;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;
#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub use pallet::*;
pub use weights::*;

/// Log target for node-operator-visible diagnostics on the mint/regeneration edge paths.
pub const LOG_TARGET: &str = "runtime::governance-fuel";

#[frame_support::pallet]
pub mod pallet {
    use super::*;
    use frame_support::{
        pallet_prelude::*,
        traits::{
            fungible::{Inspect, Mutate},
            tokens::{Fortitude, Precision, Preservation},
        },
    };
    use frame_system::pallet_prelude::*;
    use sp_runtime::traits::{Saturating, Zero};

    /// The native balance type behind [`Config::Currency`].
    pub type BalanceOf<T> =
        <<T as Config>::Currency as Inspect<<T as frame_system::Config>::AccountId>>::Balance;

    #[pallet::pallet]
    pub struct Pallet<T>(_);

    #[pallet::config]
    pub trait Config: frame_system::Config {
        /// The overarching runtime event type.
        #[allow(deprecated)]
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;

        /// The ONLY origin allowed to set an allowance or revoke fuel. In cogno-chain this is the shared
        /// `AuthorityOrigin` — a ≥3/5 `FollowerCommittee` supermajority (sudo-free; no `EnsureRoot`
        /// fallback) — the same gate as `add_validator` / `set_members` / `authorize_upgrade`.
        type GrantOrigin: EnsureOrigin<Self::RuntimeOrigin>;

        /// The native fungible the committee mints into / burns from. Bound to `Balances` in the
        /// runtime. `Mutate` gives `mint_into` + `burn_from`; its `Inspect` supertrait gives
        /// `balance` / `total_balance` / `minimum_balance` / `reducible_balance`.
        type Currency: Mutate<Self::AccountId>;

        /// Per-account upper bound on a standing allowance. Bounds a single fat-fingered `set_allowance`
        /// and the per-`RegenPeriod` spend a funded account can sustain. Runtime-tunable. This is a
        /// PER-CALL cap only — there is deliberately NO cumulative cap on issuance (mint-on-demand, so
        /// governance never runs dry).
        #[pallet::constant]
        type MaxAllowance: Get<BalanceOf<Self>>;

        /// Max number of funded accounts (the length bound on [`Allowances`]). Bounds the regeneration
        /// loop's weight. Comfortably covers the validator set (`MaxValidators`) + committee
        /// (`FollowerMaxMembers`).
        #[pallet::constant]
        type MaxFundedAccounts: Get<u32>;

        /// Regeneration cadence in blocks. The hook mints funded accounts back toward their allowance
        /// only on blocks where `block_number % RegenPeriod == 0`, so only 1-in-`RegenPeriod` blocks pay
        /// the loop weight. MUST be non-zero (a zero period disables regeneration).
        #[pallet::constant]
        type RegenPeriod: Get<BlockNumberFor<Self>>;

        /// Dispatch + hook weights.
        type WeightInfo: WeightInfo;
    }

    /// The committee-set standing allowances — the source of truth for who regenerates and up to what
    /// ceiling. Bounded by [`Config::MaxFundedAccounts`] so the [`on_initialize`](Hooks::on_initialize)
    /// loop weight is provable (mirrors `pallet-validator-set`'s bounded `Validators`). An entry is
    /// added/updated by [`Call::set_allowance`] and removed by [`Call::revoke`].
    #[pallet::storage]
    pub type Allowances<T: Config> = StorageValue<
        _,
        BoundedVec<(T::AccountId, BalanceOf<T>), T::MaxFundedAccounts>,
        ValueQuery,
    >;

    /// Cumulative gross fuel minted (via `set_allowance` top-ups + regeneration). Audit counter — the
    /// first post-genesis mint path in a chain whose supply was otherwise monotone-decreasing, so a
    /// single queryable total beats replaying events.
    #[pallet::storage]
    pub type TotalMinted<T: Config> = StorageValue<_, BalanceOf<T>, ValueQuery>;

    /// Cumulative gross fuel clawed back (burned) via [`Call::revoke`]. Audit counter.
    #[pallet::storage]
    pub type TotalRevoked<T: Config> = StorageValue<_, BalanceOf<T>, ValueQuery>;

    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        /// A standing allowance was set (new fund, top-up, or ceiling change) by a
        /// [`Config::GrantOrigin`] (≥3/5 committee) motion. `minted` is the immediate top-up minted so
        /// the account is usable now (may be 0 if it was already at/above the new ceiling).
        AllowanceSet {
            who: T::AccountId,
            max: BalanceOf<T>,
            minted: BalanceOf<T>,
        },
        /// Fuel was revoked: the standing allowance was dropped (regeneration stops) and `burned` native
        /// tokens were clawed back — all *reducible* balance, which reaps the account unless it holds a
        /// provider/consumer reference (e.g. a validator with registered session keys keeps the
        /// existential deposit). Idempotent — `burned` is 0 for an already-drained / never-funded target.
        AllowanceRevoked {
            who: T::AccountId,
            burned: BalanceOf<T>,
        },
        /// The regeneration hook minted `minted` fuel this tick, topping up `accounts` funded accounts that
        /// were below their ceiling (accounts already at/above their ceiling are NOT counted). Only emitted
        /// when `minted > 0` (a quiet no-op tick emits nothing).
        FuelRegenerated {
            accounts: u32,
            minted: BalanceOf<T>,
        },
    }

    #[pallet::error]
    pub enum Error<T> {
        /// The requested allowance exceeds [`Config::MaxAllowance`].
        AllowanceExceedsMax,
        /// The requested allowance is below the existential deposit, so a fresh account could not be
        /// created. Set an allowance of at least the ED.
        AllowanceBelowExistentialDeposit,
        /// Adding a new funded account would exceed [`Config::MaxFundedAccounts`]. Revoke an existing
        /// allowance first, or raise the bound.
        TooManyFundedAccounts,
    }

    #[pallet::hooks]
    impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
        /// Regenerate fuel on the [`Config::RegenPeriod`] cadence: mint each funded account back up toward
        /// its standing allowance. This is what makes fuel a *regenerating* budget — a member drained to
        /// zero by admin fees recovers next tick, so there is no self-refund deadlock. Off-cadence blocks
        /// do only the modulus check.
        fn on_initialize(now: BlockNumberFor<T>) -> Weight {
            let period = T::RegenPeriod::get();
            // Guard the modulo against a zero period (would panic) — a zero period disables regeneration.
            if period.is_zero() || !(now % period).is_zero() {
                // Off-cadence: only a const `Get` read + a modulo — NO storage access. Charge nothing so
                // the ~9-in-10 non-cadence blocks don't each pay `regenerate(0)`'s phantom read+write.
                return Weight::zero();
            }
            let (accounts, _minted) = Self::do_regenerate();
            T::WeightInfo::regenerate(accounts)
        }
    }

    #[pallet::call]
    impl<T: Config> Pallet<T> {
        /// Set `who`'s standing fuel allowance to `max` — the committee's fund / top-up / regulate lever.
        /// Gated by [`Config::GrantOrigin`] (≥3/5 committee).
        ///
        /// Upserts the allowance (so `who` regenerates toward `max` each [`Config::RegenPeriod`]) and
        /// **immediately** mints `who` up to `max` so they are usable now, not only next period. `max`
        /// must be ≤ [`Config::MaxAllowance`] and ≥ the existential deposit. Use [`Call::revoke`] to stop
        /// regeneration and claw back.
        #[pallet::call_index(0)]
        #[pallet::weight(<T as Config>::WeightInfo::set_allowance())]
        pub fn set_allowance(
            origin: OriginFor<T>,
            who: T::AccountId,
            max: BalanceOf<T>,
        ) -> DispatchResult {
            T::GrantOrigin::ensure_origin(origin)?;
            ensure!(max <= T::MaxAllowance::get(), Error::<T>::AllowanceExceedsMax);
            ensure!(
                max >= T::Currency::minimum_balance(),
                Error::<T>::AllowanceBelowExistentialDeposit
            );

            // Upsert into the bounded allowance list (source of truth for regeneration). Reject a NEW
            // funded account past the bound; updating an existing one always fits.
            Allowances::<T>::try_mutate(|list| -> DispatchResult {
                if let Some(entry) = list.iter_mut().find(|(a, _)| a == &who) {
                    entry.1 = max;
                } else {
                    list.try_push((who.clone(), max))
                        .map_err(|_| Error::<T>::TooManyFundedAccounts)?;
                }
                Ok(())
            })?;

            // Immediate top-up toward the ceiling (mint only the shortfall; never burns here — a
            // downward ceiling change just lowers future regeneration, existing balance drains via fees).
            let bal = T::Currency::balance(&who);
            let minted = if bal < max {
                let shortfall = max.saturating_sub(bal);
                // `max >= ED` guaranteed above, so minting into a fresh account satisfies the ED floor.
                T::Currency::mint_into(&who, shortfall)?;
                TotalMinted::<T>::mutate(|t| *t = t.saturating_add(shortfall));
                shortfall
            } else {
                Zero::zero()
            };

            Self::deposit_event(Event::AllowanceSet { who, max, minted });
            Ok(())
        }

        /// Revoke `who`'s fuel — the committee's hard cut for a spamming / offboarded member. Gated by
        /// [`Config::GrantOrigin`] (≥3/5 committee).
        ///
        /// Drops the standing allowance (regeneration stops) and burns all *reducible* balance. For an
        /// account with no provider/consumer reference this reaps it (sub-ED dust burned, since
        /// `DustRemoval = ()`); for one that holds a reference — notably a validator with registered
        /// session keys (`set_keys` takes a consumer ref) — the existential deposit stays untouchable, so
        /// ~ED of non-regenerating fuel remains and the account is not reaped. Idempotent: revoking a
        /// never-funded / already-drained account succeeds with `burned = 0`. Because fuel is
        /// non-transferable the residual can't be swept, and it no longer regenerates; strip the role too
        /// with `ValidatorSet::remove_validator` / `FollowerCommittee::set_members` — a member removed from
        /// the committee can't propose/vote regardless of any remaining fuel.
        #[pallet::call_index(1)]
        #[pallet::weight(<T as Config>::WeightInfo::revoke())]
        pub fn revoke(origin: OriginFor<T>, who: T::AccountId) -> DispatchResult {
            T::GrantOrigin::ensure_origin(origin)?;

            // Stop regeneration: drop the allowance entry (if present).
            Allowances::<T>::mutate(|list| list.retain(|(a, _)| a != &who));

            // Claw back ALL reducible balance (Expendable → may reap below ED; Force → reaches frozen
            // funds; BestEffort → never errors on a shortfall). Report the true `total_balance` delta so
            // the event + `TotalRevoked` are audit-exact even when a sub-ED remainder is reaped.
            let before = T::Currency::total_balance(&who);
            let reducible =
                T::Currency::reducible_balance(&who, Preservation::Expendable, Fortitude::Force);
            let burned = if reducible.is_zero() {
                Zero::zero()
            } else {
                T::Currency::burn_from(
                    &who,
                    reducible,
                    Preservation::Expendable,
                    Precision::BestEffort,
                    Fortitude::Force,
                )?;
                let delta = before.saturating_sub(T::Currency::total_balance(&who));
                TotalRevoked::<T>::mutate(|t| *t = t.saturating_add(delta));
                delta
            };

            Self::deposit_event(Event::AllowanceRevoked { who, burned });
            Ok(())
        }
    }

    impl<T: Config> Pallet<T> {
        /// Mint every funded account back up toward its standing allowance. Returns
        /// `(accounts_scanned, total_minted)` — `accounts_scanned` (the full [`Allowances`] length) is what
        /// [`on_initialize`](Hooks::on_initialize) bills the weight against (every entry is read), while the
        /// [`Event::FuelRegenerated`] `accounts` field reports only those actually TOPPED UP. Factored out
        /// so the benchmark can drive it directly. A per-account `mint_into` failure is logged and skipped
        /// (never aborts the tick).
        ///
        /// Note: the top-up is sized from `balance()` (free), which is the balance that pays fees, so a
        /// member drained to zero is restored to a full `max` of *spendable* fuel. While the session
        /// `KeyDeposit` is 0 that equals `total_balance`; if a future testnet enables a held `KeyDeposit`,
        /// an account's total (free `max` + held deposit) will exceed `max` by the held amount — acceptable
        /// (held funds can't pay fees), but revisit if `max` is meant to bound total holdings.
        pub(crate) fn do_regenerate() -> (u32, BalanceOf<T>) {
            let list = Allowances::<T>::get();
            let scanned = list.len() as u32;
            let mut minted: BalanceOf<T> = Zero::zero();
            let mut refilled: u32 = 0;
            for (who, max) in list.iter() {
                let bal = T::Currency::balance(who);
                if bal < *max {
                    let shortfall = max.saturating_sub(bal);
                    match T::Currency::mint_into(who, shortfall) {
                        Ok(_) => {
                            minted = minted.saturating_add(shortfall);
                            refilled = refilled.saturating_add(1);
                        }
                        Err(e) => log::warn!(
                            target: LOG_TARGET,
                            "regenerate: mint_into failed for a funded account (shortfall skipped): {e:?}",
                        ),
                    }
                }
            }
            if !minted.is_zero() {
                TotalMinted::<T>::mutate(|t| *t = t.saturating_add(minted));
                Self::deposit_event(Event::FuelRegenerated { accounts: refilled, minted });
            }
            (scanned, minted)
        }
    }
}
