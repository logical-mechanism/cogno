//! # Cardano-observer pallet (cogno-chain) — in-protocol deterministic observation (D4 weight rung)
//!
//! **Sets `talk-stake` weight from a consensus-verified Substrate INHERENT** carrying the
//! deterministically-observed Cardano `talk_vault` state, replacing the trusted off-chain
//! `talk_stake.set_stake` write. Every importing validator independently re-derives the same Cardano
//! read and rejects the block on mismatch, so the locked-ADA weight becomes a consensus-verified
//! OUTPUT rather than a trusted oracle injection. Aura+GRANDPA are unchanged. Full design +
//! determinism contract: `docs/IN-PROTOCOL-OBSERVATION.md`.
//!
//! ## What is inherent data vs on-chain logic (§4.1)
//! The ONLY thing carried as inherent data is the raw observed `(beacon, lovelace)` set as-of a stable
//! reference slot (the node-side `InherentDataProvider` does that IO, byte-identically across nodes
//! via the shared logic mirrored from `services/_shared/observation.mjs`). Everything else is
//! deterministic on-chain logic that lives here: the `beacon → account` lookup
//! ([`Config::BeaconResolver`] = cogno-gate `AccountOf` in the runtime), the MIN_LOCK floor, the
//! `MaxStakeWeight` bound, weight application + capacity priming ([`Config::WeightSink`] = a
//! talk-stake + microblog adapter), and the unlock clamp.
//!
//! ## The two enforcement layers (§6)
//! - [`ProvideInherent::check_inherent`] does the CROSS-NODE read match only: the importer compares the
//!   author's observation against its OWN node's read at the same reference. A difference is
//!   [`InherentError::Mismatch`] (**fatal** → block rejected); the importer's source being behind is
//!   [`InherentError::CannotVerify`] (**non-fatal** → accept without verifying — never fork on a slow
//!   node). `check_inherent` is NOT run by every node (warp/state sync skip it; it is not re-run in
//!   `execute_block`), so anything that must hold for EVERY node is enforced in the Mandatory
//!   dispatchable below, which DOES run in `execute_block`.
//! - The `observe` dispatchable is `DispatchClass::Mandatory` and `is_inherent`-only (pool-inadmissible,
//!   the §5.2 mutual-exclusion invariant). It enforces, on every node: reference monotonicity, the
//!   stability sanity bound, the `MaxStakeWeight` skip-not-reject, account resolution, weight + capacity
//!   application, and the unlock clamp.
//!
//! ## Honest posture (§2/§11)
//! `check_inherent`'s "every producer re-derives" is load-bearing only with MULTIPLE independent block
//! producers — on a single-operator stack this is **D4-SHAPED, not D4-TRUST** (it buys consensus-pinned
//! auditability, not trust). Cutting `set_stake` over to inherent-only is co-sequenced with ≥3
//! independent producers; until then this pallet runs in shadow — the runtime wiring + node IDP are
//! LIVE, but `EnforceWeight` defaults to `false`, so the inherent only PROJECTS weight (it records
//! `ShadowStake` without writing `talk_stake`'s `AllowedStake`). The cutover is the `set_enforcement` flip.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub mod weights;
pub use weights::*;

use codec::{Decode, DecodeWithMemTracking, Encode, MaxEncodedLen};
use scale_info::TypeInfo;
use sp_inherents::{InherentIdentifier, IsFatalError};

/// Off-chain node logs only (the on-chain audit trail is the `ObservationApplied` event).
pub const LOG_TARGET: &str = "runtime::cardano-observer";

/// The 8-byte inherent identifier under which the node-side `InherentDataProvider` supplies the
/// observed Cardano vault state.
pub const INHERENT_IDENTIFIER: InherentIdentifier = *b"cgnoobsv";

/// A 32-byte beacon name == the L1 beacon `token_name` == the cogno-gate `AccountOf` key
/// (= `blake2b_256(plutus_data_cbor(owner Address))`; derived off-chain at bind, never re-derived here).
pub type BeaconName = [u8; 32];

