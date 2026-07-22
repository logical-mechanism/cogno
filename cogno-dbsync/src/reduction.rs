//! The PURE, deterministic reduction half of the Cardano observation — no IO, no `sc-*`, no node.
//!
//! This crate IS the spec. It used to be mirrored across a JS and a Python implementation; those are gone,
//! so these functions are the single definition of how Cardano state reduces to on-chain weight. Both node
//! paths call them: the observation `InherentDataProvider` (the consensus WRITER) and the boot-time
//! `config_check` probe (read-only). A divergence here is a chain FORK, which is what the golden fixture
//! ([`reduction_matches_the_golden_determinism_fixture`]) exists to catch.

use crate::calidus;
use codec::Encode;
use pallet_cardano_observer::{
    BeaconName, CardanoObservation, CardanoRef, RoleEntry, RoleSource, StakeCredential,
};
use std::collections::{BTreeMap, BTreeSet};

/// Map a stable wall-clock time (unix seconds, from the PARENT block) to the Cardano slot to observe
/// AS-OF: `(Shelley slot at that time) − stability_window`. Fail-closed (`None`) on a pre-Shelley /
/// wrong-network / underflowing input ⇒ the caller emits no observation. Port of `cardanoReferenceSlot`
/// Checked arithmetic throughout, since a naive `u64` subtraction would WRAP under the wasm runtime's
/// overflow-checks-off release build — that is the determinism trap. Only 1 s Shelley slots; the anchor
/// MUST be the Shelley start, NOT Byron `systemStart`.
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

/// The blank (all-zero) display id an `SpoCalidus` entry carries INSTEAD of a pool id. A Calidus
/// registration attests no specific pool (any pool's cold key can declare any Calidus key), so the badge
/// names none — the FE renders a generic "verified SPO". A real 28-byte poolID is `blake2b_224(cold pubkey)`
/// and is never all-zero, so this can never collide with an `SpoOwner` pool id.
pub const BLANK_ROLE_ID: [u8; 28] = [0u8; 28];

/// Canonicalize the ROLE entries into a deterministic, deduplicated order (a `BTreeSet` over the whole
/// `(source, credential, id, weight)` tuple, so author + importer SCALE-encode identically; `weight` is
/// deterministic per `(source, id)`, so it never splits an otherwise-identical entry into two). Like the
/// stake path, this only fixes the order — a cross-node difference in the SET is a data `Mismatch`, never a
/// `ComputeDiverged`.
pub fn canonical_role_entries(raw: Vec<RoleEntry>) -> Vec<RoleEntry> {
    let set: BTreeSet<RoleEntry> = raw.into_iter().collect();
    set.into_iter().collect()
}

