//! # Anchor pallet (cogno-chain)
//!
//! **The Cardano WRITE link (M3, Tier-A): a tamper-evidence checkpoint log.** Every N finalized
//! blocks the off-chain **Anchor Relayer** writes the solochain's finalized post-state root onto
//! Cardano as tx **metadata**, then calls [`Pallet::anchor_ack`] back here so the chain (and the
//! UI) record *which* Cardano tx witnessed *which* finalized root. This is **evidence, not
//! enforcement** (DR-20): Cardano cannot reject a wrong root or roll the chain back; the anchor
//! only lets a third party — given the committed archive (DR-08) — **detect** a silent rewrite
//! after the fact (`PLAN.md` §4.9–4.10, §9; `L3-chain.md` M6).
//!
//! ## What this pallet does — and pointedly does NOT do
//! It **only records** the checkpoint the relayer reports. It does **not** snapshot a root in
//! `on_initialize` (that would expose only block `N-1`'s state, and could anchor a root that later
//! loses to a different finalized fork — `PLAN.md` §4.9). The trusted relayer reads the root GRANDPA
//! has *actually committed* (the finalized block header's `state_root`) and submits it here.
//!
//! ## Idempotency — the load-bearing invariant (§9)
//! `anchor_ack` is keyed by `block_number` and is a **no-op if `block_number <= last recorded`**.
//! This is not cosmetic: a Cardano rollback can force the relayer to re-submit the same checkpoint,
//! and a naive write would double-count it. Re-acking an old/equal height succeeds (emits
//! [`Event::AckIgnored`]) so the relayer's retry path never has to special-case "already done",
//! but it writes nothing — the recorded checkpoint advances **monotonically**, exactly once per
//! height.
//!
//! ## v1 trust posture (named honestly — DR-07)
//! [`Config::AnchorOrigin`] is `EnsureRoot` (sudo) in v1 dev — the same single-operator-key trust
//! boundary as the follower's `FollowerOrigin`/`SetStakeOrigin`. The relayer's Cardano signing key
//! and this ack authority are the two crown jewels of the WRITE link (`PLAN.md` §9). It is an
//! `EnsureOrigin`, so widening to a k-of-t committee later is signature-free.

#![cfg_attr(not(feature = "std"), no_std)]

pub use pallet::*;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

pub mod weights;
pub use weights::*;

/// A solochain finalized post-state storage root — the 32-byte `state_root` of a finalized block
/// header (the root GRANDPA committed). A fixed `[u8; 32]` (not a `BoundedVec`): it is exactly a
/// hash, so the codec enforces the length for free and a verifier keys on the identical raw bytes
/// (the same shape choice as cogno-gate's `IdentityHash`).
pub type StateRoot = [u8; 32];

/// A Cardano transaction hash (blake2b-256, 32 bytes) — the metadata tx that witnessed a checkpoint.
pub type CardanoTxHash = [u8; 32];

/// Target string for this pallet's `log::` records — lets a node operator filter the WRITE-link
/// diagnostics (e.g. `RUST_LOG=runtime::anchor=debug`). Mirrors `pallet-validator-set::LOG_TARGET`.
/// The log lines are off-chain diagnostics ONLY; the on-chain audit trail remains the event stream.
pub const LOG_TARGET: &str = "runtime::anchor";

#[frame_support::pallet]
pub mod pallet {
	use super::*;
	use frame_support::pallet_prelude::*;
	use frame_system::pallet_prelude::*;

	/// One recorded tamper-evidence checkpoint: "at solochain block `block_number`, whose finalized
	/// post-state root was `finalized_root` and which had `post_count` posts at time `timestamp`,
	/// the relayer witnessed it on Cardano in tx `cardano_txhash`." Generic over the block-number
	/// type only (no `T: Config`), so plain derives suffice — no `*NoBound` dance.
	#[derive(Encode, Decode, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen)]
	pub struct Checkpoint<BlockNumber> {
		/// The finalized solochain block this checkpoint witnesses.
		pub block_number: BlockNumber,
		/// The post-state storage root of that finalized block (the GRANDPA-committed root).
		pub finalized_root: StateRoot,
		/// The Cardano metadata tx that carries `finalized_root` (blake2b-256, 32 bytes).
		pub cardano_txhash: CardanoTxHash,
		/// `Microblog::NextPostId` at that block — the total posts created by then (sanity/UX).
		pub post_count: u64,
		/// Relayer-supplied unix-millis (the finalized block's `Timestamp::Now`). Recorded for the
		/// UI; not consensus-relevant (the chain does no time validation here).
		pub timestamp: u64,
	}

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	#[pallet::config]
	pub trait Config: frame_system::Config {
		/// The overarching runtime event type.
		#[allow(deprecated)]
		type RuntimeEvent: From<Event<Self>>
			+ IsType<<Self as frame_system::Config>::RuntimeEvent>;
		/// The authority allowed to record a checkpoint — the trusted Anchor Relayer; a single key
		/// via `EnsureRoot`/sudo in v1 dev (DR-07). An `EnsureOrigin` (never `ensure_signed`): the
		/// public pool must not be able to forge anchor records. Same trust boundary as the
		/// follower's `FollowerOrigin`/`SetStakeOrigin`, so a k-of-t widen is signature-free.
		type AnchorOrigin: EnsureOrigin<Self::RuntimeOrigin>;
		/// Weight information for this pallet's dispatchables.
		type WeightInfo: WeightInfo;
	}