/// The stable Cardano reference the observation was taken as-of (carried in the inherent). The `slot`
/// is a deterministic function of the PARENT block (so author + importer agree; §5.1) and IS the
/// consensus anchor. `block_hash` carries the node's Kupo checkpoint-tip header hash — a node-LOCAL
/// diagnostic that legitimately varies by Kupo config / sync position, so [`ProvideInherent::check_inherent`]
/// compares only `slot` + `entries`, never `block_hash` (including it would spuriously fork two honest
/// nodes that agree on the stable read). The node-side point-existence guard (a Kupo that is BEHIND the
/// reference abstains rather than returning a partial set) lives in the IDP, not here.
#[derive(
	Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen, Default,
)]
pub struct CardanoRef {
	pub slot: u64,
	pub block_hash: [u8; 32],
}

/// The observation supplied as inherent DATA by the node (transport form: an unbounded `Vec`; the
/// runtime `Call` bounds it to [`Config::MaxObserved`]). Entries are canonical-sorted ascending by the
/// 32 beacon bytes — the SAME canonical order `services/_shared/observation.mjs` produces.
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct CardanoObservation {
	pub reference: CardanoRef,
	pub entries: alloc::vec::Vec<(BeaconName, u128)>,
}

/// The inherent error. The node-side `try_handle_error` branches on this: `Mismatch` is propagated
/// (`Some(Err(_))` → block rejected); `CannotVerify` is swallowed (`Some(Ok(()))` → accept without
/// verifying). A blanket-swallow would defeat the entire fork-protection (§6).
#[derive(Encode, Decode, Debug)]
pub enum InherentError {
	/// The author's observation does not match the importer's own read at the same reference. FATAL.
	Mismatch,
	/// The importer's own Cardano data source is behind the reference / unavailable. NON-FATAL.
	CannotVerify,
}

impl IsFatalError for InherentError {
	fn is_fatal_error(&self) -> bool {
		match self {
			InherentError::Mismatch => true,
			InherentError::CannotVerify => false,
		}
	}
}

/// Resolve a 32-byte beacon to its bound posting account. Implemented by cogno-gate (`AccountOf`) in
/// the runtime; a fixture map in tests. Keeps this pallet decoupled from cogno-gate (no Cargo cycle).
pub trait BeaconResolver<AccountId> {
	fn resolve(beacon: &BeaconName) -> Option<AccountId>;
}

/// Apply an observed weight to an account: set talk-stake weight + prime/clamp the microblog capacity
/// row, via their existing internal entry points (preserving the going-forward-only / unlock→0 /
/// never-delete-the-row invariants, `ECONOMICS.md` §6.1). `weight == 0` is the unlock clamp. Implemented
/// by a talk-stake + microblog adapter in the runtime; a recorder in tests.
pub trait WeightSink<AccountId> {
	fn set_weight(who: &AccountId, weight: u128);
}

/// The consensus-pinned observation config the node-side `InherentDataProvider` reads via the
/// [`CardanoObserverApi`] runtime API — the SINGLE source of truth, so the node and the runtime cannot
/// drift on the anchors, the stability window, or which Cardano policy to observe (design "no-drift").
#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct ObserverConfig {
	pub shelley_start_unix: u64,
	pub shelley_start_slot: u64,
	pub stability_slots: u64,
	/// The 28-byte Cardano policy id (== the `talk_vault` script hash, `contracts/vault.json`) the node
	/// queries Kupo for. Consensus-pinned so a misconfigured node can't silently observe the wrong policy.
	pub vault_policy_id: alloc::vec::Vec<u8>,
}

sp_api::decl_runtime_apis! {
	/// Exposes the consensus-pinned [`ObserverConfig`] to the node-side observation InherentDataProvider.
	pub trait CardanoObserverApi {
		/// The current observation config (anchors, stability window, vault policy id).
		fn observer_config() -> ObserverConfig;
	}
}

