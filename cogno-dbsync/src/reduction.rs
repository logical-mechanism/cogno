//! The PURE, deterministic reduction half of the Cardano observation — no IO, no `sc-*`, no node.
//!
//! Folded out of the former `node/src/cardano_observer.rs` (its pure core) and kept logically identical to
//! the retired `services/_shared/observation.mjs` (`observeAsOf` / `cardanoReferenceSlot` / `candidates`)
//! and `services/cogno-follower/vault.py` — the cross-language spec these all mirrored is now this one
//! crate. The node observation `InherentDataProvider` (the WRITER) and the `cogno-chain-cli`
//! `query weight --dbsync` diagnostic (READ-ONLY) both call these functions, so the golden fixture
//! ([`rust_matches_js_observation_equivalence_fixture`]) guarantees the CLI prints what the inherent
//! writes. A divergence here is a chain FORK.

use codec::Encode;
use pallet_cardano_observer::{BeaconName, CardanoObservation, CardanoRef, StakeCredential};
use std::collections::BTreeMap;

/// Map a stable wall-clock time (unix seconds, from the PARENT block) to the Cardano slot to observe
/// AS-OF: `(Shelley slot at that time) − stability_window`. Fail-closed (`None`) on a pre-Shelley /
/// wrong-network / underflowing input ⇒ the caller emits no observation. Port of `cardanoReferenceSlot`
/// (observation.mjs) — checked arithmetic, since a naive `u64` subtraction would WRAP under
/// overflow-checks-off release builds (the determinism trap, design §5.2). Only 1 s Shelley slots; the
/// anchor MUST be the Shelley start, NOT Byron `systemStart`.
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

/// Parse a hex string into EXACTLY `N` bytes; `None` on bad length/chars (accepts an optional `0x`).
/// The single nibble-decode on the consensus read path — [`hex32`] (32-byte beacon) and the db-sync
/// 28-byte stake-credential parse both route through it, so the two decoders can never drift (a
/// divergence here would be a cross-node fork).
pub fn hex_bytes<const N: usize>(s: &str) -> Option<[u8; N]> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() != 2 * N {
        return None;
    }
    let b = s.as_bytes();
    let mut out = [0u8; N];
    for i in 0..N {
        let hi = (b[2 * i] as char).to_digit(16)?;
        let lo = (b[2 * i + 1] as char).to_digit(16)?;
        out[i] = ((hi << 4) | lo) as u8;
    }
    Some(out)
}

/// Parse a 64-char (32-byte) hex string into a `BeaconName`; `None` on bad length/chars. Public so the
/// db-sync IO ([`crate::dbsync`]) can resolve the stable-block anchor `header_hash` into `[u8; 32]`.
pub fn hex32(s: &str) -> Option<BeaconName> {
    hex_bytes::<32>(s)
}

/// Parse a JSON integer field the SAME strict way `services/_shared/observation.mjs` did (the determinism
/// witness): a JSON number iff a non-negative integer in range, OR a string iff it is PURE ASCII digits in
/// range. Rust's bare `u64::from_str` is LOOSER than the JS `/^[0-9]+$/` — it accepts a leading `+` ("+1")
/// — so a coins / qty / slot one side accepts and the other drops would FORK the read. The
/// `all(is_ascii_digit)` guard pins this to the JS regex ("+1" / " 1" / "0x1" rejected).
fn as_u128(v: &serde_json::Value) -> Option<u128> {
    if let Some(n) = v.as_u64() {
        return Some(u128::from(n));
    }
    let s = v.as_str()?;
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u128>().ok()
}
fn as_u64(v: &serde_json::Value) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    let s = v.as_str()?;
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u64>().ok()
}

