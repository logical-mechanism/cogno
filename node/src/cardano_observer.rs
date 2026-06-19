//! Node-side deterministic Cardano observation for the in-protocol-observation inherent (D4).
//!
//! This is the IO half of the D4 weight rung (`docs/IN-PROTOCOL-OBSERVATION.md`): every validator node
//! reads the Cardano `talk_vault` UTxO set AS-OF a stable reference slot and supplies it as inherent
//! data under [`pallet_cardano_observer::INHERENT_IDENTIFIER`]. The runtime
//! ([`pallet_cardano_observer`]) then verifies it ([`ProvideInherent::check_inherent`]) and applies the
//! weight. The pure reduction below is the Rust counterpart of `services/_shared/observation.mjs`
//! (`observeAsOf` / `cardanoReferenceSlot`) — kept logically identical so the off-chain shadow-diff
//! aligns; consensus determinism rests on every validator running this same node code.
//!
//! **This module is the pure core + the `InherentDataProvider` wrapper.** The live Kupo fetch and the
//! `service.rs` closure wiring (deriving the reference from the parent block, both the import and
//! authoring `CreateInherentDataProviders`) are the next increment.

// The pure fns + the IDP are consumed by the tests below now and by service.rs in the next increment;
// until that wiring lands they are dead code from the binary's entrypoint's perspective.
#![allow(dead_code)]

use codec::Decode;
use pallet_cardano_observer::{
	BeaconName, CardanoObservation, CardanoRef, InherentError, INHERENT_IDENTIFIER,
};
use sp_inherents::{InherentData, InherentDataProvider, InherentIdentifier};
use std::collections::BTreeMap;

/// Map a stable wall-clock time (unix seconds, from the PARENT block) to the Cardano slot to observe
/// AS-OF: `(Shelley slot at that time) − stability_window`. Fail-closed (`None`) on a pre-Shelley /
/// wrong-network / underflowing input ⇒ the caller emits no observation. Rust port of
/// `cardanoReferenceSlot` (observation.mjs) — checked arithmetic, since a naive `u64` subtraction would
/// WRAP under overflow-checks-off release builds (the determinism trap, design §5.2). Only 1 s Shelley
/// slots; the anchor MUST be the Shelley start, NOT Byron `systemStart`.
pub fn reference_slot(
	parent_unix_s: u64,
	shelley_start_unix: u64,
	shelley_start_slot: u64,
	stability_slots: u64,
) -> Option<u64> {
	let elapsed = parent_unix_s.checked_sub(shelley_start_unix)?; // pre-Shelley ⇒ None
	let cardano_slot = shelley_start_slot.checked_add(elapsed)?;
	let reference = cardano_slot.checked_sub(stability_slots)?;
	if reference < shelley_start_slot {
		return None; // window larger than elapsed Shelley slots ⇒ fail closed
	}
	Some(reference)
}

/// Parse a 64-char (32-byte) hex string into a `BeaconName`; `None` on bad length/chars.
fn hex32(s: &str) -> Option<BeaconName> {
	let s = s.strip_prefix("0x").unwrap_or(s);
	if s.len() != 64 {
		return None;
	}
	let b = s.as_bytes();
	let mut out = [0u8; 32];
	for i in 0..32 {
		let hi = (b[2 * i] as char).to_digit(16)?;
		let lo = (b[2 * i + 1] as char).to_digit(16)?;
		out[i] = ((hi << 4) | lo) as u8;
	}
	Some(out)
}

/// Read an integer field that Kupo may encode as a JSON number OR a string (defensive).
fn as_u128(v: &serde_json::Value) -> Option<u128> {
	v.as_u64().map(u128::from).or_else(|| v.as_str().and_then(|s| s.parse::<u128>().ok()))
}
fn as_u64(v: &serde_json::Value) -> Option<u64> {
	v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
}

