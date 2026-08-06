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
pub(crate) fn as_u64(v: &serde_json::Value) -> Option<u64> {
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
///   registration would otherwise hijack a pool), and emit an `SpoCalidus` entry — stamped with THAT
///   pool's id and delegated stake — for every live pool whose winner names a CLAIMED Calidus key. The
///   (cheap) parse-only pre-filter bounds the ed25519 witness checks to registrations of pools that have a
///   claimed key. An mSPO (one operator, several pools declaring the same key from their own cold keys)
///   yields one entry PER pool; the chamber tally dedups by pool, so the per-pool weights SUM to the
///   operator's true governance stake. Soundness rests on each declaration being cold-key-signed (see the
///   emit loop for the full argument, incl. the cosmetic display-only ticker edge).
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
/// The LIVE pools that have ANY label-867 registration declaring one of the CLAIMED Calidus keys — a
/// cheap, parse-only pass (NO witness verification). This is exactly the set the node service must UNION
/// into the owned pools when scoping the `pool_stake` read, AND the set [`reduce_role_observation`]
/// restricts its (expensive) witness verification to. Both call this ONE definition so the two crates can
/// never drift: if the service scoped `pool_stake` to a smaller set than the reduction emits, a Calidus
/// SPO's chamber weight would silently read 0. The result is a `BTreeSet` (sorted + deduped ⇒
/// byte-deterministic query input). Order-independent of the registration order.
///
/// `active_pools` is what makes this set BOUNDED, and it is load-bearing for two reasons.
///
/// The `pool_id` inside a registration is free-form attacker-chosen bytes: `parse_registration` is
/// witness-free by design (that is the point of the cheap pass), and anyone can publish label-867
/// metadata naming any 28 bytes alongside a Calidus key that is already claimed on-chain — a claimed key
/// hash is public, so no victim cooperation is needed. Without the liveness filter every such row landed
/// in the `pool_stake` query's `= ANY(...)` array PERMANENTLY, on every node, for a few lovelace a row:
/// the one per-block query input with no cap, growing until it blew the 2 s db-sync timeout and froze the
/// sole writer of Cardano weight chain-wide.
///
/// It also bounds the ed25519 cost this set is supposed to gate. `witness_authorizes_ed25519` only
/// reaches `verify_strict` for a witness whose `blake2b_224(pubkey)` equals the `pool_id`, so restricting
/// the gate to pools that really exist means an attacker cannot reach the expensive path at all without
/// that pool's COLD key. Gating on the pool alone was what let a single setup row open that lane.
///
/// Filtering here CANNOT change which entries are emitted: [`reduce_role_observation`]'s `SpoCalidus`
/// arm already requires `active.contains(pool_id)` before pushing, so a pool this filter removes could
/// never have produced an entry. It shrinks the query scope and the verification gate, nothing else —
/// which is exactly why it is safe to apply on both sides of a consensus read.
pub fn claimed_calidus_pools(
    registrations: &[Vec<u8>],
    claimed_calidus: &[[u8; 28]],
    active_pools: &[[u8; 28]],
) -> BTreeSet<[u8; 28]> {
    let claimed: BTreeSet<[u8; 28]> = claimed_calidus.iter().copied().collect();
    let active: BTreeSet<[u8; 28]> = active_pools.iter().copied().collect();
    registrations
        .iter()
        .filter_map(|b| calidus::parse_registration(b).ok())
        .filter(|p| claimed.contains(&p.calidus_key_hash))
        .map(|p| p.pool_id)
        .filter(|pool| active.contains(pool))
        .collect()
}

/// Where a certificate sits in Cardano's own order, as db-sync records it: `(tx.id, cert_index)`.
///
/// `tx.id` is a db-sync surrogate, not a chain field, and it is used here for the same reason
/// [`ROLE_OBSERVATION_SQL`](crate::dbsync)'s `active` CTE already compares `ret.tx_id < reg.tx_id`: ids
/// are assigned in insertion order, insertion follows block order, so `tx.id` is MONOTONIC in
/// `(block.slot_no, tx.block_index)` on any correctly-synced instance. The reduction only ever COMPARES
/// two of these against each other and never stores one, so what crosses consensus is the *outcome* —
/// "this de-registration is newer than this registration" — which is a fact about the chain, identical
/// on every node, whatever integers the two instances happened to assign.
pub type CertOrder = (u64, u32);

/// One SITTING Constitutional Committee member, identified by its COLD credential.
///
/// "Sitting" is doing real work: the SQL takes this set from `epoch_state.committee_id` at the as-of
/// epoch, which is the only authoritative source. `committee_member` on its own is not membership —
/// a `committee` row is created by every gov-action *proposal*, enacted or not, and on live preprod
/// every key-hash member credential belongs to a committee that was proposed and never enacted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitteeMember {
    /// The 28-byte cold credential (`committee_hash.raw`).
    pub cold: [u8; 28],
    /// `committee_hash.has_script` — a script cold credential can never CIP-8-sign (see the emit loop).
    pub is_script: bool,
    /// The epoch this member's term ends. Per cardano-ledger (`committeeAcceptedRatio`) a member is
    /// expired iff `currentEpoch > expiry`, so they are still seated DURING the expiration epoch.
    pub expiration_epoch: u64,
}

/// One `committee_registration` certificate: a cold credential declaring the HOT credential it will
/// vote with. NOT proof of membership: cardano-ledger gates the certificate on `isCurrentMember ||
/// isPotentialFutureMember`, so the cold key need only be named in a LIVE `UpdateCommittee` PROPOSAL —
/// which anybody can raise, and which need never pass. All 648 767 rows on preprod are one such
/// proposal, expired at epoch 194 and never enacted. A registration is meaningful only once joined to a
/// member of the committee `epoch_state` actually seats.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitteeRegistration {
    pub cold: [u8; 28],
    /// The 28-byte hot credential. BARE — no CIP-129 header byte, matching what `claim_role_signed`
    /// stores in `RoleCredIndex[Committee]`. See `reduce_role_observation`'s CC arm.
    pub hot: [u8; 28],
    /// `committee_hash.has_script` for the HOT credential.
    pub hot_is_script: bool,
    pub order: CertOrder,
}

/// One `committee_de_registration` certificate: a cold credential withdrawing its hot credential.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitteeDeregistration {
    pub cold: [u8; 28],
    pub order: CertOrder,
}

/// The raw Constitutional-Committee material one db-sync snapshot yields, before reduction.
///
/// Deliberately NOT pre-joined. `members`, `registrations` and `deregistrations` arrive as three flat
/// lists and [`reduce_role_observation`] does the join itself, so every rule that decides a CC badge —
/// sitting-ness, term expiry, the script filter, newest-registration-wins, de-registration ordering —
/// lives in the pure, unit-testable half rather than in SQL. The SQL still narrows each list (to the
/// enacted committee, and to the newest certificate per sitting cold key) because 648 767 registration
/// rows cannot cross the wire every block; the reduction re-applies the same rules as defence in depth,
/// exactly as `observe_as_of` re-applies the vault read's spentness pre-filter.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommitteeRead {
    /// The as-of epoch, derived from the OBSERVED REFERENCE SLOT (`block.epoch_no` of the stable block
    /// at/under it) — never wall-clock, never `max(epoch_no)`. Two nodes disagreeing here is a fork.
    pub epoch: u64,
    pub members: Vec<CommitteeMember>,
    pub registrations: Vec<CommitteeRegistration>,
    pub deregistrations: Vec<CommitteeDeregistration>,
}