/// Reduce the raw ROLE read to the canonical `role_entries` the observation carries. PURE + deterministic
/// (the whole point — a divergence is a chain fork). Two SPO sources:
///
/// - **Calidus**: verify each label-867 registration's cold-key witness over its RAW bytes, take the
///   highest-nonce VERIFIED registration per pool (never an unverified one — a bogus high-nonce
///   registration would otherwise hijack a pool), and emit an `SpoCalidus` entry when that winner's
///   Calidus key is CLAIMED and the pool is ACTIVE. The (cheap) parse-only pre-filter bounds the ed25519
///   witness checks to registrations of pools that have a claimed key. The entry's display `id` is the
///   blank [`BLANK_ROLE_ID`] (never the pool) — a Calidus registration cannot attest a specific pool, so
///   naming one would be forgeable (see the emit loop). Multiple pools authorizing the same claimed key
///   therefore collapse to a single generic badge.
/// - **Owner (free path)**: `owner_pools` is already `(bound stake credential, the pool it owns)` from the
///   SQL; emit an `SpoOwner` entry for each whose pool is ACTIVE.
/// - **dRep**: `live_dreps` is already the set of CLAIMED, currently-live key-based dRep IDs from the SQL
///   (the liveness join runs in-DB, no witness). The dRep ID IS the credential AND the display id, so each
///   becomes a `DRep` entry directly. Nothing to verify here — the CIP-8 claim proved key control and the
///   SQL proved liveness.
///
/// `active_pools` is the set of currently-registered, non-retired pool IDs (as-of the reference), used to
/// gate both SPO paths on liveness.
///
/// `pool_stake` / `drep_stake` (spec 207) carry the delegated-stake CHAMBER WEIGHT for governance polls:
/// the owned pool's total delegated block-production stake, and the dRep's total delegated voting stake,
/// at the as-of epoch. Each becomes the corresponding `RoleEntry.weight` (looked up by id; absent ⇒ 0). A
/// `SpoCalidus` entry names no pool, so it carries weight 0.
pub fn reduce_role_observation(
    registrations: &[Vec<u8>],
    active_pools: &[[u8; 28]],
    owner_pools: &[([u8; 28], [u8; 28])],
    claimed_calidus: &[[u8; 28]],
    live_dreps: &[[u8; 28]],
    pool_stake: &[([u8; 28], u128)],
    drep_stake: &[([u8; 28], u128)],
) -> Vec<RoleEntry> {
    let active: BTreeSet<[u8; 28]> = active_pools.iter().copied().collect();
    let claimed: BTreeSet<[u8; 28]> = claimed_calidus.iter().copied().collect();
    let pool_weight: BTreeMap<[u8; 28], u128> = pool_stake.iter().copied().collect();
    let drep_weight: BTreeMap<[u8; 28], u128> = drep_stake.iter().copied().collect();
    let mut entries: Vec<RoleEntry> = Vec::new();

    // Pools that have ANY registration for a CLAIMED Calidus key (cheap parse, no witness).
    let claimed_pools: BTreeSet<[u8; 28]> = registrations
        .iter()
        .filter_map(|b| calidus::parse_registration(b).ok())
        .filter(|p| claimed.contains(&p.calidus_key_hash))
        .map(|p| p.pool_id)
        .collect();

    // Highest-nonce VERIFIED registration per claimed pool.
    let mut winner: BTreeMap<[u8; 28], calidus::CalidusRegistration> = BTreeMap::new();
    for b in registrations.iter() {
        let pre = match calidus::parse_registration(b) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !claimed_pools.contains(&pre.pool_id) {
            continue; // only verify registrations of a pool with a claimed key (bounds ed25519 cost)
        }
        let reg = match calidus::verify_registration(b) {
            Ok(r) => r,
            Err(_) => continue, // a bad witness is dropped and can never be a highest-nonce winner
        };
        let take = match winner.get(&reg.pool_id) {
            Some(w) => reg.nonce > w.nonce,
            None => true,
        };
        if take {
            winner.insert(reg.pool_id, reg);
        }
    }
    // A Calidus registration is authorized by the pool COLD key ALONE — the Calidus key never
    // counter-signs it (CIP-0151 / CIP-88-v2 define no proof-of-possession for the declared Calidus key),
    // so a pool can declare ANY public Calidus key, including a victim's (recoverable from the victim's
    // on-chain claim). If we named the pool on the badge, a pool operator could attribute their OWN pool to
    // any account that had claimed that Calidus key (cross-pool impersonation). We close that by attesting
    // only what the proof actually establishes — "controls a Calidus key that a currently-live pool
    // authorized" — and NOT a specific pool: the emitted display `id` is the blank marker [`BLANK_ROLE_ID`],
    // never the pool. Every pool authorizing the same claimed key thus collapses to ONE generic SPO badge
    // (the observer dedups by (kind, id)), so no pool can be falsely attributed to the account. (The free
    // `SpoOwner` path below DOES name its pool — it is impersonation-proof, since Cardano requires each
    // declared owner's stake-key witness at pool registration.) The badge is display-only.
    for (pool_id, reg) in winner.iter() {
        if claimed.contains(&reg.calidus_key_hash) && active.contains(pool_id) {
            entries.push(RoleEntry {
                source: RoleSource::SpoCalidus,
                credential: reg.calidus_key_hash,
                id: BLANK_ROLE_ID, // NOT the pool — a Calidus registration attests no specific pool (see above)
                weight: 0,         // the blank badge names no pool ⇒ no chamber weight
            });
        }
    }

    // The free path: a bound stake key that owns a live pool. The chamber weight is that pool's total
    // delegated stake at the as-of epoch (0 for an undelegated pool).
    for (stake_cred, pool_id) in owner_pools.iter() {
        if active.contains(pool_id) {
            entries.push(RoleEntry {
                source: RoleSource::SpoOwner,
                credential: *stake_cred,
                id: *pool_id,
                weight: pool_weight.get(pool_id).copied().unwrap_or(0),
            });
        }
    }

    // dRep: the SQL already scoped `live_dreps` to CLAIMED + currently-live key-based dReps, and a dRep's
    // credential IS its display id — so each is emitted directly (no witness, no liveness re-check here).
    // The chamber weight is the dRep's total delegated voting stake at the as-of epoch (0 if it has none).
    for drep_id in live_dreps.iter() {
        entries.push(RoleEntry {
            source: RoleSource::DRep,
            credential: *drep_id,
            id: *drep_id,
            weight: drep_weight.get(drep_id).copied().unwrap_or(0),
        });
    }

    canonical_role_entries(entries)
}