/// PURE: reduce Kupo `/matches` JSON to the canonical largest-wins-per-beacon set AS-OF `reference_slot`.
/// Rust port of `observeAsOf` (observation.mjs): a UTxO counts iff it holds EXACTLY ONE asset of the
/// vault policy at qty 1, positive lovelace, was created ≤ ref, and is unspent as-of ref (`spent_at` is
/// null OR `spent_at.slot > ref` — so a UTxO spent AFTER the reference is still counted as locked-at-ref).
/// Largest-wins per beacon (NEVER sum). Returns RAW lovelace (the MIN_LOCK floor is applied on-chain at
/// weight-application). The `BTreeMap<[u8;32], _>` yields entries already sorted ascending by the 32
/// beacon bytes — the canonical order the runtime compares against.
pub fn observe_as_of(
	matches: &[serde_json::Value],
	vault_hash: &str,
	reference_slot: u64,
) -> Vec<(BeaconName, u128)> {
	let vh = vault_hash.to_lowercase();
	let mut largest: BTreeMap<BeaconName, u128> = BTreeMap::new();

	for m in matches {
		let value = match m.get("value") {
			Some(v) => v,
			None => continue,
		};
		// Exactly one beacon under the vault policy at qty 1.
		let mut beacon: Option<BeaconName> = None;
		let mut vault_assets = 0u32;
		if let Some(assets) = value.get("assets").and_then(|a| a.as_object()) {
			for (key, qty) in assets {
				let policy = key.split('.').next().unwrap_or("").to_lowercase();
				if policy == vh {
					vault_assets += 1;
					if as_u64(qty) == Some(1) {
						beacon = key.splitn(2, '.').nth(1).and_then(hex32);
					}
				}
			}
		}
		if vault_assets != 1 {
			continue;
		}
		let beacon = match beacon {
			Some(b) => b,
			None => continue,
		};
		// created ≤ ref (a missing created slot fails closed: skip).
		let created = match m.get("created_at").and_then(|c| c.get("slot_no")).and_then(as_u64) {
			Some(c) => c,
			None => continue,
		};
		if created > reference_slot {
			continue;
		}
		// unspent as-of ref: spent strictly at/before ref ⇒ not locked.
		if let Some(spent) = m.get("spent_at").and_then(|s| s.get("slot_no")).and_then(as_u64) {
			if spent <= reference_slot {
				continue;
			}
		}
		// positive lovelace.
		let coins = match value.get("coins").and_then(as_u128) {
			Some(c) if c > 0 => c,
			_ => continue,
		};
		let entry = largest.entry(beacon).or_insert(0);
		if coins > *entry {
			*entry = coins; // largest-wins, never sum
		}
	}

	largest.into_iter().collect()
}

/// Build the full observation (reference + canonical entries) from Kupo matches.
pub fn build_observation(
	reference: CardanoRef,
	matches: &[serde_json::Value],
	vault_hash: &str,
) -> CardanoObservation {
	let slot = reference.slot;
	CardanoObservation { reference, entries: observe_as_of(matches, vault_hash, slot) }
}

/// The node-side `InherentDataProvider` for the Cardano observation. Holds the observation this node
/// computed, or `None` when its own Kupo source is behind/down (fail-closed — provide nothing, so the
/// author emits no inherent and the chain stays live).
pub struct CardanoObservationInherentDataProvider {
	pub observation: Option<CardanoObservation>,
}

#[async_trait::async_trait]
impl InherentDataProvider for CardanoObservationInherentDataProvider {
	async fn provide_inherent_data(
		&self,
		inherent_data: &mut InherentData,
	) -> Result<(), sp_inherents::Error> {
		if let Some(obs) = &self.observation {
			inherent_data.put_data(INHERENT_IDENTIFIER, obs)?;
		}
		Ok(())
	}