	/// The most recently recorded checkpoint. `OptionQuery` ⇒ `None` before the first anchor. A
	/// single `StorageValue` (not a history map): Cardano is the append-only log of *all* anchors
	/// (each is its own tx); the chain only needs the latest height to (a) enforce monotonicity and
	/// (b) show "anchored to Cardano at tx X" in the UI. The full history is re-derivable from the
	/// `AnchorAcked` events / the Cardano metadata under the registered label.
	#[pallet::storage]
	pub type LastCheckpoint<T: Config> =
		StorageValue<_, Checkpoint<BlockNumberFor<T>>, OptionQuery>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A new checkpoint was recorded (strictly advances the height). This is the D0 per-anchor
		/// audit record — the event stream IS the on-chain anchor history.
		AnchorAcked {
			block_number: BlockNumberFor<T>,
			finalized_root: StateRoot,
			cardano_txhash: CardanoTxHash,
			post_count: u64,
			timestamp: u64,
		},
		/// A stale/duplicate ack was ignored (`block_number <= last recorded`) — the idempotency
		/// no-op (§9). Emitted (not erroring) so a relayer re-submit after a Cardano rollback is
		/// observably a no-op rather than a failure; nothing is written.
		AckIgnored { block_number: BlockNumberFor<T>, last: BlockNumberFor<T> },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// A strictly-higher anchor reported a `post_count` or `timestamp` BELOW the last
		/// checkpoint's. Both are monotonic on-chain (post ids only grow; block time only advances),
		/// so this is inconsistent evidence from a buggy/malicious relayer (`anchor-1`).
		NonMonotonicAnchor,
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Record that the relayer witnessed solochain block `block_number` (post-state root
		/// `finalized_root`, `post_count` posts, `timestamp`) on Cardano in tx `cardano_txhash`.
		/// Gated by [`Config::AnchorOrigin`] (sudo in dev) — the chain trusts the relayer to have
		/// read a genuinely *finalized* root and to have actually submitted the Cardano tx.
		///
		/// **Idempotent (§9):** a no-op if `block_number <= last recorded` — emits
		/// [`Event::AckIgnored`] and writes nothing, so a Cardano-rollback re-submit cannot
		/// double-count. On a strictly higher height it overwrites [`LastCheckpoint`] and emits
		/// [`Event::AnchorAcked`]. The recorded height therefore only ever moves forward.
		#[pallet::call_index(0)]
		#[pallet::weight(T::WeightInfo::anchor_ack())]
		pub fn anchor_ack(
			origin: OriginFor<T>,
			block_number: BlockNumberFor<T>,
			finalized_root: StateRoot,
			cardano_txhash: CardanoTxHash,
			post_count: u64,
			timestamp: u64,
		) -> DispatchResult {
			// The WRITE-link trust boundary (DR-07). Log a rejected origin so an operator can see a
			// forged-anchor attempt (or a misconfigured relayer key) in the node logs, not just the
			// opaque `BadOrigin` the submitter receives. `warn!`: an unauthorised account reaching
			// this gate is an anomaly worth noticing on a security-critical call.
			if let Err(e) = T::AnchorOrigin::ensure_origin(origin) {
				log::warn!(
					target: LOG_TARGET,
					"anchor_ack rejected: origin not AnchorOrigin (block_number={block_number:?})",
				);
				return Err(e.into());
			}

			// Idempotency / anti-double-count: only a strictly higher finalized height advances the
			// recorded checkpoint. `<=` (not `<`) so a re-ack of the SAME height is also a no-op.
			if let Some(last) = LastCheckpoint::<T>::get() {
				if block_number <= last.block_number {
					// Routine: a Cardano-rollback re-submit. `debug!` (not `warn!`) — the no-op IS the
					// designed behaviour (§9); the relayer's retry path relies on it. Logged so an
					// operator debugging a stuck relayer can see "ack ignored: N <= last" without
					// having to scrape the AckIgnored event stream over RPC.
					log::debug!(
						target: LOG_TARGET,
						"anchor_ack ignored (idempotent no-op): block_number={block_number:?} <= last={:?}",
						last.block_number,
					);
					Self::deposit_event(Event::AckIgnored {
						block_number,
						last: last.block_number,
					});
					return Ok(());
				}
				// anchor-1: a strictly-higher height must carry non-regressing post_count + timestamp
				// (both monotonic on-chain). A regression is inconsistent evidence — reject it rather
				// than pinning a bad checkpoint that the monotonic height makes permanent.
				if post_count < last.post_count || timestamp < last.timestamp {
					// A buggy/malicious relayer reported a higher height with a regressed field. This is
					// inconsistent on-chain evidence — `warn!` with which field(s) regressed and by how
					// much, because the submitter only ever sees the opaque NonMonotonicAnchor error.
					log::warn!(
						target: LOG_TARGET,
						"anchor_ack rejected NonMonotonicAnchor at block_number={block_number:?}: \
						 post_count={post_count} (last={}), timestamp={timestamp} (last={})",
						last.post_count,
						last.timestamp,
					);
					return Err(Error::<T>::NonMonotonicAnchor.into());
				}
			}

			LastCheckpoint::<T>::put(Checkpoint {
				block_number,
				finalized_root,
				cardano_txhash,
				post_count,
				timestamp,
			});
			log::debug!(
				target: LOG_TARGET,
				"anchor_ack recorded checkpoint: block_number={block_number:?} post_count={post_count} timestamp={timestamp}",
			);
			Self::deposit_event(Event::AnchorAcked {
				block_number,
				finalized_root,
				cardano_txhash,
				post_count,
				timestamp,
			});
			Ok(())
		}
	}

	impl<T: Config> Pallet<T> {
		/// The last recorded checkpoint, if any. Read-only helper for tooling / the relayer's
		/// "where did I leave off" resume and idempotency check.
		pub fn last_checkpoint() -> Option<Checkpoint<BlockNumberFor<T>>> {
			LastCheckpoint::<T>::get()
		}
	}
}