/// Build the full observation (reference + input commitment + canonical vault entries + canonical
/// voting-power stake entries + canonical role entries) from the vault matches, the raw per-credential
/// `epoch_stake` totals, and the already-reduced role entries.
pub fn build_observation(
    reference: CardanoRef,
    matches: &[serde_json::Value],
    vault_hash: &str,
    stake_entries: Vec<(StakeCredential, u128)>,
    role_entries: Vec<RoleEntry>,
) -> CardanoObservation {
    let slot = reference.slot;
    CardanoObservation {
        reference,
        inputs_commitment: inputs_commitment(matches, vault_hash),
        entries: observe_as_of(matches, vault_hash, slot),
        stake_entries: canonical_stake_entries(stake_entries),
        role_entries: canonical_role_entries(role_entries),
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

    /// Byte-exact determinism regression on the canonical SCALE output.
    ///
    /// Loads the committed golden fixture (`src/fixtures/observation-equivalence.json`) and, for each case,
    /// re-derives `observe_as_of` and SCALE-encodes the canonical `(reference_slot, entries)` structure,
    /// asserting it equals the golden BYTE-FOR-BYTE. The golden values were produced by the original JS
    /// reference implementation, which was retired in the all-Rust consolidation — so this is a frozen-golden
    /// guard, not a live two-implementation equivalence check. Its job is to make ANY change to the reduction
    /// output fail loudly: a divergence is a chain fork. The SCALE encoding of `(u64, Vec<([u8;32], u128)>)`
    /// is `u64` LE ++ compact-len ++ per entry `[u8;32]` ++ `u128` LE.
    #[test]
    fn reduction_matches_the_golden_determinism_fixture() {
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

    // ── role reduction ───────────────────────────────────────────────────────────────────────────
    mod roles {
        use super::super::*;
        use ed25519_dalek::{Signer, SigningKey};

        fn head(m: u8, a: u64) -> Vec<u8> {
            let mt = m << 5;
            if a <= 23 {
                vec![mt | a as u8]
            } else if a <= 0xff {
                vec![mt | 24, a as u8]
            } else {
                let x = a as u16;
                vec![mt | 25, (x >> 8) as u8, x as u8]
            }
        }
        fn u(n: u64) -> Vec<u8> {
            head(0, n)
        }
        fn bs(b: &[u8]) -> Vec<u8> {
            let mut v = head(2, b.len() as u64);
            v.extend_from_slice(b);
            v
        }
        fn arr(items: &[Vec<u8>]) -> Vec<u8> {
            let mut v = head(4, items.len() as u64);
            for i in items {
                v.extend_from_slice(i);
            }
            v
        }
        fn map(p: &[(Vec<u8>, Vec<u8>)]) -> Vec<u8> {
            let mut v = head(5, p.len() as u64);
            for (k, val) in p {
                v.extend_from_slice(k);
                v.extend_from_slice(val);
            }
            v
        }
        fn b224(x: &[u8]) -> [u8; 28] {
            use blake2::digest::{Update, VariableOutput};
            let mut o = [0u8; 28];
            let mut h = blake2::Blake2bVar::new(28).unwrap();
            h.update(x);
            h.finalize_variable(&mut o).unwrap();
            o
        }

        /// Build a valid label-867 registration for `(cold, calidus, nonce)`; returns
        /// `(bytes, pool_id, calidus_hash)`.
        fn reg(cold_seed: u8, cal_seed: u8, nonce: u64) -> (Vec<u8>, [u8; 28], [u8; 28]) {
            let cold = SigningKey::from_bytes(&[cold_seed; 32]);
            let cold_pk = cold.verifying_key().to_bytes();
            let cal = SigningKey::from_bytes(&[cal_seed; 32]);
            let cal_pk = cal.verifying_key().to_bytes();
            let pool = b224(&cold_pk);
            let payload = map(&[
                (u(1), arr(&[u(1), bs(&pool)])),
                (u(2), arr(&[])),
                (u(3), arr(&[u(0)])),
                (u(4), u(nonce)),
                (u(7), bs(&cal_pk)), // Calidus key: a raw 32-byte bstr (cardano-signer's on-chain form)
            ]);
            // CIP-88-v2 preimage: blake2b-256 of the RAW payload CBOR (not a hex-encoding of it).
            let preimage = sp_crypto_hashing::blake2_256(&payload);
            let sig = cold.sign(&preimage).to_bytes();
            let witness = arr(&[map(&[(u(0), u(0)), (u(1), bs(&cold_pk)), (u(2), bs(&sig))])]);
            let full = map(&[(u(0), u(2)), (u(1), payload), (u(2), witness)]);
            (full, pool, b224(&cal_pk))
        }

        #[test]
        fn spo_calidus_happy_path() {
            let (bytes, pool, cal_hash) = reg(1, 2, 5);
            let out = reduce_role_observation(&[bytes], &[pool], &[], &[cal_hash], &[], &[], &[]);
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].source, RoleSource::SpoCalidus);
            assert_eq!(out[0].credential, cal_hash);
            // The Calidus badge names NO pool (the blank marker) — a Calidus reg can't attest one.
            assert_eq!(out[0].id, BLANK_ROLE_ID);
            // …and names no pool ⇒ carries no chamber weight, even if the pool is huge.
            assert_eq!(out[0].weight, 0);
        }

        #[test]
        fn inactive_pool_is_not_tagged() {
            let (bytes, _pool, cal_hash) = reg(1, 2, 5);
            // pool NOT in active_pools ⇒ dropped.
            assert!(
                reduce_role_observation(&[bytes], &[], &[], &[cal_hash], &[], &[], &[]).is_empty()
            );
        }

        #[test]
        fn unclaimed_calidus_is_not_tagged() {
            let (bytes, pool, _cal_hash) = reg(1, 2, 5);
            // claimed set empty ⇒ nothing verified/emitted.
            assert!(reduce_role_observation(&[bytes], &[pool], &[], &[], &[], &[], &[]).is_empty());
        }

        #[test]
        fn highest_nonce_verified_registration_wins() {
            // Same pool (cold seed 1), two Calidus keys: seed 2 @ nonce 5, seed 3 @ nonce 9 (rotation).
            let (r5, pool, cal5) = reg(1, 2, 5);
            let (r9, _pool, cal9) = reg(1, 3, 9);
            // A claim for the OLD (superseded) Calidus key is NOT tagged — the highest-nonce winner rotated.
            let old = reduce_role_observation(
                &[r5.clone(), r9.clone()],
                &[pool],
                &[],
                &[cal5],
                &[],
                &[],
                &[],
            );
            assert!(
                old.is_empty(),
                "a superseded Calidus key must not be tagged"
            );
            // A claim for the CURRENT (highest-nonce) key IS tagged (with a blank, no-pool display id).
            let new = reduce_role_observation(&[r5, r9], &[pool], &[], &[cal9], &[], &[], &[]);
            assert_eq!(new.len(), 1);
            assert_eq!(new[0].credential, cal9);
            assert_eq!(new[0].id, BLANK_ROLE_ID);
        }

        #[test]
        fn a_bogus_high_nonce_registration_cannot_hijack() {
            // The real pool (cold 1) registers Calidus key (seed 2) @ nonce 5.
            let (real, pool, cal_real) = reg(1, 2, 5);
            // An attacker forges a HIGHER-nonce registration scoping the SAME pool but signed with a
            // DIFFERENT cold key (seed 9) — its witness does not authorize `pool` (blake2b_224 mismatch).
            let (bogus, _bogus_pool, _cal_bogus) = reg(9, 8, 99);
            // Splice the bogus witness onto a payload scoping the real pool by re-scoping: simplest — the
            // attacker's registration scopes ITS OWN pool, so it can't affect the real pool. Confirm the
            // real claim still resolves and the bogus one is inert.
            let out =
                reduce_role_observation(&[real, bogus], &[pool], &[], &[cal_real], &[], &[], &[]);
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].credential, cal_real);
            assert_eq!(out[0].id, BLANK_ROLE_ID);
        }

        #[test]
        fn cross_pool_calidus_cannot_impersonate() {
            // The impersonation regression test (was a live PoC before the blank-id fix). The victim
            // operates pool P (cold seed 1) with Calidus key seed 2 and has CLAIMED hash(cal2). An ATTACKER
            // runs their OWN active pool Q (cold seed 9) and posts a label-867 registration for Q that
            // DECLARES the victim's Calidus key (seed 2) — validly signed by Q's cold key (the Calidus key
            // never counter-signs, so nothing on Cardano stops it).
            let (honest, pool_p, cal_hash) = reg(1, 2, 5);
            let (attacker, pool_q, cal_hash2) = reg(9, 2, 5); // same Calidus seed 2, different cold key
            assert_eq!(
                cal_hash, cal_hash2,
                "same Calidus key ⇒ same claimed credential"
            );
            assert_ne!(pool_p, pool_q, "distinct pools");
            let out = reduce_role_observation(
                &[honest, attacker],
                &[pool_p, pool_q],
                &[],
                &[cal_hash],
                &[],
                &[],
                &[],
            );
            // BEFORE the fix this emitted {hash, P} AND {hash, Q} (the victim badged for the attacker's
            // pool). Now both carry the blank id, so they collapse to ONE generic SPO entry that names no
            // pool — the attacker's pool can no longer be attributed to the victim.
            assert_eq!(out.len(), 1, "the two pools collapse to one generic badge");
            assert_eq!(out[0].source, RoleSource::SpoCalidus);
            assert_eq!(out[0].credential, cal_hash);
            assert_eq!(out[0].id, BLANK_ROLE_ID);
            assert_ne!(out[0].id, pool_p, "names neither pool");
            assert_ne!(out[0].id, pool_q, "names neither pool");
        }

        #[test]
        fn owner_free_path() {
            let stake: [u8; 28] = [0x33; 28];
            let pool: [u8; 28] = [0x44; 28];
            // The owned pool has 15_000_000 ADA delegated → that becomes the SpoOwner chamber weight.
            let out = reduce_role_observation(
                &[],
                &[pool],
                &[(stake, pool)],
                &[],
                &[],
                &[(pool, 15_000_000_000_000)],
                &[],
            );
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].source, RoleSource::SpoOwner);
            assert_eq!(out[0].credential, stake);
            assert_eq!(out[0].id, pool);
            assert_eq!(
                out[0].weight, 15_000_000_000_000,
                "SpoOwner carries its pool's total delegated stake as the chamber weight"
            );
            // An owned pool absent from the stake sum (no delegators) ⇒ 0 chamber weight (present, not
            // dropped): the SPO still gets a badge, just with no weight.
            let z = reduce_role_observation(&[], &[pool], &[(stake, pool)], &[], &[], &[], &[]);
            assert_eq!(z.len(), 1);
            assert_eq!(z[0].weight, 0);
            // inactive pool ⇒ no free tag.
            assert!(
                reduce_role_observation(&[], &[], &[(stake, pool)], &[], &[], &[], &[]).is_empty()
            );
        }

        #[test]
        fn drep_live_set_is_tagged_directly() {
            // The SQL already returned only CLAIMED + currently-live key-based dReps; the reduction emits
            // each as a `DRep` entry whose credential IS its display id. No pool/active gating applies.
            let d1: [u8; 28] = [0xD1; 28];
            let d2: [u8; 28] = [0xD2; 28];
            // d1 has delegated voting stake; d2 has none.
            let out =
                reduce_role_observation(&[], &[], &[], &[], &[d1, d2], &[], &[(d1, 42_000_000)]);
            assert_eq!(out.len(), 2);
            for e in &out {
                assert_eq!(e.source, RoleSource::DRep);
                assert_eq!(e.credential, e.id); // dRep: credential == display id
            }
            assert!(out.iter().any(|e| e.id == d1));
            assert!(out.iter().any(|e| e.id == d2));
            // the dRep chamber weight is that dRep's delegated voting stake (absent ⇒ 0).
            assert_eq!(out.iter().find(|e| e.id == d1).unwrap().weight, 42_000_000);
            assert_eq!(out.iter().find(|e| e.id == d2).unwrap().weight, 0);
            // an empty live set ⇒ no dRep tag.
            assert!(reduce_role_observation(&[], &[], &[], &[], &[], &[], &[]).is_empty());
        }
    }
}