	async fn try_handle_error(
		&self,
		identifier: &InherentIdentifier,
		error: &[u8],
	) -> Option<Result<(), sp_inherents::Error>> {
		if *identifier != INHERENT_IDENTIFIER {
			return None;
		}
		// THE load-bearing rule (design §6): branch on the runtime's typed error. A Mismatch is
		// PROPAGATED (Some(Err) ⇒ block rejected); a CannotVerify is SWALLOWED (Some(Ok) ⇒ accept
		// without verifying — never fork because OUR follower lags). A blanket swallow would silently
		// defeat the entire cross-node fork-protection.
		match InherentError::decode(&mut &error[..]) {
			Ok(InherentError::Mismatch) => Some(Err(sp_inherents::Error::Application(
				Box::<dyn core::error::Error + Send + Sync>::from(
					"cardano observation mismatch: the author's read disagrees with this node's",
				),
			))),
			Ok(InherentError::CannotVerify) => Some(Ok(())),
			Err(_) => None,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use serde_json::json;

	// preprod anchor (matches the runtime config); a small mock stability window.
	const SHELLEY_UNIX: u64 = 1_655_769_600;
	const SHELLEY_SLOT: u64 = 86_400;
	const STABILITY: u64 = 1_000;
	const VAULT: &str = "168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7";
	const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

	fn beacon(hex: &str) -> BeaconName {
		hex32(hex).unwrap()
	}

	fn utxo(b: &str, coins: u128, created: u64, spent: Option<u64>) -> serde_json::Value {
		let mut m = json!({
			"transaction_id": "tx", "output_index": 0,
			"value": { "coins": coins, "assets": { format!("{VAULT}.{b}"): 1 } },
			"created_at": { "slot_no": created, "header_hash": "hh" },
		});
		m["spent_at"] = match spent {
			Some(s) => json!({ "slot_no": s, "header_hash": "hh" }),
			None => serde_json::Value::Null,
		};
		m
	}

	#[test]
	fn reference_slot_is_fail_closed() {
		assert_eq!(
			reference_slot(SHELLEY_UNIX + 200_000, SHELLEY_UNIX, SHELLEY_SLOT, 129_600),
			Some(SHELLEY_SLOT + 200_000 - 129_600)
		);
		// pre-Shelley (Byron systemStart) ⇒ None, wrap-safe (not a near-u64::MAX slot).
		assert_eq!(reference_slot(1_654_041_600, SHELLEY_UNIX, SHELLEY_SLOT, 129_600), None);
		assert_eq!(reference_slot(0, SHELLEY_UNIX, SHELLEY_SLOT, 129_600), None);
		// window larger than elapsed ⇒ None.
		assert_eq!(reference_slot(SHELLEY_UNIX + 100, SHELLEY_UNIX, SHELLEY_SLOT, 129_600), None);
	}

	#[test]
	fn observe_as_of_largest_wins_as_of_reference() {
		let r = 1_000u64;
		// largest-wins per beacon, never sum.
		let g = observe_as_of(
			&[utxo(A, 100_000_000, 1, None), utxo(A, 250_000_000, 2, None), utxo(A, 180_000_000, 3, None)],
			VAULT,
			r,
		);
		assert_eq!(g, vec![(beacon(A), 250_000_000)]);
		// spent AFTER ref ⇒ still counted; spent at/before ref ⇒ not.
		assert_eq!(observe_as_of(&[utxo(A, 200_000_000, 10, Some(1500))], VAULT, r), vec![(beacon(A), 200_000_000)]);
		assert!(observe_as_of(&[utxo(A, 200_000_000, 10, Some(1000))], VAULT, r).is_empty());
		assert!(observe_as_of(&[utxo(A, 200_000_000, 10, Some(500))], VAULT, r).is_empty());
		// created after ref ⇒ too fresh.
		assert!(observe_as_of(&[utxo(A, 200_000_000, 1500, None)], VAULT, r).is_empty());
		// zero-coin not credited; wrong policy empty.
		assert!(observe_as_of(&[utxo(A, 0, 1, None)], VAULT, r).is_empty());
		assert!(observe_as_of(&[utxo(A, 100_000_000, 1, None)], "ff".repeat(28).as_str(), r).is_empty());
	}

	#[test]
	fn observe_as_of_is_canonically_sorted_and_independent_of_input_order() {
		let r = 1_000u64;
		let in_order = vec![utxo(A, 250_000_000, 10, None), utxo(B, 150_000_000, 20, None)];
		let shuffled = vec![
			utxo(B, 150_000_000, 20, None),
			utxo(A, 100_000_000, 9, None), // smaller dup of A — dropped by largest-wins
			utxo(A, 250_000_000, 10, None),
			utxo(A, 999_999_999, 1500, None), // too fresh — excluded
		];
		let a = observe_as_of(&in_order, VAULT, r);
		let b = observe_as_of(&shuffled, VAULT, r);
		assert_eq!(a, b, "same stable point ⇒ identical canonical output regardless of input order");
		// sorted ascending by beacon bytes (A = 0xAA.. < B = 0xBB..).
		assert_eq!(a, vec![(beacon(A), 250_000_000), (beacon(B), 150_000_000)]);
	}

	#[test]
	fn rejects_a_two_beacon_utxo() {
		let r = 1_000u64;
		let m = json!({
			"transaction_id": "t", "output_index": 0,
			"value": { "coins": 900, "assets": { format!("{VAULT}.{A}"): 1, format!("{VAULT}.{B}"): 1 } },
			"created_at": { "slot_no": 1 }, "spent_at": serde_json::Value::Null,
		});
		assert!(observe_as_of(&[m], VAULT, r).is_empty());
	}

	#[test]
	fn try_handle_error_branches_on_the_typed_error() {
		use codec::Encode;
		let idp = CardanoObservationInherentDataProvider { observation: None };
		let mismatch = InherentError::Mismatch.encode();
		let cannot = InherentError::CannotVerify.encode();
		// Mismatch ⇒ Some(Err) (propagate → reject); CannotVerify ⇒ Some(Ok) (accept without verifying).
		assert!(matches!(
			futures::executor::block_on(idp.try_handle_error(&INHERENT_IDENTIFIER, &mismatch)),
			Some(Err(_))
		));
		assert!(matches!(
			futures::executor::block_on(idp.try_handle_error(&INHERENT_IDENTIFIER, &cannot)),
			Some(Ok(()))
		));
		// A different identifier is not ours ⇒ None.
		assert!(futures::executor::block_on(idp.try_handle_error(b"timstap0", &mismatch)).is_none());
	}

	#[test]
	fn provide_inherent_data_puts_observation_only_when_present() {
		// Some(obs) ⇒ data is put under our identifier; None ⇒ nothing (fail-closed author abstains).
		let obs = CardanoObservation {
			reference: CardanoRef { slot: 1_000, block_hash: [0u8; 32] },
			entries: vec![(beacon(A), 200_000_000)],
		};
		let with = CardanoObservationInherentDataProvider { observation: Some(obs) };
		let mut id = InherentData::new();
		futures::executor::block_on(with.provide_inherent_data(&mut id)).unwrap();
		assert!(id.get_data::<CardanoObservation>(&INHERENT_IDENTIFIER).unwrap().is_some());

		let without = CardanoObservationInherentDataProvider { observation: None };
		let mut id2 = InherentData::new();
		futures::executor::block_on(without.provide_inherent_data(&mut id2)).unwrap();
		assert!(id2.get_data::<CardanoObservation>(&INHERENT_IDENTIFIER).unwrap().is_none());
	}
}
