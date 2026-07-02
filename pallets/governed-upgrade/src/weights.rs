//! Weights for `pallet-governed-upgrade`.
//!
//! Placeholder weight for now — the real FRAME benchmark is a later step. `authorize_upgrade` is a single
//! committee-gated call that writes one `frame_system::AuthorizedUpgrade` storage value and emits one
//! event, so a fixed coarse estimate keeps the accounting honest. (The heavy whole-block work — actually
//! swapping `:code` — happens in the separate permissionless `frame_system::apply_authorized_upgrade`,
//! not here.)

use frame_support::weights::Weight;

pub trait WeightInfo {
	fn authorize_upgrade() -> Weight;
}

/// Placeholder: a fixed base covering one storage write + one event deposit. Replace with a benchmarked
/// `SubstrateWeight<T>` in a later step.
impl WeightInfo for () {
	fn authorize_upgrade() -> Weight {
		Weight::from_parts(10_000_000, 0)
	}
}