#[frame_support::pallet]
pub mod pallet {
	use super::*;
	use frame_support::{
		inherent::{InherentData, ProvideInherent},
		pallet_prelude::*,
		traits::UnixTime,
	};
	use frame_system::{ensure_none, pallet_prelude::*};

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		/// The overarching runtime event type.
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>>
			+ IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// Max identities observed in one block (bounds the inherent + `LastObserved`).
		#[pallet::constant]
		type MaxObserved: Get<u32>;
		/// Hard ceiling on a single account's weight (`stake-1`). An entry above it is SKIPPED (not a
		/// block error) — a bad inherent value must never be consensus-pinned nor brick the Mandatory
		/// block. (Contrast `talk_stake::set_stake`, which rejects the whole call.)
		#[pallet::constant]
		type MaxStakeWeight: Get<u128>;
		/// The L1 `min_lock` floor (lovelace): below it, observed lovelace maps to weight 0.
		#[pallet::constant]
		type MinLock: Get<u128>;
		/// The stability window in Cardano slots (the reference must be at least this far behind the
		/// block's own time — a defence-in-depth sanity bound; the node IDP enforces the real read).
		#[pallet::constant]
		type StabilitySlots: Get<u64>;
		/// Per-network Shelley anchor (NOT Byron `systemStart`) for the stability sanity bound.
		#[pallet::constant]
		type ShelleyStartUnix: Get<u64>;
		#[pallet::constant]
		type ShelleyStartSlot: Get<u64>;
		/// The 28-byte Cardano policy id (== `talk_vault` script hash) to observe. Consensus-pinned and
		/// surfaced to the node via [`CardanoObserverApi`] so every node queries the SAME policy.
		#[pallet::constant]
		type VaultPolicyId: Get<[u8; 28]>;
		/// Beacon → bound account (cogno-gate `AccountOf` in the runtime).
		type BeaconResolver: BeaconResolver<Self::AccountId>;
		/// Apply weight + capacity (talk-stake + microblog adapter in the runtime).
		type WeightSink: WeightSink<Self::AccountId>;
		/// Origin allowed to flip the enforce/shadow flag ([`Call::set_enforcement`]) — the crown-jewel
		/// cutover control. In the runtime this is `AuthorityOrigin` (root OR the 3-of-5 FollowerCommittee),
		/// the same origin that gates `set_stake`/`link_identity`/`anchor_ack`.
		type EnforceOrigin: EnsureOrigin<Self::RuntimeOrigin>;
		/// The block's consensus time (`pallet_timestamp` implements `UnixTime`).
		type UnixTime: UnixTime;
		/// Dispatch weights.
		type WeightInfo: WeightInfo;
	}

	/// The last accepted Cardano reference — the monotonicity anchor (§5.6). `None` before the first
	/// observation.
	#[pallet::storage]
	pub type LastReference<T: Config> = StorageValue<_, CardanoRef, OptionQuery>;

	/// The previously-credited `(beacon, account)` set — required to compute the unlock-clamp set
	/// (`LastObserved \ current`); a bare digest could not yield "which identities dropped out" (§4.2).
	#[pallet::storage]
	pub type LastObserved<T: Config> =
		StorageValue<_, BoundedVec<(BeaconName, T::AccountId), T::MaxObserved>, ValueQuery>;

	/// Whether the verified observation's weight is APPLIED to talk-stake/microblog (**enforce** mode)
	/// or only projected into [`ShadowStake`] for side-by-side validation (**shadow** mode, the DEFAULT,
	/// `false`). Flipped by [`Call::set_enforcement`] (gated by [`Config::EnforceOrigin`]). In shadow the
	/// inherent still verifies the read ([`ProvideInherent::check_inherent`] is flag-INDEPENDENT) and
	/// records the projection, but does **not** write `AllowedStake`/capacity — so the committee
	/// `set_stake` path remains the sole weight writer and the two can be diffed. The cutover (enforce =
	/// sole writer) is gated on ≥3 independent producers ("D4-SHAPED, not D4-TRUST", §2/§9) and is **not**
	/// a pure flag flip for weight already on-chain: the committee-credited keyset must be reconciled to
	/// the inherent's view first (see `docs/IN-PROTOCOL-OBSERVATION.md` §9 cutover note).
	#[pallet::storage]
	pub type EnforceWeight<T: Config> = StorageValue<_, bool, ValueQuery>;

	/// The inherent's per-account PROJECTED weight, written EVERY block in BOTH modes — the
	/// consensus-pinned shadow artifact. Mirrors talk-stake `AllowedStake`'s shape + semantics
	/// (account-keyed, insert-0-on-unlock, never delete the row) so the off-chain shadow-diff can compare
	/// `ShadowStake(account)` (what the inherent WOULD/DOES apply) against `AllowedStake(account)` (what
	/// the committee actually wrote) apples-to-apples. In enforce mode it equals `AllowedStake` by
	/// construction; in shadow mode their (eventual) agreement is the validation signal (§9).
	#[pallet::storage]
	pub type ShadowStake<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, u128, ValueQuery>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A verified observation was processed as-of `reference_slot`: `credited` identities had a
		/// projected weight recorded, `cleared` had it zeroed (unlock clamp), `skipped` were observed but
		/// dropped for exceeding `MaxStakeWeight` (§7 step 3). `enforced` is the mode: `true` ⇒ the
		/// projection was APPLIED to `AllowedStake`/capacity; `false` ⇒ shadow (recorded in [`ShadowStake`]
		/// only, the committee still drives weight).
		ObservationApplied { reference_slot: u64, credited: u32, cleared: u32, skipped: u32, enforced: bool },
		/// The enforce/shadow flag was set via [`Call::set_enforcement`]. `enabled = true` ⇒ the verified
		/// inherent now APPLIES weight (enforce / cutover); `false` ⇒ shadow (projection-only, the default).
		EnforcementSet { enabled: bool },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// The proposed reference is older than the last accepted one (anti-regression, §5.6). A
		/// malicious author cannot rewind observed Cardano state.
		ReferenceRegressed,
		/// The proposed reference is fresher than the stability window allows (closer to the block's own
		/// time than `StabilitySlots`) — i.e. it reads history that could still roll back.
		ReferenceTooFresh,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Apply a verified Cardano observation. INHERENT-ONLY (`is_inherent` → true ⇒ pool-inadmissible)
		/// and `Mandatory`. Runs in `execute_block` on every node; its enforcement (monotonicity,
		/// stability bound, `MaxStakeWeight` skip, account resolution, weight/capacity application, unlock
		/// clamp) is what holds even on nodes that skip `check_inherent` (§6).
		#[pallet::call_index(0)]
		#[pallet::weight((T::WeightInfo::observe(entries.len() as u32), DispatchClass::Mandatory))]
		pub fn observe(
			origin: OriginFor<T>,
			reference: CardanoRef,
			entries: BoundedVec<(BeaconName, u128), T::MaxObserved>,
		) -> DispatchResult {
			ensure_none(origin)?; // inherents dispatch with the None origin

			// Anti-regression (§5.6): never accept an older reference than the chain already holds.
			if let Some(last) = LastReference::<T>::get() {
				ensure!(reference.slot >= last.slot, Error::<T>::ReferenceRegressed);
			}
			// Stability sanity bound: the reference must be at least StabilitySlots behind THIS block's
			// own consensus time. Skipped (not failed) when the block time predates the Shelley anchor —
			// the node IDP already fails closed there, and a young/pre-Shelley chain has no valid bound.
			if let Some(max_ref) = Self::max_reference_for_now() {
				ensure!(reference.slot <= max_ref, Error::<T>::ReferenceTooFresh);
			}

			// Mode read ONCE (deterministic — every node reads the identical pre-state in execute_block).
			// In shadow (`false`, the default) the projection is recorded but NOT applied to weight; only
			// in enforce mode does `WeightSink` touch `AllowedStake`/capacity. Both `set_weight` call-sites
			// (credit + clamp) are gated under this one flag — partial gating would corrupt committee-owned
			// weight in shadow.
			let enforce = EnforceWeight::<T>::get();
			let min_lock = T::MinLock::get();
			let max_weight = T::MaxStakeWeight::get();
			let mut credited_set: BoundedVec<(BeaconName, T::AccountId), T::MaxObserved> =
				BoundedVec::new();
			let mut credited: u32 = 0;
			let mut skipped: u32 = 0;

			for (beacon, lovelace) in entries.iter() {
				// beacon → account (bind precedes weight; an unbound beacon is skipped, not an error).
				let account = match T::BeaconResolver::resolve(beacon) {
					Some(a) => a,
					None => continue,
				};
				// MIN_LOCK floor, then the MaxStakeWeight bound as SKIP-not-reject (§7 step 3). A skipped
				// over-cap entry is counted (surfaced in the event + the shadow-diff) so it is not silently
				// mis-read as agreement.
				let weight = if *lovelace >= min_lock { *lovelace } else { 0u128 };
				if weight > max_weight {
					log::warn!(
						target: LOG_TARGET,
						"observe: SKIP entry weight={weight} > MaxStakeWeight={max_weight} (bad value not consensus-pinned, block not bricked)",
					);
					skipped = skipped.saturating_add(1);
					continue;
				}
				// Record the projection ALWAYS (the shadow artifact); apply to weight ONLY in enforce mode.
				ShadowStake::<T>::insert(&account, weight);
				if enforce {
					T::WeightSink::set_weight(&account, weight);
				}
				// credited_set is bounded by MaxObserved, same as `entries`, so try_push cannot overflow
				// for a well-formed inherent; on the (impossible) overflow we simply don't record it for
				// the clamp diff rather than failing the Mandatory block.
				let _ = credited_set.try_push((*beacon, account));
				credited = credited.saturating_add(1);
			}

			// Unlock clamp (§7 step 6): a previously-credited account absent from the current set → 0.
			// Recorded in the shadow projection ALWAYS (mirroring `AllowedStake`'s insert-0-never-delete);
			// applied to weight ONLY in enforce mode.
			let prev = LastObserved::<T>::get();
			let mut cleared: u32 = 0;
			for (beacon, account) in prev.iter() {
				if !credited_set.iter().any(|(b, _)| b == beacon) {
					ShadowStake::<T>::insert(account, 0u128);
					if enforce {
						T::WeightSink::set_weight(account, 0);
					}
					cleared = cleared.saturating_add(1);
				}
			}

			LastObserved::<T>::put(credited_set);
			LastReference::<T>::put(&reference);
			Self::deposit_event(Event::ObservationApplied {
				reference_slot: reference.slot,
				credited,
				cleared,
				skipped,
				enforced: enforce,
			});
			Ok(())
		}

		/// Flip the enforce/shadow flag ([`EnforceWeight`]). `enabled = true` ⇒ the verified inherent
		/// APPLIES weight to `AllowedStake`/capacity (the cutover); `false` ⇒ shadow (projection-only, the
		/// default). Gated by [`Config::EnforceOrigin`] (root OR the 3-of-5 committee). NOT an inherent
		/// (`is_inherent` matches only `observe`), so this is a normal pool-admissible governance call —
		/// the §5.2 per-call mutual-exclusion invariant is preserved.
		///
		/// ⚠ Enabling on a single-operator stack is **D4-SHAPED, not D4-TRUST** (no independent verifier;
		/// §2). The production cutover is gated on ≥3 independent producers AND is not a pure flip for
		/// weight already on-chain (reconcile the committee-credited keyset to the inherent's view first).
		#[pallet::call_index(1)]
		#[pallet::weight(T::WeightInfo::set_enforcement())]
		pub fn set_enforcement(origin: OriginFor<T>, enabled: bool) -> DispatchResult {
			T::EnforceOrigin::ensure_origin(origin)?;
			EnforceWeight::<T>::put(enabled);
			Self::deposit_event(Event::EnforcementSet { enabled });
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		/// The consensus-pinned observation config for the node-side IDP (via [`CardanoObserverApi`]).
		/// Single source of truth — node + runtime cannot drift on the anchors / window / vault policy.
		pub fn observer_config() -> ObserverConfig {
			ObserverConfig {
				shelley_start_unix: T::ShelleyStartUnix::get(),
				shelley_start_slot: T::ShelleyStartSlot::get(),
				stability_slots: T::StabilitySlots::get(),
				vault_policy_id: T::VaultPolicyId::get().to_vec(),
			}
		}

		/// The maximum legitimate reference slot for THIS block = `cardano_slot(now) − StabilitySlots`,
		/// or `None` when the block time predates the Shelley anchor (so the bound is skipped). All
		/// arithmetic is CHECKED (release WASM has overflow-checks off; a naive subtraction would WRAP,
		/// not fail — §5.2). Mirrors `cardanoReferenceSlot` in `services/_shared/observation.mjs`.
		fn max_reference_for_now() -> Option<u64> {
			let now_s = T::UnixTime::now().as_secs();
			let t0 = T::ShelleyStartUnix::get();
			let s0 = T::ShelleyStartSlot::get();
			let window = T::StabilitySlots::get();
			let elapsed = now_s.checked_sub(t0)?; // pre-Shelley ⇒ None (skip the bound)
			let cardano_slot = s0.checked_add(elapsed)?;
			let max_ref = cardano_slot.checked_sub(window)?;
			if max_ref < s0 {
				return None;
			}
			Some(max_ref)
		}
	}

	#[pallet::inherent]
	impl<T: Config> ProvideInherent for Pallet<T> {
		type Call = Call<T>;
		type Error = InherentError;
		const INHERENT_IDENTIFIER: InherentIdentifier = INHERENT_IDENTIFIER;

		/// AUTHOR side: build the `observe` call from this node's observation. Absent data ⇒ no inherent
		/// this block (legal — `is_inherent_required` is the default `Ok(None)`). An observation larger
		/// than `MaxObserved` ⇒ abstain (never author a malformed/truncated inherent).
		fn create_inherent(data: &InherentData) -> Option<Self::Call> {
			let obs = data
				.get_data::<CardanoObservation>(&INHERENT_IDENTIFIER)
				.ok()
				.flatten()?;
			let entries = BoundedVec::try_from(obs.entries).ok()?;
			Some(Call::observe { reference: obs.reference, entries })
		}

		/// IMPORTER side: compare the author's observation against THIS node's own read at the same
		/// reference. Exact match ⇒ Ok. Difference ⇒ `Mismatch` (fatal). Own source behind/absent ⇒
		/// `CannotVerify` (non-fatal: accept without verifying — never fork because YOUR follower lags).
		fn check_inherent(call: &Self::Call, data: &InherentData) -> Result<(), Self::Error> {
			let (reference, entries) = match call {
				Call::observe { reference, entries } => (reference, entries),
				_ => return Ok(()),
			};
			let local = match data
				.get_data::<CardanoObservation>(&INHERENT_IDENTIFIER)
				.ok()
				.flatten()
			{
				Some(o) => o,
				None => return Err(InherentError::CannotVerify),
			};
			// Compare the reference SLOT + the canonical entries only — NOT `block_hash` (a node-local Kupo
			// checkpoint-tip diagnostic, see [`CardanoRef`]). The slot is the consensus anchor; the entries
			// are the verified read. A behind/forked importer never reaches a FALSE mismatch here because
			// its IDP abstains (→ CannotVerify) when its Kupo has not indexed past the reference.
			if reference.slot == local.reference.slot && entries.as_slice() == local.entries.as_slice() {
				Ok(())
			} else {
				Err(InherentError::Mismatch)
			}
		}

		fn is_inherent(call: &Self::Call) -> bool {
			matches!(call, Call::observe { .. })
		}
	}
}