/// PURE: reduce the vault match JSON to the canonical largest-wins-per-beacon set AS-OF `reference_slot`.
/// Port of `observeAsOf` (observation.mjs): a UTxO counts iff it holds EXACTLY ONE asset of the vault
/// policy at qty 1, positive lovelace, was created ≤ ref, and is unspent as-of ref (`spent_at` is null OR
/// `spent_at.slot > ref` — so a UTxO spent AFTER the reference is still counted as locked-at-ref).
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
                        beacon = key.split_once('.').map(|x| x.1).and_then(hex32);
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
        let created = match m
            .get("created_at")
            .and_then(|c| c.get("slot_no"))
            .and_then(as_u64)
        {
            Some(c) => c,
            None => continue,
        };
        if created > reference_slot {
            continue;
        }
        // unspent as-of ref: spent strictly at/before ref ⇒ not locked.
        if let Some(spent) = m
            .get("spent_at")
            .and_then(|s| s.get("slot_no"))
            .and_then(as_u64)
        {
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

/// PURE: the PRE-REDUCTION structural candidate set — every vault UTxO the as-of reduction CONSUMES,
/// before the time-filter / largest-wins fold. The canonical SCALE encoding of this sorted set is the
/// input-commitment PRE-IMAGE; its `blake2_256` is the [`inputs_commitment`] (the partner-chains
/// `selection_inputs_hash` analog) the runtime's `check_inherent` uses to tell a data fork (`Mismatch`)
/// apart from a reduction divergence (`ComputeDiverged`). Port of `candidates` (observation.mjs): a UTxO
/// is a candidate iff it holds EXACTLY ONE vault-policy asset at qty 1, a 32-byte beacon, a present
/// `created_at.slot_no`, and a parseable `coins` — the SAME structural gate [`observe_as_of`] applies
/// before its time/largest-wins reduction. Carries RAW `(beacon, created, spent, coins)`; NO time filter,
/// NO largest-wins. The derived `Ord` sort (beacon bytes, created, spent with `None` < `Some`, coins)
/// matches the JS comparator exactly, so the SCALE bytes are byte-identical cross-language.
pub fn candidate_tuples(
    matches: &[serde_json::Value],
    vault_hash: &str,
) -> Vec<(BeaconName, u64, Option<u64>, u128)> {
    let vh = vault_hash.to_lowercase();
    let mut out: Vec<(BeaconName, u64, Option<u64>, u128)> = Vec::new();
    for m in matches {
        let value = match m.get("value") {
            Some(v) => v,
            None => continue,
        };
        // Exactly one beacon under the vault policy at qty 1 (same structural gate as observe_as_of).
        let mut beacon: Option<BeaconName> = None;
        let mut vault_assets = 0u32;
        if let Some(assets) = value.get("assets").and_then(|a| a.as_object()) {
            for (key, qty) in assets {
                let policy = key.split('.').next().unwrap_or("").to_lowercase();
                if policy == vh {
                    vault_assets += 1;
                    if as_u64(qty) == Some(1) {
                        beacon = key.split_once('.').map(|x| x.1).and_then(hex32);
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
        // created present (fail closed: a UTxO we can't place in time is not an input); coins parseable.
        let created = match m
            .get("created_at")
            .and_then(|c| c.get("slot_no"))
            .and_then(as_u64)
        {
            Some(c) => c,
            None => continue,
        };
        let coins = match value.get("coins").and_then(as_u128) {
            Some(c) => c,
            None => continue,
        };
        let spent = m
            .get("spent_at")
            .and_then(|s| s.get("slot_no"))
            .and_then(as_u64);
        out.push((beacon, created, spent, coins));
    }
    // Derived Ord on the tuple: beacon (lexicographic ≡ byte order), created, spent (None < Some), coins —
    // the SAME total order `candidates` sorts by in observation.mjs.
    out.sort();
    out
}

/// PURE: the canonical SCALE encoding of the sorted candidate set — the input-commitment PRE-IMAGE.
/// `Vec<([u8;32], u64, Option<u64>, u128)>::encode()` is byte-identical to `candidateBytes`
/// (observation.mjs): a SCALE-compact length ++ per candidate 32 beacon bytes ++ u64 LE created ++
/// Option<u64> spent (`0x00` None / `0x01` ++ u64 LE Some) ++ u128 LE coins.
pub fn candidate_bytes(matches: &[serde_json::Value], vault_hash: &str) -> Vec<u8> {
    candidate_tuples(matches, vault_hash).encode()
}

/// PURE: the input commitment = `blake2_256` of the candidate pre-image (the partner-chains
/// `selection_inputs_hash` analog). Carried in the inherent so `check_inherent` can distinguish "saw
/// different Cardano data" (`Mismatch`) from "reduced the same data differently" (`ComputeDiverged`).
pub fn inputs_commitment(matches: &[serde_json::Value], vault_hash: &str) -> [u8; 32] {
    sp_crypto_hashing::blake2_256(&candidate_bytes(matches, vault_hash))
}

/// PURE: canonicalize the raw per-credential `epoch_stake` totals into the SAME ascending-by-28-bytes
/// order the runtime compares against (a `BTreeMap` over the 28 credential bytes — last-write-wins on the
/// impossible duplicate, matching the vault path's `BTreeMap` discipline). The db-sync read returns one
/// row per bound credential; this only fixes the order so author + importer SCALE-encode identically.
pub fn canonical_stake_entries(raw: Vec<(StakeCredential, u128)>) -> Vec<(StakeCredential, u128)> {
    let map: BTreeMap<StakeCredential, u128> = raw.into_iter().collect();
    map.into_iter().collect()
}

/// Build the full observation (reference + input commitment + canonical vault entries + canonical
/// voting-power stake entries) from the vault matches and the raw per-credential `epoch_stake` totals.
pub fn build_observation(
    reference: CardanoRef,
    matches: &[serde_json::Value],
    vault_hash: &str,
    stake_entries: Vec<(StakeCredential, u128)>,
) -> CardanoObservation {
    let slot = reference.slot;
    CardanoObservation {
        reference,
        inputs_commitment: inputs_commitment(matches, vault_hash),
        entries: observe_as_of(matches, vault_hash, slot),
        stake_entries: canonical_stake_entries(stake_entries),
    }
}

/// Lowercase-hex encode bytes (the consensus-pinned vault policy id → the `$2` text the db-sync read
/// filters on, via `tx_out.payment_cred` / `multi_asset.policy`).
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // preprod anchor (matches the runtime config); a small mock stability window.
    const SHELLEY_UNIX: u64 = 1_655_769_600;
    const SHELLEY_SLOT: u64 = 86_400;
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
        assert_eq!(
            reference_slot(1_654_041_600, SHELLEY_UNIX, SHELLEY_SLOT, 129_600),
            None
        );
        assert_eq!(reference_slot(0, SHELLEY_UNIX, SHELLEY_SLOT, 129_600), None);
        // window larger than elapsed ⇒ None.
        assert_eq!(
            reference_slot(SHELLEY_UNIX + 100, SHELLEY_UNIX, SHELLEY_SLOT, 129_600),
            None
        );
    }

    #[test]
    fn observe_as_of_largest_wins_as_of_reference() {
        let r = 1_000u64;
        // largest-wins per beacon, never sum.
        let g = observe_as_of(
            &[
                utxo(A, 100_000_000, 1, None),
                utxo(A, 250_000_000, 2, None),
                utxo(A, 180_000_000, 3, None),
            ],
            VAULT,
            r,
        );
        assert_eq!(g, vec![(beacon(A), 250_000_000)]);
        // spent AFTER ref ⇒ still counted; spent at/before ref ⇒ not.
        assert_eq!(
            observe_as_of(&[utxo(A, 200_000_000, 10, Some(1500))], VAULT, r),
            vec![(beacon(A), 200_000_000)]
        );
        assert!(observe_as_of(&[utxo(A, 200_000_000, 10, Some(1000))], VAULT, r).is_empty());
        assert!(observe_as_of(&[utxo(A, 200_000_000, 10, Some(500))], VAULT, r).is_empty());
        // created after ref ⇒ too fresh.
        assert!(observe_as_of(&[utxo(A, 200_000_000, 1500, None)], VAULT, r).is_empty());
        // zero-coin not credited; wrong policy empty.
        assert!(observe_as_of(&[utxo(A, 0, 1, None)], VAULT, r).is_empty());
        assert!(observe_as_of(
            &[utxo(A, 100_000_000, 1, None)],
            "ff".repeat(28).as_str(),
            r
        )
        .is_empty());
    }

    #[test]
    fn observe_as_of_is_canonically_sorted_and_independent_of_input_order() {
        let r = 1_000u64;
        let in_order = vec![
            utxo(A, 250_000_000, 10, None),
            utxo(B, 150_000_000, 20, None),
        ];
        let shuffled = vec![
            utxo(B, 150_000_000, 20, None),
            utxo(A, 100_000_000, 9, None), // smaller dup of A — dropped by largest-wins
            utxo(A, 250_000_000, 10, None),
            utxo(A, 999_999_999, 1500, None), // too fresh — excluded
        ];
        let a = observe_as_of(&in_order, VAULT, r);
        let b = observe_as_of(&shuffled, VAULT, r);
        assert_eq!(
            a, b,
            "same stable point ⇒ identical canonical output regardless of input order"
        );
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
    fn as_uint_strict_matches_the_js_regex_rejecting_a_leading_plus() {
        // The Rust↔JS parser parity fix: Rust's bare `u64::from_str` accepts a leading `+`, but the JS
        // `/^[0-9]+$/` does not — a coins / qty / slot one side accepts and the other drops would FORK the
        // read. as_u64/as_u128 now reject any non-pure-ASCII-digit string, matching observation.mjs.
        assert_eq!(as_u64(&json!("100")), Some(100));
        assert_eq!(as_u128(&json!("100000000")), Some(100_000_000));
        assert_eq!(as_u64(&json!(7)), Some(7)); // JSON number still accepted
        for bad in ["+1", " 1", "1 ", "0x1", "1.0", "-1", "", "1_0", "abc"] {
            assert_eq!(
                as_u64(&json!(bad)),
                None,
                "as_u64 must reject {bad:?} (JS regex parity)"
            );
            assert_eq!(
                as_u128(&json!(bad)),
                None,
                "as_u128 must reject {bad:?} (JS regex parity)"
            );
        }
    }

    /// Cross-implementation observation determinism EQUIVALENCE regression (mirrors Midnight's
    /// primitives/mainchain-follower/tests/cnight_equivalence.rs cross-implementation equality test).
    ///
    /// Loads the committed golden fixture (`src/fixtures/observation-equivalence.json`) and, for each case,
    /// re-derives `observe_as_of` and SCALE-encodes the canonical `(reference_slot, entries)` structure,
    /// asserting it equals the golden BYTE-FOR-BYTE. The golden was generated from the canonical
    /// observation.mjs spec; after this consolidation, THIS crate is the canonical spec and the node writer +
    /// the CLI reader both call these functions, so a divergence here is a chain FORK. The SCALE encoding
    /// of `(u64, Vec<([u8;32], u128)>)` is `u64` LE ++ compact-len ++ per entry `[u8;32]` ++ `u128` LE.
    #[test]
    fn rust_matches_js_observation_equivalence_fixture() {
        use codec::Encode;
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fixtures/observation-equivalence.json"
        );
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("read equivalence fixture {path}: {e}"));
        let fixture: serde_json::Value =
            serde_json::from_str(&text).expect("parse equivalence fixture JSON");
        let cases = fixture
            .get("cases")
            .and_then(|c| c.as_array())
            .expect("fixture.cases is an array");
        assert!(
            !cases.is_empty(),
            "equivalence fixture must have at least one case"
        );

        for case in cases {
            let name = case.get("name").and_then(|v| v.as_str()).unwrap_or("?");
            let vault = case
                .get("vaultHash")
                .and_then(|v| v.as_str())
                .expect("vaultHash");
            let reference_slot = as_u64(case.get("referenceSlot").expect("referenceSlot"))
                .expect("referenceSlot u64");
            let matches: Vec<serde_json::Value> = case
                .get("matches")
                .and_then(|m| m.as_array())
                .cloned()
                .expect("matches array");

            let entries = observe_as_of(&matches, vault, reference_slot);

            // 1. the reduced entries match the golden, value-for-value, in the canonical (ascending-by-
            //    beacon-bytes) order BTreeMap yields — the same order observeAsOf+sort yields in JS.
            let expected_entries = case
                .get("expectedEntries")
                .and_then(|e| e.as_array())
                .expect("expectedEntries");
            assert_eq!(
                entries.len(),
                expected_entries.len(),
                "case {name}: observed entry count diverges from the golden",
            );
            for ((beacon, lovelace), exp) in entries.iter().zip(expected_entries) {
                let exp = exp
                    .as_array()
                    .expect("expectedEntries entry is [hex, lovelaceString]");
                let exp_hex = exp[0].as_str().expect("beacon hex");
                let exp_lovelace: u128 = exp[1]
                    .as_str()
                    .expect("lovelace string")
                    .parse()
                    .expect("u128");
                assert_eq!(
                    hex_encode(beacon),
                    exp_hex,
                    "case {name}: beacon diverges from the golden"
                );
                assert_eq!(
                    *lovelace, exp_lovelace,
                    "case {name}: lovelace diverges from the golden"
                );
            }

            // 2. THE HEADLINE: the canonical SCALE bytes equal the golden byte-for-byte.
            let canonical = (reference_slot, entries).encode();
            let got = hex_encode(&canonical);
            let expected = case
                .get("expectedCanonicalHex")
                .and_then(|v| v.as_str())
                .expect("expectedCanonicalHex");
            assert_eq!(
				got, expected,
				"case {name}: canonical SCALE bytes DIVERGE from the golden — a cross-node determinism fork \
				 (regenerate the fixture only on a deliberate reduction change)",
			);

            // 3. the input-commitment PRE-IMAGE bytes equal the golden — so blake2_256 of them (the
            //    inputs_commitment carried in the inherent) is identical cross-node. A divergence here would
            //    make the Mismatch/ComputeDiverged taxonomy misfire under binary version skew.
            let got_cand = hex_encode(&candidate_bytes(&matches, vault));
            let expected_cand = case
                .get("expectedCandidateHex")
                .and_then(|v| v.as_str())
                .expect("expectedCandidateHex");
            assert_eq!(
                got_cand, expected_cand,
                "case {name}: candidate pre-image bytes DIVERGE from the candidateBytes golden",
            );
        }
    }

    #[test]
    fn canonical_stake_entries_sorts_ascending_by_credential_bytes() {
        // Same ascending-by-28-bytes order the runtime BTreeMap compares against, independent of input
        // order — so author + importer SCALE-encode the stake observation identically.
        let s1: StakeCredential = [0xC1; 28];
        let s2: StakeCredential = [0xC2; 28];
        let out = canonical_stake_entries(vec![(s2, 300), (s1, 800)]);
        assert_eq!(
            out,
            vec![(s1, 800), (s2, 300)],
            "sorted ascending by credential bytes"
        );
        // duplicate credential collapses (last-wins), as the BTreeMap collect does.
        assert_eq!(
            canonical_stake_entries(vec![(s1, 1), (s1, 9)]),
            vec![(s1, 9)]
        );
    }
}