/// `pool_stake` / `drep_stake` (spec 207) carry the delegated-stake CHAMBER WEIGHT for governance polls:
/// a pool's total delegated block-production stake, and a dRep's total delegated voting stake, at the
/// as-of epoch. Each becomes the corresponding `RoleEntry.weight` (looked up by id; absent ⇒ 0). BOTH SPO
/// sources (`SpoOwner` and `SpoCalidus`) weight by their pool's stake, so `pool_stake` MUST cover the
/// Calidus-authorized pools, not just owned ones — the node service scopes the read to `owner_pools` ∪
/// [`claimed_calidus_pools`] before calling this.
///
/// The Constitutional Committee carries NO chamber weight — its `RoleEntry.weight` is always 0. A CC
/// member's on-chain power is a constitutionality veto, not a stake-weighted preference, so folding it
/// into a poll tally would misrepresent it. `pallet-microblog`'s chamber walk never writes a scratch row
/// for kind 2, which is the other half of the same decision.
// The parameter list is long because it is a FLAT enumeration of the raw db-sync material one snapshot
// yields, one axis at a time. Bundling it into a single struct would read better and cost something real:
// this is the consensus reduction, its inputs are what `check_inherent` ultimately agrees on, and a
// struct with a `Default` invites a caller to construct a PARTIAL one — an omitted axis then reduces to
// "nothing observed", which `derive_call` reads as CLEARED and applies as a mass badge-strip. Positional
// arguments make an omission a compile error instead. `CommitteeRead` is grouped because its four fields
// are one axis and are always built together by `parse_committee`.
#[allow(clippy::too_many_arguments)]
pub fn reduce_role_observation(
    registrations: &[Vec<u8>],
    active_pools: &[[u8; 28]],
    owner_pools: &[([u8; 28], [u8; 28])],
    claimed_calidus: &[[u8; 28]],
    live_dreps: &[[u8; 28]],
    pool_stake: &[([u8; 28], u128)],
    drep_stake: &[([u8; 28], u128)],
    committee: &CommitteeRead,
    claimed_committee: &[[u8; 28]],
) -> Vec<RoleEntry> {
    let active: BTreeSet<[u8; 28]> = active_pools.iter().copied().collect();
    let claimed: BTreeSet<[u8; 28]> = claimed_calidus.iter().copied().collect();
    let pool_weight: BTreeMap<[u8; 28], u128> = pool_stake.iter().copied().collect();
    let drep_weight: BTreeMap<[u8; 28], u128> = drep_stake.iter().copied().collect();
    let mut entries: Vec<RoleEntry> = Vec::new();

    // Pools that have ANY registration for a CLAIMED Calidus key (cheap parse, no witness). The SAME
    // derivation the node service unions into its `pool_stake` scope — shared so the two can never drift.
    let claimed_pools = claimed_calidus_pools(registrations, claimed_calidus, active_pools);

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
    // Emit ONE `SpoCalidus` entry PER live pool whose cold key authorized this claimed Calidus key, each
    // stamped with THAT pool's id and its total delegated (block-production) stake. An mSPO — one operator
    // running several pools, each declaring the SAME Calidus key from its OWN cold key — therefore yields
    // one entry per pool; the governance-poll chamber tally dedups by POOL id, so those per-pool weights SUM
    // into the operator's true aggregate: exactly the stake they would vote with on Cardano.
    //
    // SOUNDNESS — why summing every declaring pool is correct, and why there is deliberately NO "single
    // pool" guard: every label-867 registration is signed by the pool COLD key, so "pool P declares key K"
    // is cryptographic proof that P's node key authorized K. Weight is therefore always REAL on-chain
    // delegation — it cannot be fabricated. The highest-nonce-VERIFIED winner is unique per pool, so a
    // pool's stake resolves to at most ONE Calidus account and can never be double-counted across accounts
    // (the chamber tally additionally dedups by pool, covering any owner-path/Calidus-path overlap on the
    // same pool). To pull a pool's weight onto an account you would need that pool's cold key to declare a
    // key you hold — which you cannot forge — so an account only ever accumulates pools its operator
    // controls. Restricting an mSPO to a single pool would UNDER-count a real operator, so we attribute all.
    //
    // DISPLAY (the one residual edge, kept honest): the Calidus key never counter-signs the registration
    // (CIP-0151 / CIP-88-v2 define no proof-of-possession for the declared Calidus key), so a pool CAN
    // declare any public Calidus key, including a victim's (recoverable from the victim's on-chain claim).
    // That lets a pool operator make their pool's TICKER appear on an account that claimed a key they
    // declared — cosmetic/reputation only; it cannot inflate or steal vote weight (the soundness argument
    // above holds regardless of what is displayed). The badge is display-only and, unlike `SpoOwner`, is
    // CLAIM-BACKED (user-removable). The free `SpoOwner` path below is impersonation-proof end to end —
    // Cardano requires each declared owner's stake-key witness at pool registration.
    for (pool_id, reg) in winner.iter() {
        if claimed.contains(&reg.calidus_key_hash) && active.contains(pool_id) {
            entries.push(RoleEntry {
                source: RoleSource::SpoCalidus,
                credential: reg.calidus_key_hash,
                id: *pool_id, // the specific live pool whose cold key authorized this claimed Calidus key
                weight: pool_weight.get(pool_id).copied().unwrap_or(0), // that pool's delegated stake
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

    // ── Constitutional Committee. A BADGE ONLY: `weight` is 0, always, and no chamber exists for it.
    //
    // Unlike the dRep arm, none of this is resolved in SQL. The whole membership rule lives here so it
    // can be tested, and because every step of it is a place a wrong answer is silent rather than loud.
    //
    // Every fold below is ORDER-INDEPENDENT, and that is not defensive habit: `cc_members` / `cc_regs` /
    // `cc_deregs` come out of `json_agg` with no ORDER BY, so their order is the planner's to choose and
    // two nodes can legitimately receive the same rows shuffled. A fold that let input order pick a
    // winner would be a chain fork with no bad actor and no bug anywhere else.
    //
    // The seat map is keyed by the cold CREDENTIAL, but db-sync keys members by `committee_hash.id`, and
    // its unique constraint is on `(raw, has_script)` — so the SAME 28 bytes can legally appear twice,
    // once as a key hash and once as a script hash, and a committee proposal may name a credential
    // without proving anything about it. Duplicates are therefore merged rather than last-write-wins,
    // and merged CONSERVATIVELY: script if EITHER row is script (so an ambiguous credential earns no
    // badge), earliest expiry if they disagree. Both rules are commutative, so the result cannot depend
    // on which row arrived first. Zero such duplicates exist on live preprod; this is about what the
    // schema permits, not what it currently holds.
    let mut seat: BTreeMap<[u8; 28], CommitteeMember> = BTreeMap::new();
    for m in committee.members.iter() {
        seat.entry(m.cold)
            .and_modify(|w| {
                w.is_script |= m.is_script;
                w.expiration_epoch = w.expiration_epoch.min(m.expiration_epoch);
            })
            .or_insert_with(|| m.clone());
    }
    let claimed_cc: BTreeSet<[u8; 28]> = claimed_committee.iter().copied().collect();

    // Newest registration / de-registration per SITTING cold credential. The membership test is applied
    // FIRST and it is the load-bearing one. A registration certificate only proves the cold key was
    // named in a committee PROPOSAL (the ledger gates it on `isCurrentMember || isPotentialFutureMember`),
    // and a proposal need never pass: preprod's 648 767 rows resolve to 43 cold keys from one proposal
    // that expired at epoch 194 without ever being enacted. Reading the table as membership would badge
    // all 43.
    let mut newest_reg: BTreeMap<[u8; 28], &CommitteeRegistration> = BTreeMap::new();
    for reg in committee.registrations.iter() {
        if !seat.contains_key(&reg.cold) {
            continue; // not a sitting member — the certificate proves nothing
        }
        // The winner is picked on a TOTAL order — `(tx_id, cert_index)` and then the hot credential's
        // own bytes. `(tx_id, cert_index)` already identifies a certificate uniquely by construction
        // (a certificate is its position in a transaction, and live preprod holds 0 duplicate pairs
        // across all 648 767 rows), so the trailing key is unreachable on well-formed data. It is there
        // because a `>`-only comparison resolves a tie by keeping whichever row the planner happened to
        // emit first, which is precisely the input-order dependence this fold must not have.
        let key = |r: &CommitteeRegistration| (r.order, r.hot, r.hot_is_script);
        if newest_reg.get(&reg.cold).is_none_or(|w| key(reg) > key(w)) {
            newest_reg.insert(reg.cold, reg);
        }
    }
    let mut newest_dereg: BTreeMap<[u8; 28], CertOrder> = BTreeMap::new();
    for dereg in committee.deregistrations.iter() {
        if !seat.contains_key(&dereg.cold) {
            continue;
        }
        if newest_dereg
            .get(&dereg.cold)
            .is_none_or(|w| dereg.order > *w)
        {
            newest_dereg.insert(dereg.cold, dereg.order);
        }
    }

    for (cold, member) in seat.iter() {
        // The ledger expires a member iff `currentEpoch > expiry` (cardano-ledger `committeeAcceptedRatio`),
        // so the term runs THROUGH the expiration epoch. `committee.epoch` is derived from the observed
        // reference slot, never from wall-clock time and never from `max(epoch_no)`: this comparison is
        // consensus, and two nodes reading a different "now" is a chain fork. The filter is not optional —
        // db-sync keeps an expired member's row in `committee_member` (preprod's enacted committee 6 still
        // lists seven members whose term ended three epochs before it was enacted).
        if committee.epoch > member.expiration_epoch {
            continue;
        }
        let Some(reg) = newest_reg.get(cold) else {
            continue; // seated but has never named a hot credential
        };
        // The SCRIPT filter, and it applies to the HOT credential ONLY.
        //
        // A script credential cannot produce a CIP-8 signature, so it can never be claimed and can never
        // appear in `RoleCredIndex[Committee]`; an entry for one is dead payload in a
        // `MaxChangesPerBlock`-paged delta. That argument is about the credential the member SIGNS with,
        // which is the hot one. The COLD credential never signs anything on cogno — it authorized the
        // hot key on Cardano and is not stored here — so filtering it as well would deny the badge to a
        // member holding a script (multisig) cold credential and a plain key-hash hot one. That is not a
        // hypothetical: splitting a hardened cold credential from a single-key hot one is exactly the
        // key hygiene the Cardano CC guidance encourages, and every member seated on preprod today
        // already uses a script cold credential.
        //
        // ⚠ REMOVE THIS FILTER TOO if the proof scheme ever gains script support (a CIP-1854 multisig or
        // a Plutus-witnessed claim); until then it is the honest statement of what can be claimed.
        //
        // All three CC members sitting on preprod today have script HOT keys, so a correct implementation
        // emits NOTHING against live preprod. That is the expected result, not a bug.
        if reg.hot_is_script {
            continue;
        }
        // Ordered against the registration, not merely present: a cold key may resign and later
        // re-register, so only a de-registration NEWER than the winning registration withdraws it.
        if newest_dereg.get(cold).is_some_and(|d| *d > reg.order) {
            continue;
        }
        // Scoped to the CLAIMED set, and this is not just an optimization. `claimed_committee` is the
        // roles-pallet's `RoleCredIndex[Committee]` restricted to THIS BLOCK'S scan window, the same
        // window `claimed_calidus` / `claimed_dreps` / the bound stake set come from. `RoleSink::set_roles`
        // is a whole-set OVERWRITE keyed by account, so an entry naming an account outside the window
        // would be aggregated on its own and written back having dropped that account's SPO and dRep
        // badges — and their chamber weight with them. Emitting only claimed-and-in-window credentials is
        // what keeps an account wholly in or wholly out of scope.
        if !claimed_cc.contains(&reg.hot) {
            continue;
        }
        entries.push(RoleEntry {
            source: RoleSource::Committee,
            credential: reg.hot, // BARE 28 bytes — byte-identical to what `claim_role_signed` stored
            id: reg.hot,         // for CC the credential IS the display id
            weight: 0,           // a CC badge carries no chamber weight, by design
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
        pub(super) fn u(n: u64) -> Vec<u8> {
            head(0, n)
        }
        pub(super) fn bs(b: &[u8]) -> Vec<u8> {
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
        /// The pre-committee arity, for every test that predates the CC axis: an empty
        /// [`CommitteeRead`] and an empty claimed set, which must leave the SPO/dRep result untouched.
        fn reduce_no_committee(
            registrations: &[Vec<u8>],
            active_pools: &[[u8; 28]],
            owner_pools: &[([u8; 28], [u8; 28])],
            claimed_calidus: &[[u8; 28]],
            live_dreps: &[[u8; 28]],
            pool_stake: &[([u8; 28], u128)],
            drep_stake: &[([u8; 28], u128)],
        ) -> Vec<RoleEntry> {
            reduce_role_observation(
                registrations,
                active_pools,
                owner_pools,
                claimed_calidus,
                live_dreps,
                pool_stake,
                drep_stake,
                &CommitteeRead::default(),
                &[],
            )
        }

        pub(super) fn b224(x: &[u8]) -> [u8; 28] {
            use blake2::digest::{Update, VariableOutput};
            let mut o = [0u8; 28];
            let mut h = blake2::Blake2bVar::new(28).unwrap();
            h.update(x);
            h.finalize_variable(&mut o).unwrap();
            o
        }

        /// Build a valid label-867 registration for `(cold, calidus, nonce)`; returns
        /// `(bytes, pool_id, calidus_hash)`.
        pub(super) fn reg(
            cold_seed: u8,
            cal_seed: u8,
            nonce: u64,
        ) -> (Vec<u8>, [u8; 28], [u8; 28]) {
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
            // Case (a): ONE live pool declares a claimed key ⇒ SpoCalidus { id: pool, weight: pool stake }.
            let (bytes, pool, cal_hash) = reg(1, 2, 5);
            // The pool has 12_000_000 ADA delegated → that becomes the SpoCalidus chamber weight.
            let out = reduce_no_committee(
                &[bytes],
                &[pool],
                &[],
                &[cal_hash],
                &[],
                &[(pool, 12_000_000_000_000)],
                &[],
            );
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].source, RoleSource::SpoCalidus);
            assert_eq!(out[0].credential, cal_hash);
            // The Calidus badge now names the SPECIFIC live pool whose cold key authorized the key…
            assert_eq!(out[0].id, pool);
            // …and carries THAT pool's delegated stake as its chamber weight (the mSPO governance model).
            assert_eq!(out[0].weight, 12_000_000_000_000);
            // A confirmed Calidus whose pool has no stake row ⇒ 0 weight (present, not dropped).
            let (b2, pool2, cal2) = reg(3, 4, 1);
            let z = reduce_no_committee(&[b2], &[pool2], &[], &[cal2], &[], &[], &[]);
            assert_eq!(z.len(), 1);
            assert_eq!(z[0].id, pool2);
            assert_eq!(z[0].weight, 0);
        }

        #[test]
        fn inactive_pool_is_not_tagged() {
            let (bytes, _pool, cal_hash) = reg(1, 2, 5);
            // pool NOT in active_pools ⇒ dropped.
            assert!(reduce_no_committee(&[bytes], &[], &[], &[cal_hash], &[], &[], &[]).is_empty());
        }

        #[test]
        fn unclaimed_calidus_is_not_tagged() {
            let (bytes, pool, _cal_hash) = reg(1, 2, 5);
            // claimed set empty ⇒ nothing verified/emitted.
            assert!(reduce_no_committee(&[bytes], &[pool], &[], &[], &[], &[], &[]).is_empty());
        }

        #[test]
        fn highest_nonce_verified_registration_wins() {
            // Same pool (cold seed 1), two Calidus keys: seed 2 @ nonce 5, seed 3 @ nonce 9 (rotation).
            let (r5, pool, cal5) = reg(1, 2, 5);
            let (r9, _pool, cal9) = reg(1, 3, 9);
            // A claim for the OLD (superseded) Calidus key is NOT tagged — the highest-nonce winner rotated.
            let old = reduce_no_committee(
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
            // A claim for the CURRENT (highest-nonce) key IS tagged, naming the pool that rotated to it.
            let new = reduce_no_committee(&[r5, r9], &[pool], &[], &[cal9], &[], &[], &[]);
            assert_eq!(new.len(), 1);
            assert_eq!(new[0].credential, cal9);
            assert_eq!(new[0].id, pool);
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
            let out = reduce_no_committee(&[real, bogus], &[pool], &[], &[cal_real], &[], &[], &[]);
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].credential, cal_real);
            assert_eq!(out[0].id, pool);
        }

        #[test]
        fn two_pools_declaring_one_key_each_get_their_own_entry() {
            // Two DISTINCT pools declare the SAME Calidus key from their OWN cold keys — the legitimate mSPO
            // shape (one operator, two pools), which is ALSO the shape a display-only cross-pool cosmetic
            // takes. Pool P (cold seed 1) and pool Q (cold seed 9) both declare Calidus seed 2; the account
            // claimed hash(cal2).
            let (reg_p, pool_p, cal_hash) = reg(1, 2, 5);
            let (reg_q, pool_q, cal_hash2) = reg(9, 2, 5); // same Calidus seed 2, different cold key
            assert_eq!(
                cal_hash, cal_hash2,
                "same Calidus key ⇒ same claimed credential"
            );
            assert_ne!(pool_p, pool_q, "distinct pools");
            let out = reduce_no_committee(
                &[reg_p, reg_q],
                &[pool_p, pool_q],
                &[],
                &[cal_hash],
                &[],
                &[(pool_p, 3_000_000), (pool_q, 4_000_000)],
                &[],
            );
            // Each cold-key-signed declaration yields its OWN pool-named entry (weight = that pool's stake).
            // For a real mSPO the chamber tally then SUMS the two pools; a cosmetic cross-pool declaration is
            // DISPLAY-only and cannot inflate or steal weight — the operator can only spend their OWN pool's
            // governance weight, and a pool resolves to at most one Calidus account (the per-pool highest-
            // nonce winner), so no pool is ever double-counted across accounts.
            assert_eq!(out.len(), 2, "one entry per declaring pool");
            for e in &out {
                assert_eq!(e.source, RoleSource::SpoCalidus);
                assert_eq!(e.credential, cal_hash);
            }
            assert_eq!(
                out.iter().find(|e| e.id == pool_p).map(|e| e.weight),
                Some(3_000_000)
            );
            assert_eq!(
                out.iter().find(|e| e.id == pool_q).map(|e| e.weight),
                Some(4_000_000)
            );
        }

        #[test]
        fn mspo_emits_one_entry_per_declaring_pool_with_its_own_stake() {
            // Case (b), reduction half — the load-bearing mSPO edge: ONE operator runs THREE pools P1,P2,P3,
            // each declaring the SAME Calidus key K from its OWN cold key. The account claimed hash(K).
            let (r1, p1, cal) = reg(1, 7, 5);
            let (r2, p2, cal2) = reg(2, 7, 5);
            let (r3, p3, cal3) = reg(3, 7, 5);
            assert_eq!(cal, cal2);
            assert_eq!(cal, cal3);
            assert!(p1 != p2 && p2 != p3 && p1 != p3, "three distinct pools");
            let out = reduce_no_committee(
                &[r1, r2, r3],
                &[p1, p2, p3],
                &[],
                &[cal],
                &[],
                &[(p1, 1_000_000), (p2, 2_000_000), (p3, 3_000_000)],
                &[],
            );
            // Three SpoCalidus entries, one per pool, each carrying its OWN pool id + delegated stake. The
            // chamber tally (pallet-microblog) dedups by pool and SUMS them to 6_000_000 across a distinct
            // pool count of 3 — asserted in the microblog governance-poll test.
            assert_eq!(out.len(), 3);
            for e in &out {
                assert_eq!(e.source, RoleSource::SpoCalidus);
                assert_eq!(e.credential, cal);
            }
            let w = |pool: [u8; 28]| out.iter().find(|e| e.id == pool).map(|e| e.weight);
            assert_eq!(w(p1), Some(1_000_000));
            assert_eq!(w(p2), Some(2_000_000));
            assert_eq!(w(p3), Some(3_000_000));
            // Case (c): a pool that declares the claimed key but is NOT active ⇒ its entry is dropped.
            let (r1b, p1b, calb) = reg(1, 7, 5);
            let (r2b, _p2b, _c2) = reg(2, 7, 5);
            let out2 = reduce_no_committee(
                &[r1b, r2b],
                &[p1b], // only P1 active; P2 omitted from active_pools
                &[],
                &[calb],
                &[],
                &[(p1b, 1_000_000)],
                &[],
            );
            assert_eq!(out2.len(), 1);
            assert_eq!(out2[0].id, p1b);
        }

        #[test]
        fn claimed_calidus_pools_is_the_pool_scope_both_paths_share() {
            // The shared helper the node service unions into its `pool_stake` scope AND the reduction
            // restricts witness verification to. It returns every LIVE pool declaring a claimed key
            // (highest-nonce or not — the scope must be a superset of what the reduction emits), and no
            // pool that only declares an UNCLAIMED key. Order-independent, byte-deterministic (BTreeSet).
            let (rp, pool_p, cal) = reg(1, 7, 5); // pool P declares claimed key K
            let (rq, pool_q, cal_q) = reg(2, 7, 9); // pool Q also declares K (mSPO), higher nonce
            let (ro, pool_o, cal_o) = reg(3, 8, 1); // pool O declares a DIFFERENT, unclaimed key
                                                    // A pool id that does not exist on Cardano, declaring the CLAIMED key with the highest nonce
                                                    // of all. `pool_id` is free-form bytes in a witness-free parse, and a claimed key hash is
                                                    // public, so anyone can publish this for a few lovelace — no victim cooperation needed.
            let (rx, pool_x, _) = reg(9, 7, 99);
            assert_eq!(cal, cal_q);
            assert_ne!(cal, cal_o);
            let active = [pool_p, pool_q, pool_o];
            let regs = [ro.clone(), rq.clone(), rp.clone(), rx.clone()]; // deliberately out of order
            let got = claimed_calidus_pools(&regs, &[cal], &active);
            assert_eq!(
                got,
                [pool_p, pool_q].into_iter().collect(),
                "both LIVE pools declaring the claimed key; unclaimed-key O and non-existent X are out"
            );
            assert!(
                !got.contains(&pool_o),
                "a pool declaring only an unclaimed key is out of scope"
            );
            // The bound that keeps this set finite. Without it every fabricated pool id landed in the
            // `pool_stake` query array permanently, on every node — the one uncapped per-block query
            // input, growable for a few lovelace a row until it blew the db-sync timeout and froze the
            // sole writer of Cardano weight chain-wide.
            assert!(
                !got.contains(&pool_x),
                "a fabricated pool id must never enter the pool_stake scope or the verification gate"
            );
            // Superset property: the scope still covers every pool the reduction actually emits for.
            // This is the invariant the liveness filter must not break — a scope narrower than the
            // emitted set would silently read a Calidus SPO's chamber weight as 0.
            let emitted: std::collections::BTreeSet<[u8; 28]> =
                reduce_no_committee(&regs, &active, &[], &[cal], &[], &[], &[])
                    .into_iter()
                    .map(|e| e.id)
                    .collect();
            assert!(
                emitted.is_subset(&got),
                "the shared scope must cover every emitted pool, else its weight silently reads 0"
            );
            // Input order does not change the (sorted, deduped) result.
            assert_eq!(
                got,
                claimed_calidus_pools(&[rp, rq, ro, rx], &[cal], &active)
            );
            let _ = cal_q;
            let _ = cal_o;
        }

        #[test]
        fn a_registration_set_truncated_by_a_cursor_silently_drops_a_live_badge() {
            // Why this test exists: `docs/OBSERVATION-READ-SHAPE-PLAN.md` proposed bounding the `regs`
            // CTE by a `tx_metadata.id` lower bound (B′3's second half). Measured against the live
            // preprod db-sync on 2026-08-04, that cannot ship, and this is the mechanism.
            //
            // The label-867 registrations there span ids 402_268 → 1_655_055 — epoch 59 to epoch 303.
            // A 1_000-id window sees 7 of 153; a 100_000-id window sees 36 of 153. The other 117 are
            // older than any window a cursor would plausibly carry, because a pool registers its
            // Calidus key ONCE and then never touches it again.
            //
            // The fold below is per-POOL over every registration whose Calidus key is claimed, so an
            // absent registration is not "unknown" — the pool simply is not in `claimed_calidus_pools`
            // and no badge is emitted for it. And absence from the observation is exactly what
            // `derive_call` reads as CLEARED: the account's stored badge set shrinks, its chamber
            // weight goes to zero, and a `close_poll` running in that window freezes the zero
            // permanently. That is a take-back of a correct badge on the first block after the change
            // ships, not a missed key that B′5 could repair later.
            //
            // The plan's safety rule — "use the range to discover which credentials to re-examine,
            // then take a fresh point read of each one's state" — cannot rescue it either: the
            // discriminating value (the Calidus key hash) lives INSIDE the `tm.bytes` CBOR, not in any
            // indexed column, so db-sync's schema cannot serve a point read by credential.
            //
            // The fix on this axis is an INDEX, not a cursor. See `docs/PREPROD-BRINGUP.md`.
            let (old_reg, old_pool, old_cal) = reg(1, 2, 5); // registered once, long ago
            let (new_reg, new_pool, new_cal) = reg(9, 8, 5); // registered recently
            assert_ne!(old_pool, new_pool);

            let active = [old_pool, new_pool];
            let claimed = [old_cal, new_cal];
            let stake = [(old_pool, 1_000_000u128), (new_pool, 2_000_000u128)];

            // The COMPLETE history — what the unbounded scan returns today. Both pools hold a badge.
            let complete = reduce_no_committee(
                &[old_reg.clone(), new_reg.clone()],
                &active,
                &[],
                &claimed,
                &[],
                &stake,
                &[],
            );
            assert_eq!(complete.len(), 2, "both pools badged from the full history");
            assert_eq!(
                complete.iter().find(|e| e.id == old_pool).map(|e| e.weight),
                Some(1_000_000),
                "the long-registered pool carries its delegated stake"
            );

            // The SAME reduction over a set a `tx_metadata.id` lower bound would return: the recent
            // registration only. This is the whole failure — no error, no signal, one badge gone.
            let windowed =
                reduce_no_committee(&[new_reg], &active, &[], &claimed, &[], &stake, &[]);
            assert_eq!(
                windowed.len(),
                1,
                "a windowed registration set silently emits fewer badges than the truth"
            );
            assert!(
                !windowed.iter().any(|e| e.id == old_pool),
                "the long-registered pool's badge VANISHES — and `derive_call` reads that absence as \
                 a clear, zeroing a live SPO's chamber weight. This is why `regs` must stay unbounded."
            );
            assert!(
                windowed.iter().any(|e| e.id == new_pool),
                "the recently-registered pool is unaffected, which is what makes the loss silent"
            );
        }

        #[test]
        fn owner_free_path() {
            let stake: [u8; 28] = [0x33; 28];
            let pool: [u8; 28] = [0x44; 28];
            // The owned pool has 15_000_000 ADA delegated → that becomes the SpoOwner chamber weight.
            let out = reduce_no_committee(
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
            let z = reduce_no_committee(&[], &[pool], &[(stake, pool)], &[], &[], &[], &[]);
            assert_eq!(z.len(), 1);
            assert_eq!(z[0].weight, 0);
            // inactive pool ⇒ no free tag.
            assert!(reduce_no_committee(&[], &[], &[(stake, pool)], &[], &[], &[], &[]).is_empty());
        }

        #[test]
        fn drep_live_set_is_tagged_directly() {
            // The SQL already returned only CLAIMED + currently-live key-based dReps; the reduction emits
            // each as a `DRep` entry whose credential IS its display id. No pool/active gating applies.
            let d1: [u8; 28] = [0xD1; 28];
            let d2: [u8; 28] = [0xD2; 28];
            // d1 has delegated voting stake; d2 has none.
            let out = reduce_no_committee(&[], &[], &[], &[], &[d1, d2], &[], &[(d1, 42_000_000)]);
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
            assert!(reduce_no_committee(&[], &[], &[], &[], &[], &[], &[]).is_empty());
        }
    }

    // ── Constitutional Committee ─────────────────────────────────────────────────────────────────
    //
    // A CC badge is display only: no chamber, no vote weight, `weight` pinned at 0. What these tests
    // guard is the membership rule, because every way of getting it wrong is SILENT — a badge that
    // never renders, or 648 767 badges that should never have existed.
    mod committee {
        use super::super::*;

        const COLD: [u8; 28] = [0xC0; 28];
        const HOT: [u8; 28] = [0x40; 28];
        const OTHER_COLD: [u8; 28] = [0xC1; 28];
        const OTHER_HOT: [u8; 28] = [0x41; 28];
        const EPOCH: u64 = 305;

        fn member(cold: [u8; 28], is_script: bool, expiration_epoch: u64) -> CommitteeMember {
            CommitteeMember {
                cold,
                is_script,
                expiration_epoch,
            }
        }
        fn reg(
            cold: [u8; 28],
            hot: [u8; 28],
            hot_is_script: bool,
            order: CertOrder,
        ) -> CommitteeRegistration {
            CommitteeRegistration {
                cold,
                hot,
                hot_is_script,
                order,
            }
        }
        fn dereg(cold: [u8; 28], order: CertOrder) -> CommitteeDeregistration {
            CommitteeDeregistration { cold, order }
        }
        fn read(
            members: Vec<CommitteeMember>,
            registrations: Vec<CommitteeRegistration>,
            deregistrations: Vec<CommitteeDeregistration>,
        ) -> CommitteeRead {
            CommitteeRead {
                epoch: EPOCH,
                members,
                registrations,
                deregistrations,
            }
        }
        /// Run the reduction with ONLY the committee axis populated.
        fn cc(committee: &CommitteeRead, claimed: &[[u8; 28]]) -> Vec<RoleEntry> {
            reduce_role_observation(&[], &[], &[], &[], &[], &[], &[], committee, claimed)
        }

        #[test]
        fn a_sitting_key_hash_member_with_a_live_hot_key_is_badged() {
            let out = cc(
                &read(
                    vec![member(COLD, false, EPOCH + 67)],
                    vec![reg(COLD, HOT, false, (100, 0))],
                    vec![],
                ),
                &[HOT],
            );
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].source, RoleSource::Committee);
            // The whole point of trap 5: the observer emits the BARE 28 bytes, and the credential IS
            // the display id. Anything else compiles, passes, and renders no badge for ever.
            assert_eq!(out[0].credential, HOT);
            assert_eq!(out[0].id, HOT);
            assert_eq!(
                out[0].weight, 0,
                "a CC badge carries no chamber weight — its power is a veto, not a preference",
            );
            // Seated exactly AT the expiration epoch is still seated: cardano-ledger expires a member
            // iff `currentEpoch > expiry`, so the term runs THROUGH that epoch.
            assert_eq!(
                cc(
                    &read(
                        vec![member(COLD, false, EPOCH)],
                        vec![reg(COLD, HOT, false, (100, 0))],
                        vec![]
                    ),
                    &[HOT]
                )
                .len(),
                1,
            );
        }

        #[test]
        fn a_script_hot_credential_is_skipped_and_a_script_cold_one_is_not() {
            // A script HOT key can never CIP-8-sign, so it can never be in `RoleCredIndex[Committee]`
            // and an entry for it is dead payload in a paged delta. This is the live preprod shape:
            // all three sitting members registered script hot keys, so a CORRECT implementation badges
            // nobody there. That is the expected result, not a bug.
            assert!(cc(
                &read(
                    vec![member(COLD, false, EPOCH + 67)],
                    vec![reg(COLD, HOT, true, (100, 0))],
                    vec![],
                ),
                &[HOT],
            )
            .is_empty());
            // The COLD credential is a different question and must NOT be filtered. It never signs
            // anything on cogno — it authorized the hot key on Cardano — so a member with a script
            // (multisig) cold credential and a plain key-hash hot one can claim, and must be badged.
            // Filtering it too would silently deny the badge to exactly the split-key hygiene the
            // Cardano CC guidance encourages, and which every member seated on preprod already uses.
            let out = cc(
                &read(
                    vec![member(COLD, true, EPOCH + 67)],
                    vec![reg(COLD, HOT, false, (100, 0))],
                    vec![],
                ),
                &[HOT],
            );
            assert_eq!(
                out.len(),
                1,
                "a script COLD credential with a key-hash hot credential is a claimable member",
            );
            assert_eq!(out[0].id, HOT);
        }

        #[test]
        fn a_registration_whose_cold_key_is_not_a_sitting_member_is_skipped() {
            // THE trap. A registration certificate proves only that the cold key was named in a
            // committee PROPOSAL, which need never pass — 648 767 rows on live preprod, all from one
            // proposal that expired at epoch 194 unenacted. Reading the table as membership badges them.
            let out = cc(
                &read(
                    vec![member(COLD, false, EPOCH + 67)],
                    vec![
                        reg(COLD, HOT, false, (100, 0)),
                        // An outsider registering a hot key they hold and have already claimed.
                        reg(OTHER_COLD, OTHER_HOT, false, (999, 0)),
                    ],
                    vec![],
                ),
                &[HOT, OTHER_HOT],
            );
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].id, HOT);
            assert!(
                !out.iter().any(|e| e.id == OTHER_HOT),
                "a certificate from a non-member proves nothing and must confer no badge",
            );
            // And with NO sitting members at all, no registration can produce anything.
            assert!(cc(
                &read(
                    vec![],
                    vec![reg(OTHER_COLD, OTHER_HOT, false, (999, 0))],
                    vec![]
                ),
                &[OTHER_HOT],
            )
            .is_empty());
        }

        #[test]
        fn the_newest_registration_wins_a_rotation() {
            // A member rotates their hot key. Only the newest certificate counts, and the ordering is
            // `(tx_id, cert_index)` — so a re-registration in the SAME tx at a higher cert index also
            // supersedes. Input order must not matter (the SQL's json_agg has no ORDER BY here).
            let old = reg(COLD, HOT, false, (100, 0));
            let new = reg(COLD, OTHER_HOT, false, (100, 1));
            for regs in [vec![old.clone(), new.clone()], vec![new, old]] {
                let out = cc(
                    &read(vec![member(COLD, false, EPOCH + 67)], regs, vec![]),
                    &[HOT, OTHER_HOT],
                );
                assert_eq!(out.len(), 1, "one member, one hot credential");
                assert_eq!(
                    out[0].id, OTHER_HOT,
                    "the superseded hot key must not keep the badge",
                );
            }
            // Across transactions, tx id decides.
            let out = cc(
                &read(
                    vec![member(COLD, false, EPOCH + 67)],
                    vec![
                        reg(COLD, OTHER_HOT, false, (100, 7)),
                        reg(COLD, HOT, false, (101, 0)),
                    ],
                    vec![],
                ),
                &[HOT, OTHER_HOT],
            );
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].id, HOT);
        }

        #[test]
        fn a_de_registration_newer_than_the_registration_withdraws_the_badge() {
            let m = vec![member(COLD, false, EPOCH + 67)];
            // Resigned after registering ⇒ no badge.
            assert!(cc(
                &read(
                    m.clone(),
                    vec![reg(COLD, HOT, false, (100, 0))],
                    vec![dereg(COLD, (200, 0))],
                ),
                &[HOT],
            )
            .is_empty());
            // OLDER than the registration ⇒ the member resigned and came back; the badge stands. This
            // is why presence alone is not enough and the two must be ORDERED against each other.
            let back = cc(
                &read(
                    m.clone(),
                    vec![reg(COLD, HOT, false, (300, 0))],
                    vec![dereg(COLD, (200, 0))],
                ),
                &[HOT],
            );
            assert_eq!(back.len(), 1);
            assert_eq!(back[0].id, HOT);
            // Same tx, higher cert index ⇒ still newer.
            assert!(cc(
                &read(
                    m.clone(),
                    vec![reg(COLD, HOT, false, (100, 0))],
                    vec![dereg(COLD, (100, 1))],
                ),
                &[HOT],
            )
            .is_empty());
            // Someone ELSE's de-registration cannot withdraw this member's badge.
            let untouched = cc(
                &read(
                    m,
                    vec![reg(COLD, HOT, false, (100, 0))],
                    vec![dereg(OTHER_COLD, (999, 0))],
                ),
                &[HOT],
            );
            assert_eq!(untouched.len(), 1);
        }

        #[test]
        fn an_expired_member_is_skipped() {
            // db-sync KEEPS an expired member's row: preprod's enacted committee 6 (epochs 232-303)
            // still lists seven members whose term ended at epoch 229. Without this filter every one
            // of them would have been badged for every one of the seventy-two epochs that committee
            // was in force, their term having ended before it was even enacted.
            assert!(cc(
                &read(
                    vec![member(COLD, false, EPOCH - 1)],
                    vec![reg(COLD, HOT, false, (100, 0))],
                    vec![],
                ),
                &[HOT],
            )
            .is_empty());
        }

        #[test]
        fn a_seated_member_who_never_registered_a_hot_key_is_skipped() {
            assert!(cc(
                &read(vec![member(COLD, false, EPOCH + 67)], vec![], vec![]),
                &[HOT],
            )
            .is_empty());
        }

        #[test]
        fn an_unclaimed_hot_credential_is_not_emitted() {
            // Not merely an optimization. `claimed_committee` is `RoleCredIndex[Committee]` restricted
            // to THIS BLOCK'S scan window, and `RoleSink::set_roles` is a whole-set overwrite keyed by
            // ACCOUNT: an entry naming an account outside the window would be aggregated alone and
            // written back having dropped that account's SPO and dRep badges, chamber weight included.
            let r = read(
                vec![member(COLD, false, EPOCH + 67)],
                vec![reg(COLD, HOT, false, (100, 0))],
                vec![],
            );
            assert!(cc(&r, &[]).is_empty(), "nobody claimed it");
            assert!(
                cc(&r, &[OTHER_HOT]).is_empty(),
                "a different credential in the window is not this one",
            );
            assert_eq!(cc(&r, &[HOT]).len(), 1);
        }

        #[test]
        fn cc_entries_sort_into_the_non_spo_group_the_sink_reserve_expects() {
            // `bounded_roles` / `bound_observed_roles` fill in TWO passes — non-SPO first, capped at
            // NON_SPO_RESERVE — precisely because the canonical order puts every SPO badge ahead of
            // the dRep and CC ones. Pin that ordering here: if `RoleSource`'s declaration order ever
            // moved, a first-N cut would silently throw away exactly the badges a user cannot get back.
            let drep: [u8; 28] = [0xD0; 28];
            let (bytes, pool, cal) = super::roles::reg(1, 2, 5);
            let out = reduce_role_observation(
                &[bytes],
                &[pool],
                &[],
                &[cal],
                &[drep],
                &[(pool, 7)],
                &[(drep, 9)],
                &read(
                    vec![member(COLD, false, EPOCH + 67)],
                    vec![reg(COLD, HOT, false, (100, 0))],
                    vec![],
                ),
                &[HOT],
            );
            assert_eq!(out.len(), 3);
            assert_eq!(
                out.iter().map(|e| e.source).collect::<Vec<_>>(),
                vec![
                    RoleSource::SpoCalidus,
                    RoleSource::DRep,
                    RoleSource::Committee
                ],
                "canonical order must stay SPO… then dRep then CC",
            );
            // kind_index is what the sink's SPO/non-SPO split reads: 0 = SPO, 1 = dRep, 2 = CC.
            assert_eq!(out[2].source.kind_index(), 2);
            // And the CC entry must not disturb the other axes.
            assert_eq!(out[0].weight, 7);
            assert_eq!(out[1].weight, 9);
            assert_eq!(out[2].weight, 0);
        }

        #[test]
        fn the_result_cannot_depend_on_the_order_the_rows_arrive_in() {
            // `cc_members` / `cc_regs` / `cc_deregs` are `json_agg`ed with NO ORDER BY, so their order
            // belongs to the planner and two nodes can receive the same rows shuffled. Anything here
            // that let input order pick a winner would fork the chain with no bad actor anywhere.
            let members = vec![
                member(COLD, false, EPOCH + 67),
                member(OTHER_COLD, false, EPOCH + 67),
            ];
            let regs = vec![
                reg(COLD, HOT, false, (100, 0)),
                reg(COLD, OTHER_HOT, false, (100, 0)), // a same-position TIE, unreachable on real data
                reg(OTHER_COLD, OTHER_HOT, false, (50, 0)),
            ];
            let deregs = vec![dereg(OTHER_COLD, (10, 0)), dereg(COLD, (5, 0))];
            let claimed = [HOT, OTHER_HOT];

            let baseline = cc(
                &read(members.clone(), regs.clone(), deregs.clone()),
                &claimed,
            );
            // Every rotation of each list, against the same expected output.
            for i in 0..3 {
                let mut m = members.clone();
                let n = m.len();
                m.rotate_left(i % n);
                let mut r = regs.clone();
                let n = r.len();
                r.rotate_left(i % n);
                let mut d = deregs.clone();
                let n = d.len();
                d.rotate_left(i % n);
                assert_eq!(
                    cc(&read(m, r, d), &claimed),
                    baseline,
                    "shuffling the db-sync rows must not change one byte of the reduction",
                );
            }
            // Reversed too, and with the claimed set reversed.
            let mut m = members;
            m.reverse();
            let mut r = regs;
            r.reverse();
            let mut d = deregs;
            d.reverse();
            assert_eq!(cc(&read(m, r, d), &[OTHER_HOT, HOT]), baseline);
        }

        #[test]
        fn a_credential_seated_twice_merges_to_the_shorter_term_either_way_round() {
            // `committee_hash`'s unique constraint is on `(raw, has_script)`, so the same 28 bytes can
            // legally sit twice — once as a key hash, once as a script — and a committee proposal may
            // name a credential without proving anything about it. The merge has to be commutative or
            // the planner's row order picks the winner, which is a fork.
            //
            // The EARLIER term wins, either way round: a credential whose seat has already expired
            // under one reading must not be badged on the strength of the other.
            for exp in [[EPOCH - 1, EPOCH + 67], [EPOCH + 67, EPOCH - 1]] {
                assert!(cc(
                    &read(
                        vec![member(COLD, false, exp[0]), member(COLD, false, exp[1])],
                        vec![reg(COLD, HOT, false, (100, 0))],
                        vec![],
                    ),
                    &[HOT],
                )
                .is_empty());
            }
            // Two live readings of the same credential collapse to ONE badge, not two, whichever order
            // they arrive in — and the cold-side script flag does not change that, because the cold
            // credential is not what gets claimed.
            for order in [[false, true], [true, false]] {
                let out = cc(
                    &read(
                        vec![
                            member(COLD, order[0], EPOCH + 67),
                            member(COLD, order[1], EPOCH + 67),
                        ],
                        vec![reg(COLD, HOT, false, (100, 0))],
                        vec![],
                    ),
                    &[HOT],
                );
                assert_eq!(out.len(), 1, "one credential, one badge");
                assert_eq!(out[0].id, HOT);
            }
        }

        #[test]
        fn the_committee_axis_is_inert_when_the_read_is_empty() {
            // An abstain-shaped / pre-Conway read must not disturb anything, and must not badge.
            assert!(cc(&CommitteeRead::default(), &[HOT]).is_empty());
        }

        /// Mint a real CIP-8 `cogno-chain/role/v1;…;role=cc` self-proof for ed25519 seed `[s; 32]`,
        /// exactly as `cardano-signer --cip8` / the frontend's `role-proof.ts` produce one: signed over
        /// a SYNTHETIC enterprise address (`0x60 ‖ blake2b_224(pubkey)`), preprod network nibble 0.
        /// Returns `(cose_sign1, cose_key, the 28-byte credential the address commits)`.
        fn cc_role_proof(s: u8) -> (Vec<u8>, Vec<u8>, [u8; 28]) {
            use super::roles::{b224, bs};
            use ed25519_dalek::{Signer, SigningKey};

            let sk = SigningKey::from_bytes(&[s; 32]);
            let pk = sk.verifying_key().to_bytes();
            let cred = b224(&pk);
            let mut addr = vec![0x60u8]; // enterprise, VerificationKey payment, network 0 (preprod)
            addr.extend_from_slice(&cred);

            // protected content: map(3){ alg(1): -8, kid(4): pubkey, "address": addr }
            let mut prot = vec![0xa3u8, 0x01, 0x27, 0x04];
            prot.extend_from_slice(&bs(&pk));
            prot.push(0x67); // text(7)
            prot.extend_from_slice(b"address");
            prot.extend_from_slice(&bs(&addr));
            let protected_raw = bs(&prot);

            let payload = format!(
                "cogno-chain/role/v1;genesis={};account={};nonce={};role=cc",
                "27".repeat(32),
                "30".repeat(32),
                "ab".repeat(16),
            );
            let payload_raw = bs(payload.as_bytes());

            // Sig_structure = [ "Signature1", protected, external_aad(empty), payload ]
            let mut ss = vec![0x84u8, 0x6a];
            ss.extend_from_slice(b"Signature1");
            ss.extend_from_slice(&protected_raw);
            ss.push(0x40);
            ss.extend_from_slice(&payload_raw);
            let sig = sk.sign(&ss).to_bytes();

            let mut cose = vec![0x84u8];
            cose.extend_from_slice(&protected_raw);
            cose.push(0xa0); // empty unprotected map
            cose.extend_from_slice(&payload_raw);
            cose.extend_from_slice(&bs(&sig));

            // cose_key = { kty(1): OKP(1), alg(3): -8, crv(-1): Ed25519(6), x(-2): pubkey }
            let mut key = vec![0xa4u8, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21];
            key.extend_from_slice(&bs(&pk));
            (cose, key, cred)
        }

        #[test]
        fn the_observer_emits_the_exact_bytes_the_cip8_claim_stores() {
            // ── THE test this whole axis turns on, and the one failure mode nothing else can see. ──
            //
            // The observer writes a `RoleEntry.credential`; `claim_role_signed` writes a
            // `RoleCredIndex[Committee]` KEY; the badge renders only where the two are byte-identical.
            // They are produced in different crates that never call each other, so a disagreement is
            // completely silent: it compiles, every other test passes, and no CC badge ever appears.
            //
            // The specific trap is CIP-129. A committee hot credential's bech32 form (`cc_hot1…`)
            // carries a governance HEADER BYTE that a pool id does not, and the frontend knows about
            // it — so "use the id the way it is displayed" is a natural mistake that yields 29 bytes.
            // Both sides are 28 BARE bytes: `verify_bind_proof_role` returns the payment credential of
            // the signed synthetic enterprise address, and db-sync's `committee_hash.raw` is
            // `hash28type`. Neither ever sees a header byte.
            //
            // Driving the real verifier is the point. Pinning a literal on each side separately would
            // pass a pair of tests that agree with themselves and disagree with each other.
            use pallet_cogno_gate::cip8::{verify_bind_proof_role, RoleClass};

            let (cose, key, cred) = cc_role_proof(7);

            // Side 1 — what the CHAIN stores. This is `claim_role_signed`'s credential verbatim: the
            // pallet inserts `proof.credential` into `RoleCredIndex[Committee]` untouched.
            let proof =
                verify_bind_proof_role(&cose, &key, 0).expect("a CC role proof must verify");
            assert_eq!(proof.role, RoleClass::Committee, "role=cc must map to CC");
            assert_eq!(proof.credential, cred);
            assert_eq!(
                proof.credential.len(),
                28,
                "bare, never a 29-byte CIP-129 form"
            );

            // Side 2 — what the OBSERVER emits. `committee_hash.raw` is `hash28type`, so a sitting
            // member's registered hot key arrives as exactly these 28 bytes.
            let out = cc(
                &read(
                    vec![member(COLD, false, EPOCH + 67)],
                    vec![reg(COLD, proof.credential, false, (100, 0))],
                    vec![],
                ),
                &[proof.credential],
            );
            assert_eq!(out.len(), 1, "the claimed hot credential must be badged");
            assert_eq!(
                out[0].credential, proof.credential,
                "the observer's credential must equal the RoleCredIndex[Committee] key EXACTLY — if \
                 these ever disagree everything still compiles and no badge is ever rendered",
            );
            assert_eq!(
                out[0].id, proof.credential,
                "for CC the credential IS the id"
            );

            // And the literal, so a change to EITHER side has to be deliberate. This is
            // `blake2b_224(ed25519 pubkey of seed 07..07)`; `pallets/cogno-gate/src/cip8/tests.rs`
            // drives the same seed through the same verifier.
            assert_eq!(
                hex_encode(&proof.credential),
                "8b218424ad74df25d35c2ea8e094a4c5c5aeb2cbb442419331569313",
            );
            // The CIP-129 form of the same credential, for contrast: `0x02 ‖ cred`, 29 bytes. If a
            // future change ever emits THAT, the assertion above is what stops it.
            assert_ne!(
                proof.credential[0], 0x02,
                "the pinned vector must not begin with the CIP-129 CC-hot header byte, or this test \
                 could not tell a headered credential from a bare one",
            );
        }
    }
}
