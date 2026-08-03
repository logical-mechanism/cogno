//! Read-only Cardano **db-sync** client for the in-protocol observation (D4) — the Cardano IO, kept
//! separate from [`crate::reduction`] (the pure reduction).
//!
//! ONE read-only snapshot per block ([`read_observation`]) returns the three things the node-side
//! `InherentDataProvider` needs, from a single consistent Postgres MVCC snapshot (so the tip, anchor and
//! matches all come from ONE atomic view — they cannot diverge across an inter-call rollback):
//!   1. `tip_slot` — db-sync freshness (`max(block.slot_no)`). The node ABSTAINS (→ `CannotVerify`) when
//!      its own db-sync is behind the reference (a point-existence freshness guard).
//!   2. `anchor` — the **deterministic** stable Cardano block AT/UNDER the reference: the single `block`
//!      row with the max `slot_no <= reference`. Cardano has ≤1 block per slot on settled history, so this
//!      is unique and identical across every fully-synced db-sync.
//!   3. `matches` — the vault UTxOs that are UNSPENT AS-OF the reference, shaped (in SQL) into the canonical
//!      match JSON the pure reduction (`observe_as_of` / `candidate_tuples`) consumes BYTE-IDENTICALLY,
//!      UNCHANGED. "Unspent as-of the reference" INCLUDES a UTxO spent after it — that one was still locked
//!      at the reference, and it can and does win the largest-wins fold. The reduction re-applies the same
//!      test itself, so the SQL predicate is an optimization over an unchanged result, never the thing that
//!      decides it. Spentness is read
//!      from `tx_in` (canonical ledger data), NOT `consumed_by_tx_id` (a denormalized, config-dependent
//!      column — observed NULL for a known-spent vault UTxO on the live instance — which would be a
//!      cross-node determinism trap). A tx_in-ENABLED db-sync is REQUIRED: under `--consumed-tx-out` mode
//!      `tx_in` is empty (spentness moves to `consumed_by_tx_id`), so the read probes
//!      `EXISTS (SELECT 1 FROM tx_in)` and ABSTAINS otherwise (fail-closed; we do not fall back to the
//!      unreliable column). Coins/quantities are emitted as STRINGS (lovelace can exceed 2^53;
//!      `MaxStakeWeight` = 4.5e16). Driven from `tx_out.payment_cred = <vault script hash>` (indexed):
//!      the vault script address equals the beacon policy id (verified: 0 escaped beacons in all preprod
//!      history; ADA-only-at-address UTxOs are excluded by the asset `EXISTS`).

use crate::reduction::{hex32, hex_bytes};
use pallet_cardano_observer::{BeaconName, RoleCredential, StakeCredential};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio_postgres::{Client, NoTls};

/// Fail-closed bound on the whole read (connect + query) — a 2 s budget, so a slow/down db-sync can
/// never stall authoring/import (the caller treats any `Err` as abstain → empty observation →
/// `CannotVerify`).
const DBSYNC_TIMEOUT: Duration = Duration::from_secs(2);

/// One consistent-snapshot db-sync read for a single block's observation.
pub struct DbsyncRead {
    /// `max(block.slot_no)` — the db-sync freshness tip (the point-existence guard input).
    pub tip_slot: u64,
    /// The deterministic stable-block anchor `(slot, header_hash)` at/under the reference, or `None`
    /// when no block is at/under it (a pre-genesis-depth reference ⇒ the caller abstains).
    pub anchor: Option<(u64, BeaconName)>,
    /// The vault UTxOs as canonical match objects (fed UNCHANGED to the pure reduction).
    pub matches: Vec<serde_json::Value>,
}

/// The combined single-snapshot read. `$1` = reference slot (parent-derived, deterministic); `$2` = the
/// consensus-pinned vault policy id hex (== the vault script hash). See the module docs for the rationale
/// behind every clause (tx_in spentness, `::text` coins, payment_cred drive, the asset `EXISTS` gate).
///
/// The `(ti.id IS NULL OR sb.slot_no IS NULL OR sb.slot_no > p.ref)` clause is the unspent-as-of-reference
/// filter, and it is a VERBATIM transcription of [`crate::reduction::observe_as_of`]'s spentness test — the
/// three disjuncts are the three shapes that function reads as "not spent at or before the reference":
/// no consuming `tx_in` row, a consuming row whose slot the payload could not resolve (that parse fails
/// OPEN there, so it must fail open here), and a spend strictly AFTER the reference. Getting it wrong in
/// either direction is a consensus fault, not a slow query: dropping the third case would unlock every
/// beacon whose winning UTxO is spent-after-ref, and the golden fixture has cases proving the largest-wins
/// winner can be exactly that. The clause therefore changes the reduced ENTRIES not at all — it removes
/// only rows [`observe_as_of`] was already skipping, which is why the Rust filter STAYS as defence in
/// depth rather than being retired into this predicate.
///
/// What it does change is the pre-reduction candidate set, and so [`crate::reduction::inputs_commitment`].
/// That is deliberate and it is NOT a lockstep-rollout hazard: the runtime excludes the commitment from
/// `check_inherent`'s equality test on purpose (two honest nodes routinely hold different candidate sets
/// that reduce identically), consulting it only to classify a failure already established on the outputs.
/// So a mixed-binary network agrees on every delta; the sole cost during a rollout is that a divergence
/// arising from some OTHER cause reports `Mismatch` where it might have reported `ComputeDiverged`.
///
/// Measured on the live preprod instance (2026-08-02), server-side `EXPLAIN ANALYZE`: at 636 262 historical
/// UTxOs at one address 13 265 ms → 10 698 ms, at 260 935 5 302 ms → 3 872 ms. The saving is the per-row
/// `ma_tx_out` beacon probe, which now runs on live locks instead of on every UTxO ever created at the
/// address. It does NOT make the read `O(live locks)`: the `tx_in` spentness join still touches every
/// historical row and is the dominant term (~8 s of the 13 s), so the ratchet is slowed by roughly a
/// quarter, not removed. Removing it needs the touched-beacon range read, not a predicate.
const OBSERVATION_SQL: &str = "\
WITH params AS (SELECT $1::bigint AS ref, $2::text AS pol), \
freshness AS (SELECT max(slot_no) AS tip_slot FROM block), \
anchor AS ( \
  SELECT b.slot_no AS anchor_slot, encode(b.hash,'hex') AS anchor_hash \
  FROM block b, params p WHERE b.slot_no <= p.ref ORDER BY b.slot_no DESC LIMIT 1), \
vault AS ( \
  SELECT COALESCE(json_agg(json_build_object( \
    'transaction_id', encode(ctx.hash,'hex'), \
    'output_index',   o.index, \
    'value', json_build_object( \
       'coins',  o.value::text, \
       'assets', (SELECT json_object_agg(encode(a.policy,'hex')||'.'||encode(a.name,'hex'), m.quantity::text) \
                  FROM ma_tx_out m JOIN multi_asset a ON a.id = m.ident \
                  WHERE m.tx_out_id = o.id AND a.policy = decode(p.pol,'hex'))), \
    'created_at', json_build_object('slot_no', cb.slot_no), \
    'spent_at',   CASE WHEN ti.id IS NULL THEN NULL ELSE json_build_object('slot_no', sb.slot_no) END)), \
    '[]'::json) AS matches \
  FROM tx_out o \
  JOIN tx ctx   ON ctx.id = o.tx_id \
  JOIN block cb ON cb.id = ctx.block_id \
  LEFT JOIN tx_in ti ON ti.tx_out_id = o.tx_id AND ti.tx_out_index = o.index \
  LEFT JOIN tx stx   ON stx.id = ti.tx_in_id \
  LEFT JOIN block sb ON sb.id = stx.block_id, params p \
  WHERE o.payment_cred = decode(p.pol,'hex') \
    AND cb.slot_no <= p.ref \
    AND (ti.id IS NULL OR sb.slot_no IS NULL OR sb.slot_no > p.ref) \
    AND EXISTS (SELECT 1 FROM ma_tx_out m JOIN multi_asset a ON a.id = m.ident \
                WHERE m.tx_out_id = o.id AND a.policy = decode(p.pol,'hex'))) \
SELECT f.tip_slot, a.anchor_slot, a.anchor_hash, v.matches, (SELECT EXISTS (SELECT 1 FROM tx_in)) AS tx_in_ok, \
       (SELECT EXISTS (SELECT 1 FROM ma_tx_out)) AS ma_ok \
FROM freshness f, vault v LEFT JOIN anchor a ON true";

/// Cached, lazily-connected client (`None` until first use / after a dropped connection). Reads are
/// serialized through the mutex — they are short (~15 ms) and the import + authoring CIDPs are the only
/// callers, so contention is negligible; serialization also keeps the reconnect logic race-free.
static CLIENT: OnceLock<Mutex<Option<Client>>> = OnceLock::new();

fn client_cell() -> &'static Mutex<Option<Client>> {
    CLIENT.get_or_init(|| Mutex::new(None))
}

/// Open a new db-sync connection and spawn its driver task. `NoTls`: the read-only `cogno_reader` role
/// connects in plaintext over the private LAN (the server also allows it); TLS is a MAINNET PREREQUISITE.
async fn connect(url: &str) -> Result<Client, String> {
    let (client, connection) = tokio_postgres::connect(url, NoTls)
        .await
        .map_err(|e| format!("db-sync connect failed: {e}"))?;
    // The Connection drives the protocol; it MUST be polled or the Client never makes progress. The node
    // runs on a tokio runtime, so spawn it there; it ends when the Client is dropped or the socket closes.
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            log::debug!(target: "cardano-observer", "db-sync connection closed: {e}");
        }
    });
    Ok(client)
}

/// Run the combined single-snapshot read AS-OF `reference_slot`. Fail-closed: any error (connect / query /
/// timeout / malformed row) returns `Err`, which the caller turns into the empty observation (abstain).
/// On a query error the cached client is dropped so the next call reconnects (handles a db-sync restart).
pub async fn read_observation(
    url: &str,
    vault_policy_hex: &str,
    reference_slot: u64,
) -> Result<DbsyncRead, String> {
    let read = async {
        let mut slot = client_cell().lock().await;
        if slot.as_ref().is_none_or(|c| c.is_closed()) {
            *slot = Some(connect(url).await?);
        }
        let ref_i64 =
            i64::try_from(reference_slot).map_err(|_| "reference slot exceeds i64".to_string())?;
        let row = match slot
            .as_ref()
            .expect("just connected/validated above; qed")
            .query_one(OBSERVATION_SQL, &[&ref_i64, &vault_policy_hex])
            .await
        {
            Ok(r) => r,
            Err(e) => {
                *slot = None; // drop the (possibly dead) client so the next call reconnects
                return Err(format!("db-sync query failed: {e}"));
            }
        };
        drop(slot); // release the connection lock before the pure decode work

        // Fail-closed: the spentness join requires a tx_in-ENABLED db-sync. Under db-sync `--consumed-tx-out`
        // mode the `tx_in` consuming rows are pruned (spentness lives in `tx_out.consumed_by_tx_id` instead),
        // so the `LEFT JOIN tx_in` would silently emit `spent_at = NULL` for an actually-spent vault UTxO ⇒ a
        // WRONG observation (a spent vault read as locked) and a cross-node fork at the enforced cutover. So
        // the read probes `SELECT EXISTS (SELECT 1 FROM tx_in)` and ABSTAINS when it is empty — the
        // consensus-safe choice. We do NOT fall back to `consumed_by_tx_id`: it was observed unreliable (NULL for a
        // known-spent vault) on the live instance, so a tx_in-enabled db-sync is a hard requirement
        // (MAINNET PREREQUISITE: do NOT run db-sync with `--consumed-tx-out`).
        // Use `try_get` (not the panicking `Row::get`) throughout: a column type-mismatch must honour the
        // fail-closed contract (Err → abstain), NOT panic inside the authoring/import future.
        if !row
            .try_get::<_, bool>("tx_in_ok")
            .map_err(|e| format!("db-sync tx_in_ok column decode failed: {e}"))?
        {
            return Err("db-sync tx_in table is empty (--consumed-tx-out mode?); the observation requires a \
			            tx_in-enabled db-sync — abstaining (fail closed)"
				.to_string());
        }
        // Fail-closed on ma_tx_out, the sibling dependency of the same query. EVERY vault row must pass
        // the `EXISTS (ma_tx_out JOIN multi_asset …)` beacon gate in the WHERE above, so a db-sync run
        // with multi-asset insertion disabled matches ZERO rows and this read returns a SUCCESSFUL empty
        // observation. The runtime then treats it as "everyone unlocked": the clamp walks all of
        // `LastObserved` and zeroes every credited account's weight and capacity bucket. Same class as
        // the `tx_in` hole above, on the table the beacon gate depends on. `ma_tx_out` is network-wide,
        // so it is non-empty on any real Cardano chain no matter how few vault locks exist.
        if !row
            .try_get::<_, bool>("ma_ok")
            .map_err(|e| format!("db-sync ma_ok column decode failed: {e}"))?
        {
            return Err(
                "db-sync ma_tx_out table is empty (multi-asset indexing disabled?); the vault read's \
                 beacon gate requires it — abstaining (fail closed)"
                    .to_string(),
            );
        }

        let tip_slot = row
            .try_get::<_, Option<i64>>("tip_slot")
            .map_err(|e| format!("db-sync tip_slot column decode failed: {e}"))?
            .and_then(|s| u64::try_from(s).ok())
            .ok_or_else(|| "db-sync returned no tip slot".to_string())?;
        // anchor: both columns present + the hash is 32-byte hex ⇒ Some; otherwise None (fail closed).
        let anchor_slot = row
            .try_get::<_, Option<i64>>("anchor_slot")
            .map_err(|e| format!("db-sync anchor_slot column decode failed: {e}"))?;
        let anchor_hash = row
            .try_get::<_, Option<String>>("anchor_hash")
            .map_err(|e| format!("db-sync anchor_hash column decode failed: {e}"))?;
        let anchor = match (anchor_slot, anchor_hash) {
            (Some(slot_no), Some(hash)) => match (u64::try_from(slot_no).ok(), hex32(&hash)) {
                (Some(s), Some(h)) => Some((s, h)),
                _ => None,
            },
            _ => None,
        };
        let matches = row
            .try_get::<_, serde_json::Value>("matches")
            .map_err(|e| format!("db-sync matches column decode failed: {e}"))?
            .as_array()
            .cloned()
            .ok_or_else(|| "db-sync matches column was not a JSON array".to_string())?;
        Ok(DbsyncRead {
            tip_slot,
            anchor,
            matches,
        })
    };

    tokio::time::timeout(DBSYNC_TIMEOUT, read)
        .await
        .map_err(|_| format!("db-sync read timed out after {}s", DBSYNC_TIMEOUT.as_secs()))?
}

/// The VOTING-POWER (`epoch_stake`) read: for each bound 28-byte stake credential, its total Cardano
/// stake at the deterministic as-of epoch (the epoch of the stable block ≤ `reference_slot`, minus
/// `lookback`). The epoch is resolved from db-sync's `block.epoch_no` (network-agnostic — no
/// slots-per-epoch arithmetic), so every fully-synced node reads the SAME immutable snapshot. Matches a
/// credential network-agnostically (`substring(hash_raw from 2 for 28)` — the 28 bytes after the reward
/// header), so the same query works on preprod and mainnet. `::text` totals (stake exceeds 2^53).
const STAKE_OBSERVATION_SQL: &str = "\
WITH params AS (SELECT $1::bigint AS ref, $2::bigint AS lookback), \
ep AS (SELECT b.epoch_no AS e FROM block b, params p WHERE b.slot_no <= p.ref ORDER BY b.slot_no DESC LIMIT 1), \
target AS (SELECT (SELECT e FROM ep) - (SELECT lookback FROM params) AS e), \
stake AS ( \
  SELECT encode(substring(sa.hash_raw from 2 for 28),'hex') AS cred, SUM(es.amount)::text AS total \
  FROM epoch_stake es JOIN stake_address sa ON sa.id = es.addr_id \
  WHERE es.epoch_no = (SELECT e FROM target) \
    AND substring(sa.hash_raw from 2 for 28) = ANY($3::bytea[]) \
  GROUP BY substring(sa.hash_raw from 2 for 28)) \
SELECT (SELECT EXISTS (SELECT 1 FROM epoch_stake)) AS epoch_stake_ok, \
       (SELECT EXISTS (SELECT 1 FROM epoch_stake WHERE epoch_no = (SELECT e FROM target))) AS target_ok, \
       COALESCE(json_agg(json_build_object('cred', cred, 'total', total)), '[]'::json) AS rows \
FROM stake";

/// The result of the `epoch_stake` read. `entries` is `(28-byte credential, total lovelace)` for every
/// bound credential that had stake at the as-of epoch (absent ⇒ 0 via the on-chain unlock clamp).
pub struct DbsyncStakeRead {
    pub entries: Vec<(StakeCredential, u128)>,
}

/// Read the total `epoch_stake` for each bound stake credential AS-OF the epoch derived from
/// `reference_slot` (minus `lookback`). Fail-closed: any error, an unpopulated `epoch_stake`, or a target
/// epoch not yet snapshotted (while there ARE bound credentials) returns `Err` ⇒ the caller abstains
/// (empty observation, never a partial/forking read). `bound_creds` empty ⇒ `Ok(empty)` (legitimately no
/// voters yet — not an abstain).
pub async fn read_stake_observation(
    url: &str,
    bound_creds: &[StakeCredential],
    reference_slot: u64,
    lookback: u64,
) -> Result<DbsyncStakeRead, String> {
    if bound_creds.is_empty() {
        return Ok(DbsyncStakeRead {
            entries: Vec::new(),
        });
    }
    let read = async {
        let mut slot = client_cell().lock().await;
        if slot.as_ref().is_none_or(|c| c.is_closed()) {
            *slot = Some(connect(url).await?);
        }
        let ref_i64 =
            i64::try_from(reference_slot).map_err(|_| "reference slot exceeds i64".to_string())?;
        let lookback_i64 =
            i64::try_from(lookback).map_err(|_| "lookback exceeds i64".to_string())?;
        let creds: Vec<&[u8]> = bound_creds.iter().map(|c| c.as_slice()).collect();
        let row = match slot
            .as_ref()
            .expect("just connected/validated above; qed")
            .query_one(STAKE_OBSERVATION_SQL, &[&ref_i64, &lookback_i64, &creds])
            .await
        {
            Ok(r) => r,
            Err(e) => {
                *slot = None;
                return Err(format!("db-sync epoch_stake query failed: {e}"));
            }
        };
        drop(slot);

        // Fail-closed: epoch_stake must be populated, and the target epoch must be snapshotted (else a
        // not-yet-indexed node would read 0 for a real staker → a false unlock-clamp / cross-node fork).
        // `try_get` (not the panicking `Row::get`): a decode failure must abstain (Err), not panic.
        if !row
            .try_get::<_, bool>("epoch_stake_ok")
            .map_err(|e| format!("db-sync epoch_stake_ok column decode failed: {e}"))?
        {
            return Err(
                "db-sync epoch_stake table is empty; the voting-power read requires a populated \
			            epoch_stake — abstaining (fail closed)"
                    .to_string(),
            );
        }
        if !row
            .try_get::<_, bool>("target_ok")
            .map_err(|e| format!("db-sync target_ok column decode failed: {e}"))?
        {
            return Err(
                "db-sync has no epoch_stake snapshot for the target epoch yet (source behind) — \
			            abstaining (defer/CannotVerify)"
                    .to_string(),
            );
        }
        let rows = row
            .try_get::<_, serde_json::Value>("rows")
            .map_err(|e| format!("db-sync epoch_stake rows column decode failed: {e}"))?
            .as_array()
            .cloned()
            .ok_or_else(|| "db-sync epoch_stake rows column was not a JSON array".to_string())?;
        let mut entries: Vec<(StakeCredential, u128)> = Vec::with_capacity(rows.len());
        for r in &rows {
            let cred_hex = r
                .get("cred")
                .and_then(|v| v.as_str())
                .ok_or("missing cred")?;
            let total = r
                .get("total")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u128>().ok())
                .ok_or("bad total")?;
            let bytes = hex_bytes::<28>(cred_hex).ok_or("bad credential hex")?;
            entries.push((bytes, total));
        }
        Ok(DbsyncStakeRead { entries })
    };

    tokio::time::timeout(DBSYNC_TIMEOUT, read)
        .await
        .map_err(|_| {
            format!(
                "db-sync epoch_stake read timed out after {}s",
                DBSYNC_TIMEOUT.as_secs()
            )
        })?
}

/// The ROLE read (spec 207): the raw material the reduction needs to derive `role_entries`, in ONE MVCC
/// snapshot (single `query_one` → consensus-deterministic):
///   1. `registrations` — every label-867 (CIP-0151 Calidus) registration's RAW metadata bytes at block
///      slot ≤ `reference_slot`, ordered by `tx_metadata.id` so the array is byte-deterministic across
///      db-sync instances (the reduction's highest-nonce-wins tie-break is order-sensitive). The reduction
///      verifies each cold-key witness over these VERBATIM bytes (never the lossy `json` column) and
///      resolves Calidus→pool.
///   2. `active_pools` — the currently-registered, non-retired pool IDs as-of the reference (latest
///      `pool_update` at slot ≤ ref outranks the latest effective `pool_retire`), for the liveness gate.
///   3. `owner_pools` — for each BOUND stake credential (`$2`), the pool it is declared an owner of, taken
///      ONLY from that pool's LATEST registration cert at slot ≤ ref (a Cardano registration replaces the
///      full owner set, so an owner dropped by a re-registration must not linger). The FREE `SpoOwner`
///      path; scoped by the bound set; the reduction filters to active pools.
///   4. `live_dreps` — for each CLAIMED key-based dRep ID (`$3`), whether it is a currently-live dRep: the
///      latest `drep_registration` at slot ≤ ref is NOT a deregistration (db-sync `deposit` sign: `+`
///      register / `−` deregister / `NULL` update). Script dReps (`has_script`) can't CIP-8-sign, so they
///      are excluded. The credential IS the display id (the drep ID), so no separate resolution is needed.
///   5. `drep_stake` (spec 207, the dRep GOVERNANCE-POLL chamber weight) — for each CLAIMED key-based dRep
///      (`$3`), its TOTAL delegated VOTING stake `SUM(drep_distr.amount)` at the as-of epoch `ep − $4`
///      (the SAME immutable, lookback-shifted epoch the voting-power read uses; `drep_distr` is the Conway
///      per-epoch dRep power distribution). Bounded by the claimed-dRep set. This is the delegated stake the
///      dRep chamber weights a dRep's vote by. Predefined dReps (`drep_always_abstain`/`_no_confidence`,
///      `raw IS NULL`) are excluded automatically by the `= ANY($3)` scoping.
///
/// The SPO chamber weight (`pool_stake`) is read SEPARATELY by [`read_pool_stake`], scoped to
/// `owner_pools ∪ claimed-Calidus pools` — a set only known AFTER the reduction parses these
/// `registrations` (Calidus→pool lives inside the CBOR), so it cannot be a column of this query. `drep_stake`
/// is a DISPLAY-ONLY chamber weight computed in the deterministic reduction so every node agrees
/// byte-for-byte — a divergence is a chain fork, exactly like the vault/voting-power reads. `::text` totals
/// (dRep stake exceeds 2^53).
///
/// MAINNET PREREQUISITE: `active_pools` returns ALL active pools (fine on preprod's small set; on mainnet
/// scope it — e.g. only pools referenced by a claimed Calidus registration or owned by a bound credential).
/// `drep_stake` is ALREADY scoped (claimed dReps), and [`read_pool_stake`] is scoped to the union pool set,
/// so neither needs that change.
const ROLE_OBSERVATION_SQL: &str = "\
WITH params AS (SELECT $1::bigint AS ref, $4::bigint AS lookback), \
ep AS (SELECT b.epoch_no AS e FROM block b, params p WHERE b.slot_no <= p.ref ORDER BY b.slot_no DESC LIMIT 1), \
target AS (SELECT (SELECT e FROM ep) - (SELECT lookback FROM params) AS te), \
regs AS ( \
  SELECT tm.id AS id, tm.bytes AS bytes FROM tx_metadata tm \
  JOIN tx t ON t.id = tm.tx_id JOIN block b ON b.id = t.block_id, params p \
  WHERE tm.key = 867 AND tm.bytes IS NOT NULL AND b.slot_no <= p.ref), \
reg AS ( \
  SELECT pu.hash_id AS hash_id, max(pu.registered_tx_id) AS tx_id FROM pool_update pu \
  JOIN tx t ON t.id = pu.registered_tx_id JOIN block b ON b.id = t.block_id \
  WHERE b.slot_no <= (SELECT ref FROM params) GROUP BY pu.hash_id), \
ret AS ( \
  SELECT DISTINCT ON (pr.hash_id) pr.hash_id AS hash_id, pr.announced_tx_id AS tx_id, \
         pr.retiring_epoch AS r_ep FROM pool_retire pr \
  JOIN tx t ON t.id = pr.announced_tx_id JOIN block b ON b.id = t.block_id \
  WHERE b.slot_no <= (SELECT ref FROM params) \
  ORDER BY pr.hash_id, b.slot_no DESC, t.block_index DESC, pr.cert_index DESC), \
active AS ( \
  SELECT ph.hash_raw AS hash_raw FROM pool_hash ph \
  JOIN reg ON reg.hash_id = ph.id \
  LEFT JOIN ret ON ret.hash_id = ph.id \
  WHERE ret.hash_id IS NULL \
     OR ret.tx_id < reg.tx_id \
     OR ret.r_ep > (SELECT e FROM ep)), \
owners AS ( \
  SELECT DISTINCT encode(substring(sa.hash_raw from 2 for 28),'hex') AS cred, encode(ph.hash_raw,'hex') AS pool \
  FROM pool_owner po \
  JOIN stake_address sa ON sa.id = po.addr_id \
  JOIN pool_update pu ON pu.id = po.pool_update_id \
  JOIN pool_hash ph ON ph.id = pu.hash_id \
  WHERE substring(sa.hash_raw from 2 for 28) = ANY($2::bytea[]) \
    AND pu.registered_tx_id = (SELECT max(pu2.registered_tx_id) FROM pool_update pu2 \
        JOIN tx t2 ON t2.id = pu2.registered_tx_id JOIN block b2 ON b2.id = t2.block_id \
        WHERE pu2.hash_id = ph.id AND b2.slot_no <= (SELECT ref FROM params))), \
dreps AS ( \
  SELECT encode(dh.raw,'hex') AS drep FROM drep_hash dh \
  WHERE dh.has_script = false AND dh.raw = ANY($3::bytea[]) \
    AND (SELECT (dr.deposit IS NULL OR dr.deposit >= 0) FROM drep_registration dr \
         JOIN tx t ON t.id = dr.tx_id JOIN block b ON b.id = t.block_id \
         WHERE dr.drep_hash_id = dh.id AND b.slot_no <= (SELECT ref FROM params) \
         ORDER BY b.slot_no DESC, t.block_index DESC, dr.cert_index DESC LIMIT 1) IS TRUE), \
drep_stake AS ( \
  SELECT encode(dh.raw,'hex') AS id, SUM(dd.amount)::text AS stake \
  FROM drep_distr dd JOIN drep_hash dh ON dh.id = dd.hash_id \
  WHERE dd.epoch_no = (SELECT te FROM target) \
    AND dh.raw = ANY($3::bytea[]) \
  GROUP BY dh.raw) \
SELECT (SELECT EXISTS (SELECT 1 FROM pool_hash)) AS pool_ok, \
       (SELECT EXISTS (SELECT 1 FROM drep_hash)) AS drep_ok, \
       (SELECT EXISTS (SELECT 1 FROM drep_registration)) AS drep_reg_ok, \
       (SELECT EXISTS (SELECT 1 FROM tx_metadata)) AS meta_ok, \
       COALESCE((SELECT json_agg(encode(bytes,'hex') ORDER BY id) FROM regs), '[]'::json) AS registrations, \
       COALESCE((SELECT json_agg(encode(hash_raw,'hex')) FROM active), '[]'::json) AS active_pools, \
       COALESCE((SELECT json_agg(json_build_object('cred', cred, 'pool', pool)) FROM owners), '[]'::json) AS owner_pools, \
       COALESCE((SELECT json_agg(drep) FROM dreps), '[]'::json) AS live_dreps, \
       (SELECT EXISTS (SELECT 1 FROM drep_distr WHERE epoch_no = (SELECT te FROM target))) AS drep_target_ok, \
       COALESCE((SELECT json_agg(json_build_object('id', id, 'stake', stake)) FROM drep_stake), '[]'::json) AS drep_stake";

/// The raw ROLE read (pre-reduction). `registrations` are the verbatim label-867 metadata bytes;
/// `active_pools` the 28-byte active pool IDs; `owner_pools` the `(28-byte stake credential, 28-byte
/// pool ID)` ownership declarations for the bound stake set.
pub struct DbsyncRoleRead {
    pub registrations: Vec<Vec<u8>>,
    pub active_pools: Vec<[u8; 28]>,
    pub owner_pools: Vec<([u8; 28], [u8; 28])>,
    /// The CLAIMED key-based dRep IDs (`$3`) that are currently LIVE (latest registration ≤ ref is not a
    /// deregistration). For dReps the credential IS the display id, so the reduction emits these directly.
    pub live_dreps: Vec<[u8; 28]>,
    /// (spec 207) `(claimed dRep ID, total delegated voting stake)` at the as-of epoch — the dRep
    /// governance-poll chamber weight. Bounded by the claimed-dRep set. The reduction attaches this as
    /// `DRep`'s `RoleEntry.weight`. The SPO counterpart (`pool_stake`) is read separately by
    /// [`read_pool_stake`] once the reduction's Calidus→pool set is known.
    pub drep_stake: Vec<([u8; 28], u128)>,
}

/// Read the raw ROLE material AS-OF `reference_slot`, in one snapshot. `lookback` is the epoch shift for
/// the chamber-weight sums (spec 207) — the SAME value the voting-power read uses, so pool/dRep chamber
/// stake is read at the identical immutable epoch. Fail-closed: any error, an unpopulated `pool_hash`
/// (db-sync behind), or a chamber-weight target epoch not yet snapshotted while there ARE owned pools /
/// live dReps, returns `Err` ⇒ the caller abstains (never a partial/forking read). The reduction
/// ([`crate::reduction::reduce_role_observation`]) turns this into `role_entries`.
pub async fn read_role_observation(
    url: &str,
    reference_slot: u64,
    bound_stake_creds: &[StakeCredential],
    bound_drep_ids: &[RoleCredential],
    lookback: u64,
) -> Result<DbsyncRoleRead, String> {
    let read = async {
        let mut slot = client_cell().lock().await;
        if slot.as_ref().is_none_or(|c| c.is_closed()) {
            *slot = Some(connect(url).await?);
        }
        let ref_i64 =
            i64::try_from(reference_slot).map_err(|_| "reference slot exceeds i64".to_string())?;
        let lookback_i64 =
            i64::try_from(lookback).map_err(|_| "lookback exceeds i64".to_string())?;
        let creds: Vec<&[u8]> = bound_stake_creds.iter().map(|c| c.as_slice()).collect();
        let dreps: Vec<&[u8]> = bound_drep_ids.iter().map(|c| c.as_slice()).collect();
        let row = match slot
            .as_ref()
            .expect("just connected/validated above; qed")
            .query_one(
                ROLE_OBSERVATION_SQL,
                &[&ref_i64, &creds, &dreps, &lookback_i64],
            )
            .await
        {
            Ok(r) => r,
            Err(e) => {
                *slot = None;
                return Err(format!("db-sync role query failed: {e}"));
            }
        };
        drop(slot);

        // Fail-closed: pool_hash must be populated (else a behind db-sync would read no active pools →
        // a false clamp of every SPO badge). `try_get`, never the panicking `Row::get`.
        if !row
            .try_get::<_, bool>("pool_ok")
            .map_err(|e| format!("db-sync pool_ok column decode failed: {e}"))?
        {
            return Err(
                "db-sync pool_hash table is empty; the role read requires populated pool data — \
                 abstaining (fail closed)"
                    .to_string(),
            );
        }
        // Fail-closed on tx_metadata, the SAME contract as `pool_hash` above and `tx_in` on the vault
        // read. cardano-db-sync's `insert_options.metadata` can be disabled outright, and the
        // `only_utxo` / `disable_all` presets drop it — on such an instance the `regs` CTE returns zero
        // rows and this read would report "no Calidus registrations exist" as a SUCCESS, stripping every
        // SPO badge and zeroing every SPO chamber weight chain-wide. An empty table is indistinguishable
        // from "no registrations", so the only safe reading is to abstain.
        // ⚠ This does NOT catch a metadata KEY WHITELIST (`"keys": [721]` leaves tx_metadata non-empty
        // while filtering label 867 out) — no in-query probe can, since the table IS populated. The boot
        // probe in node/src/config_check.rs covers that case instead, by flagging the signature it leaves:
        // active pools present, zero label-867 registrations.
        if !row
            .try_get::<_, bool>("meta_ok")
            .map_err(|e| format!("db-sync meta_ok column decode failed: {e}"))?
        {
            return Err(
                "db-sync tx_metadata table is empty (metadata indexing disabled?); the role read \
                 requires it — abstaining (fail closed)"
                    .to_string(),
            );
        }
        // Fail-closed on the Conway GOVERNANCE tables, the same contract again. db-sync's
        // `insert_options.governance = disable` (and the `only_utxo` / `disable_all` presets) skip
        // `drep_hash` + `drep_registration` while leaving tx_in/ma_tx_out/tx_metadata/pool_hash fully
        // populated — so nothing above notices, the `dreps` CTE returns zero rows, and this read reports
        // "no live dReps exist" as a SUCCESS: every dRep badge stripped and every dRep chamber weight
        // zeroed chain-wide.
        //
        // `drep_target_ok` does NOT cover this. It is consumed CONDITIONALLY (`!live_dreps.is_empty() &&
        // !drep_target_ok`), so it is disarmed by exactly the emptiness it would have to catch — the
        // guard and the failure cancel out. Both tables are network-wide on any post-Conway Cardano, so
        // empty means the indexer is misconfigured, never that the chain has no dReps.
        if !row
            .try_get::<_, bool>("drep_ok")
            .map_err(|e| format!("db-sync drep_ok column decode failed: {e}"))?
        {
            return Err(
                "db-sync drep_hash table is empty (governance indexing disabled?); the role read \
                 requires it — abstaining (fail closed)"
                    .to_string(),
            );
        }
        if !row
            .try_get::<_, bool>("drep_reg_ok")
            .map_err(|e| format!("db-sync drep_reg_ok column decode failed: {e}"))?
        {
            return Err(
                "db-sync drep_registration table is empty (governance indexing disabled?); the dRep \
                 liveness join requires it — abstaining (fail closed)"
                    .to_string(),
            );
        }
        let reg_rows = row
            .try_get::<_, serde_json::Value>("registrations")
            .map_err(|e| format!("db-sync registrations column decode failed: {e}"))?
            .as_array()
            .cloned()
            .ok_or_else(|| "db-sync registrations column was not a JSON array".to_string())?;
        let mut registrations: Vec<Vec<u8>> = Vec::with_capacity(reg_rows.len());
        for r in &reg_rows {
            let hex = r.as_str().ok_or("registration row not a string")?;
            registrations.push(hex_to_vec(hex).ok_or("bad registration hex")?);
        }
        let pool_rows = row
            .try_get::<_, serde_json::Value>("active_pools")
            .map_err(|e| format!("db-sync active_pools column decode failed: {e}"))?
            .as_array()
            .cloned()
            .ok_or_else(|| "db-sync active_pools column was not a JSON array".to_string())?;
        let mut active_pools: Vec<[u8; 28]> = Vec::with_capacity(pool_rows.len());
        for r in &pool_rows {
            let hex = r.as_str().ok_or("active pool row not a string")?;
            active_pools.push(hex_bytes::<28>(hex).ok_or("bad pool id hex")?);
        }
        let owner_rows = row
            .try_get::<_, serde_json::Value>("owner_pools")
            .map_err(|e| format!("db-sync owner_pools column decode failed: {e}"))?
            .as_array()
            .cloned()
            .ok_or_else(|| "db-sync owner_pools column was not a JSON array".to_string())?;
        let mut owner_pools: Vec<([u8; 28], [u8; 28])> = Vec::with_capacity(owner_rows.len());
        for r in &owner_rows {
            let cred = r
                .get("cred")
                .and_then(|v| v.as_str())
                .ok_or("missing cred")?;
            let pool = r
                .get("pool")
                .and_then(|v| v.as_str())
                .ok_or("missing pool")?;
            owner_pools.push((
                hex_bytes::<28>(cred).ok_or("bad owner cred hex")?,
                hex_bytes::<28>(pool).ok_or("bad owner pool hex")?,
            ));
        }
        let drep_rows = row
            .try_get::<_, serde_json::Value>("live_dreps")
            .map_err(|e| format!("db-sync live_dreps column decode failed: {e}"))?
            .as_array()
            .cloned()
            .ok_or_else(|| "db-sync live_dreps column was not a JSON array".to_string())?;
        let mut live_dreps: Vec<[u8; 28]> = Vec::with_capacity(drep_rows.len());
        for r in &drep_rows {
            let hex = r.as_str().ok_or("live drep row not a string")?;
            live_dreps.push(hex_bytes::<28>(hex).ok_or("bad drep id hex")?);
        }

        // ── dRep CHAMBER WEIGHT (spec 207): the delegated-voting-stake sum for governance polls. Fail-closed
        // like the voting-power read — if there ARE live dReps but the target epoch is not yet snapshotted, a
        // behind db-sync would read 0 stake for a real dRep → a false chamber weight and a cross-node fork;
        // abstain instead. (An empty live-dRep set has nothing to weight, so the missing snapshot is
        // irrelevant and we do NOT abstain.) The SPO counterpart is guarded identically in `read_pool_stake`.
        let drep_target_ok = row
            .try_get::<_, bool>("drep_target_ok")
            .map_err(|e| format!("db-sync drep_target_ok column decode failed: {e}"))?;
        if !live_dreps.is_empty() && !drep_target_ok {
            return Err(
                "db-sync has no drep_distr snapshot for the chamber-weight target epoch yet (source \
                 behind) — abstaining (defer/CannotVerify)"
                    .to_string(),
            );
        }
        let drep_stake = parse_id_stake(&row, "drep_stake")?;

        Ok(DbsyncRoleRead {
            registrations,
            active_pools,
            owner_pools,
            live_dreps,
            drep_stake,
        })
    };

    tokio::time::timeout(DBSYNC_TIMEOUT, read)
        .await
        .map_err(|_| {
            format!(
                "db-sync role read timed out after {}s",
                DBSYNC_TIMEOUT.as_secs()
            )
        })?
}

/// The SPO GOVERNANCE-POLL chamber-weight read (spec 207): for each pool in `$3`, its TOTAL delegated
/// (block-production) stake `SUM(epoch_stake.amount)` at the as-of epoch `ep − $2` (the SAME immutable,
/// lookback-shifted epoch [`read_role_observation`]'s `drep_stake` and the voting-power read use, so the SPO
/// chamber weight lags one epoch consistently). Read SEPARATELY from the role read because its pool set is
/// `owner_pools ∪ claimed-Calidus pools` — the Calidus→pool half lives inside the label-867 CBOR and is only
/// known AFTER the reduction parses the registrations, so the node service computes the (sorted, deduped)
/// set and passes it here. Scoped by `= ANY($3)` (bounded — mainnet-safe, no MAINNET PREREQUISITE widening).
/// A pool with no delegators is absent ⇒ 0 weight (correct). `::text` totals (pool stake exceeds 2^53).
const POOL_STAKE_SQL: &str = "\
WITH params AS (SELECT $1::bigint AS ref, $2::bigint AS lookback), \
ep AS (SELECT b.epoch_no AS e FROM block b, params p WHERE b.slot_no <= p.ref ORDER BY b.slot_no DESC LIMIT 1), \
target AS (SELECT (SELECT e FROM ep) - (SELECT lookback FROM params) AS te), \
pool_stake AS ( \
  SELECT encode(ph.hash_raw,'hex') AS id, SUM(es.amount)::text AS stake \
  FROM epoch_stake es JOIN pool_hash ph ON ph.id = es.pool_id \
  WHERE es.epoch_no = (SELECT te FROM target) \
    AND ph.hash_raw = ANY($3::bytea[]) \
  GROUP BY ph.hash_raw) \
SELECT (SELECT EXISTS (SELECT 1 FROM epoch_stake WHERE epoch_no = (SELECT te FROM target))) AS target_ok, \
       COALESCE((SELECT json_agg(json_build_object('id', id, 'stake', stake)) FROM pool_stake), '[]'::json) AS pool_stake";

/// Read the SPO chamber weight — each pool's total delegated block-production stake — for every pool in
/// `pool_ids`, AS-OF the epoch derived from `reference_slot` (minus `lookback`). `pool_ids` is
/// `owner_pools ∪ claimed-Calidus pools`, sorted + deduped by the node service (byte-determinism of the
/// query input). Fail-closed: any error, or a target epoch not yet snapshotted while there ARE pools to
/// weight, returns `Err` ⇒ the caller abstains (empty observation, never a partial/forking read). `pool_ids`
/// empty ⇒ `Ok(empty)` (nothing to weight — not an abstain), mirroring [`read_stake_observation`]'s
/// empty-set short-circuit. Determinism matches the other reads: a fixed reference slot / immutable target
/// epoch means this separate snapshot reads byte-identical settled history on every node.
pub async fn read_pool_stake(
    url: &str,
    pool_ids: &[[u8; 28]],
    reference_slot: u64,
    lookback: u64,
) -> Result<Vec<([u8; 28], u128)>, String> {
    if pool_ids.is_empty() {
        return Ok(Vec::new());
    }
    let read = async {
        let mut slot = client_cell().lock().await;
        if slot.as_ref().is_none_or(|c| c.is_closed()) {
            *slot = Some(connect(url).await?);
        }
        let ref_i64 =
            i64::try_from(reference_slot).map_err(|_| "reference slot exceeds i64".to_string())?;
        let lookback_i64 =
            i64::try_from(lookback).map_err(|_| "lookback exceeds i64".to_string())?;
        let ids: Vec<&[u8]> = pool_ids.iter().map(|p| p.as_slice()).collect();
        let row = match slot
            .as_ref()
            .expect("just connected/validated above; qed")
            .query_one(POOL_STAKE_SQL, &[&ref_i64, &lookback_i64, &ids])
            .await
        {
            Ok(r) => r,
            Err(e) => {
                *slot = None;
                return Err(format!("db-sync pool_stake query failed: {e}"));
            }
        };
        drop(slot);

        // Fail-closed: the target epoch must be snapshotted (there ARE pools to weight — guaranteed by the
        // non-empty `pool_ids` short-circuit above), else a behind db-sync would read 0 for a real pool → a
        // false chamber weight and a cross-node fork. `try_get`, never the panicking `Row::get`.
        if !row
            .try_get::<_, bool>("target_ok")
            .map_err(|e| format!("db-sync pool_stake target_ok column decode failed: {e}"))?
        {
            return Err(
                "db-sync has no epoch_stake snapshot for the SPO chamber-weight target epoch yet (source \
                 behind) — abstaining (defer/CannotVerify)"
                    .to_string(),
            );
        }
        parse_id_stake(&row, "pool_stake")
    };

    tokio::time::timeout(DBSYNC_TIMEOUT, read)
        .await
        .map_err(|_| {
            format!(
                "db-sync pool_stake read timed out after {}s",
                DBSYNC_TIMEOUT.as_secs()
            )
        })?
}

/// Parse a chamber-weight column (a JSON array of `{"id": <28-byte hex>, "stake": <lovelace string>}`)
/// into `(id, total)` pairs. The stake is emitted `::text` in SQL (lovelace > 2^53), so it MUST parse as
/// a pure-digit u128 — a malformed value fails the whole read closed (Err → abstain), never silently 0.
/// `label` is the column's SQL ALIAS and doubles as the row index: every read in this module addresses
/// its column BY NAME, never by position. A positional index silently re-points at the neighbouring
/// column the moment a probe is inserted into a SELECT list, and because these reads are the consensus
/// weight writer's only input, that mis-read is a hard `Err` on every block — the whole observation
/// abstains forever, and no test that only exercises the SQL strings can see it.
fn parse_id_stake(row: &tokio_postgres::Row, label: &str) -> Result<Vec<([u8; 28], u128)>, String> {
    let rows = row
        .try_get::<_, serde_json::Value>(label)
        .map_err(|e| format!("db-sync {label} column decode failed: {e}"))?
        .as_array()
        .cloned()
        .ok_or_else(|| format!("db-sync {label} column was not a JSON array"))?;
    let mut out: Vec<([u8; 28], u128)> = Vec::with_capacity(rows.len());
    for r in &rows {
        let id_hex = r
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("{label}: missing id"))?;
        let stake = r
            .get("stake")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<u128>().ok())
            .ok_or_else(|| format!("{label}: bad stake"))?;
        let id = hex_bytes::<28>(id_hex).ok_or_else(|| format!("{label}: bad id hex"))?;
        out.push((id, stake));
    }
    Ok(out)
}

/// Decode a lowercase-hex string to bytes (variable length — for the raw label-867 registration bytes).
fn hex_to_vec(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(b.len() / 2);
    for chunk in b.chunks_exact(2) {
        let hi = (chunk[0] as char).to_digit(16)? as u8;
        let lo = (chunk[1] as char).to_digit(16)? as u8;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// Every SQL constant on the consensus read path, with its human name.
    fn all_sql() -> [(&'static str, &'static str); 4] {
        [
            ("OBSERVATION_SQL", OBSERVATION_SQL),
            ("STAKE_OBSERVATION_SQL", STAKE_OBSERVATION_SQL),
            ("ROLE_OBSERVATION_SQL", ROLE_OBSERVATION_SQL),
            ("POOL_STAKE_SQL", POOL_STAKE_SQL),
        ]
    }

    /// The identifiers a query introduces itself (`name AS (`) — CTEs, not db-sync tables.
    fn cte_names(sql: &str) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        let toks: Vec<&str> = sql.split_whitespace().collect();
        for w in toks.windows(2) {
            if w[1] == "AS" || w[1].starts_with("AS(") {
                out.insert(w[0].trim_start_matches(',').to_string());
            }
        }
        out
    }

    /// Real db-sync tables a query reads: every `FROM x` / `JOIN x`, minus its own CTEs and minus
    /// sub-select aliases.
    ///
    /// A FROM list is comma-separated, and these queries use that form (`FROM freshness f, vault v`),
    /// including one item that trails a JOIN's ON clause (`… LEFT JOIN block sb ON sb.id = stx.block_id,
    /// params p`). So the scan is stateful rather than a plain `windows(2)` over FROM/JOIN: while a list
    /// is open, every comma introduces another item. `ON` must NOT close the list, or that trailing item
    /// goes unseen — and an unseen table is an unprobed, unexempted db-sync dependency that the test
    /// below would then report as safe.
    ///
    /// Openness is tracked PER PAREN DEPTH, which is what keeps the three confusable shapes apart: a
    /// comma inside a function call (`coalesce(a, b)`) is not a list separator, a sub-select in a FROM
    /// list must not close the list that contains it, and a parenthesized join (`FROM (a x JOIN b y …)`)
    /// still names real tables. Parens and commas are split into their own tokens first so the depth
    /// count cannot be thrown off by punctuation glued to an identifier.
    fn tables(sql: &str) -> BTreeSet<String> {
        let ctes = cte_names(sql);
        let mut out = BTreeSet::new();
        let spaced = sql
            .replace('(', " ( ")
            .replace(')', " ) ")
            .replace(',', " , ");
        // `open[d]` = a FROM list is open at paren depth `d`. `expect` = the next identifier names a
        // table (carried THROUGH an opening paren, so a parenthesized join is still read).
        let mut open: Vec<bool> = vec![false];
        let mut depth: usize = 0;
        let mut expect = false;
        for tok in spaced.split_whitespace() {
            match tok {
                "(" => {
                    depth += 1;
                    if open.len() <= depth {
                        open.resize(depth + 1, false);
                    }
                    open[depth] = false;
                    // `expect` deliberately survives: `FROM ( tx_in ti JOIN …` names a table, while
                    // `FROM ( SELECT …` does not — the keyword fails the identifier test below.
                }
                ")" => {
                    open[depth] = false;
                    depth = depth.saturating_sub(1);
                    expect = false;
                }
                "," => {
                    // Only a comma at the list's OWN depth separates items; one nested inside a
                    // function call or sub-select belongs to that, not to the FROM list.
                    if open[depth] {
                        expect = true;
                    }
                }
                "FROM" | "JOIN" => {
                    open[depth] = true;
                    expect = true;
                }
                "WHERE" | "GROUP" | "ORDER" | "HAVING" | "LIMIT" | "UNION" | "SELECT" => {
                    open[depth] = false;
                    expect = false;
                }
                _ => {
                    if expect {
                        expect = false;
                        // A db-sync table is a bare lowercase identifier; digits are legal after the
                        // first character, so `all(is_ascii_lowercase)` alone would silently drop one.
                        // This also rejects aliases-with-dots, quoted literals and stray keywords.
                        let is_table = tok
                            .starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
                            && tok
                                .chars()
                                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
                        if is_table && !ctes.contains(tok) {
                            out.insert(tok.to_string());
                        }
                    }
                }
            }
        }
        out
    }

    /// Tables that deliberately carry NO `EXISTS` probe, per QUERY, each with the reason it is safe.
    ///
    /// Scoped per query on purpose: a table that is safely unprobed in one read is not automatically
    /// safe in another. `pool_hash` is a case in point — `ROLE_OBSERVATION_SQL` probes it directly,
    /// while `POOL_STAKE_SQL` reaches it only through a foreign key from the epoch it already gates on.
    ///
    /// Adding an entry here is a DECISION, which is the whole point of the test below: an unprobed
    /// dependency is how an under-indexed db-sync gets read as authoritative emptiness — a SUCCESSFUL
    /// query returning "nothing is locked" / "no registrations exist", which the runtime then applies
    /// as a mass unlock or a mass badge-strip. `tx_in` had a probe; `ma_tx_out` and `tx_metadata` did
    /// not, and both were exactly that hole.
    fn exempt(sql_name: &str, table: &str) -> Option<&'static str> {
        // Structural, in every query.
        let global = match table {
            // Emptiness is already fatal upstream: `read_observation` requires a tip slot, and every
            // query resolves its epoch/anchor from `block`.
            "block" => Some("no tip slot ⇒ the read already errors"),
            // A join spine, never a source of truth: it only narrows rows another table produced.
            "tx" => Some("join spine behind block/tx_out/tx_metadata, all covered"),
            // Empty ⇒ the chain has no outputs at all, which the tip check already rules out.
            "tx_out" => Some("empty only on an empty chain, covered by the tip check"),
            // The beacon gate joins them, so one empty ⇒ both empty, and ma_tx_out IS probed.
            "multi_asset" => Some("joined 1:1 with the probed ma_tx_out"),
            _ => None,
        };
        if global.is_some() {
            return global;
        }
        match (sql_name, table) {
            // Reached only through the probed epoch_stake (voting power) / pool_owner (role).
            ("STAKE_OBSERVATION_SQL", "stake_address") => Some("gated by the probed epoch_stake"),
            ("ROLE_OBSERVATION_SQL", "stake_address") => Some("gated by the probed pool_hash"),
            // Pool sub-tables: pool_hash IS probed in this query, and these are meaningless without it.
            ("ROLE_OBSERVATION_SQL", "pool_update" | "pool_retire" | "pool_owner") => {
                Some("gated by the probed pool_hash in the same query")
            }
            // `drep_hash` / `drep_registration` were exempted here as "gated by the probed drep_distr;
            // absence can only shrink the live set". Both halves were wrong: `drep_target_ok` is only
            // consumed when the live set is NON-empty, so it is disarmed by the very emptiness it would
            // have to catch, and "shrink the live set" is not benign — it strips every dRep badge and
            // zeroes every dRep chamber weight. They are probed directly now (`drep_ok`/`drep_reg_ok`).
            // Reached only by a foreign key from epoch_stake, whose target epoch this query probes.
            ("POOL_STAKE_SQL", "pool_hash") => Some(
                "FK-reached from the probed epoch_stake; probed directly in ROLE_OBSERVATION_SQL",
            ),
            _ => None,
        }
    }

    #[test]
    fn every_table_the_consensus_reads_depend_on_is_probed_or_explicitly_exempt() {
        // The fail-closed contract is maintained BY HAND — one `EXISTS (SELECT 1 FROM …)` per table
        // whose emptiness would be misread as authoritative absence. Nothing enforced that the list
        // kept up with the queries, and it had already fallen behind on two tables. This makes adding
        // an unprobed dependency a test failure instead of a silent consensus hazard.
        for (name, sql) in all_sql() {
            for table in tables(sql) {
                // Prefix match, not an exact one: a probe may legitimately narrow (`drep_distr` is
                // gated as `EXISTS (SELECT 1 FROM drep_distr WHERE epoch_no = …)`, which is a
                // STRONGER check than bare non-emptiness).
                let probed = sql.contains(&format!("EXISTS (SELECT 1 FROM {table}"));
                assert!(
                    probed || exempt(name, &table).is_some(),
                    "{name} reads `{table}` with no `EXISTS (SELECT 1 FROM {table})` probe and no \
                     entry in `exempt()`. An empty `{table}` would be read as authoritative absence \
                     — decide which it is: add the probe (and abstain on it), or exempt it with the \
                     reason it cannot be misread.",
                );
            }
        }
    }

    #[test]
    fn the_two_holes_the_audit_found_are_probed() {
        // Pinned individually, because these are the ones that were actually missing: a db-sync with
        // multi-asset insertion off read as "every vault unlocked", and one with metadata indexing off
        // read as "no Calidus registration exists".
        assert!(OBSERVATION_SQL.contains("EXISTS (SELECT 1 FROM ma_tx_out)"));
        assert!(OBSERVATION_SQL.contains("EXISTS (SELECT 1 FROM tx_in)"));
        assert!(ROLE_OBSERVATION_SQL.contains("EXISTS (SELECT 1 FROM tx_metadata)"));
        assert!(ROLE_OBSERVATION_SQL.contains("EXISTS (SELECT 1 FROM pool_hash)"));
    }

    #[test]
    fn every_column_the_readers_address_by_name_exists_in_its_query() {
        // The readers index columns by SQL ALIAS, not by position, because a positional index silently
        // re-points at its neighbour the moment a probe column is inserted above it — exactly what
        // happened when the `meta_ok` probe was added to the role read and shifted `drep_stake` from 6
        // to 7. That mis-read is a hard `Err` on EVERY block, so the sole writer of Cardano weight stops
        // dead, and nothing in this file's SQL-string assertions could see it.
        //
        // Names are only safe while the alias and the reader agree, so pin the two together here: rename
        // an alias without re-pointing its reader and this fails at build time instead of on the producer.
        for (query, name, col) in [
            (OBSERVATION_SQL, "OBSERVATION_SQL", "tx_in_ok"),
            (OBSERVATION_SQL, "OBSERVATION_SQL", "ma_ok"),
            (
                STAKE_OBSERVATION_SQL,
                "STAKE_OBSERVATION_SQL",
                "epoch_stake_ok",
            ),
            (STAKE_OBSERVATION_SQL, "STAKE_OBSERVATION_SQL", "target_ok"),
            (STAKE_OBSERVATION_SQL, "STAKE_OBSERVATION_SQL", "rows"),
            (ROLE_OBSERVATION_SQL, "ROLE_OBSERVATION_SQL", "pool_ok"),
            (ROLE_OBSERVATION_SQL, "ROLE_OBSERVATION_SQL", "meta_ok"),
            (ROLE_OBSERVATION_SQL, "ROLE_OBSERVATION_SQL", "drep_ok"),
            (ROLE_OBSERVATION_SQL, "ROLE_OBSERVATION_SQL", "drep_reg_ok"),
            (
                ROLE_OBSERVATION_SQL,
                "ROLE_OBSERVATION_SQL",
                "registrations",
            ),
            (ROLE_OBSERVATION_SQL, "ROLE_OBSERVATION_SQL", "active_pools"),
            (ROLE_OBSERVATION_SQL, "ROLE_OBSERVATION_SQL", "owner_pools"),
            (ROLE_OBSERVATION_SQL, "ROLE_OBSERVATION_SQL", "live_dreps"),
            (
                ROLE_OBSERVATION_SQL,
                "ROLE_OBSERVATION_SQL",
                "drep_target_ok",
            ),
            (ROLE_OBSERVATION_SQL, "ROLE_OBSERVATION_SQL", "drep_stake"),
            (POOL_STAKE_SQL, "POOL_STAKE_SQL", "target_ok"),
            (POOL_STAKE_SQL, "POOL_STAKE_SQL", "pool_stake"),
        ] {
            assert!(
                query.contains(&format!("AS {col}")),
                "{name} has no `AS {col}` alias, but its reader addresses that column by name — the \
                 read would fail closed on every block. Re-point the reader, or restore the alias.",
            );
        }
        // The vault read's first four columns are projected unaliased, so their names come from the
        // qualified expressions themselves. Pin that projection verbatim for the same reason.
        assert!(
            OBSERVATION_SQL
                .contains("SELECT f.tip_slot, a.anchor_slot, a.anchor_hash, v.matches,"),
            "`read_observation` addresses tip_slot/anchor_slot/anchor_hash/matches by name; those names \
             come from this unaliased projection, so changing it silently breaks the read",
        );
    }

    #[test]
    fn the_table_scan_sees_past_a_comma_and_a_digit() {
        // The scan feeds the probe test below, so anything it cannot see is an unprobed db-sync
        // dependency reported as safe — the exact silent-consensus hazard that test exists to prevent.
        // The shapes it has to get right — the real queries already use the first two:
        //   * a comma-separated FROM list, including an item trailing a JOIN's ON clause;
        //   * a table name containing a digit (`all(is_ascii_lowercase)` dropped it);
        //   * a parenthesized join, a sub-select sitting IN a FROM list, and a comma inside a
        //     function call — the three the paren-depth tracking exists to tell apart.
        let set = |ts: &[&str]| ts.iter().map(|s| s.to_string()).collect::<BTreeSet<_>>();

        assert_eq!(
            tables(
                "SELECT 1 FROM epoch_stake es, reward r \
                 JOIN pool_hash ph ON ph.id = es.pool_id, ma_tx_out2 m WHERE r.id = 1"
            ),
            set(&["epoch_stake", "ma_tx_out2", "pool_hash", "reward"]),
        );
        // A PARENTHESIZED join still names real tables — bailing on the leading `(` lost `tx_in`.
        assert_eq!(
            tables("SELECT 1 FROM (tx_in ti JOIN tx t ON t.id = ti.tx_in_id) WHERE 1 = 1"),
            set(&["tx_in", "tx"]),
        );
        // A sub-select in a FROM list must not close the list CONTAINING it: `ma_tx_out` is a real
        // dependency sitting after one, and losing it loses its probe requirement too.
        assert_eq!(
            tables("SELECT 1 FROM (SELECT a FROM block b) q, ma_tx_out m WHERE 1 = 1"),
            set(&["block", "ma_tx_out"]),
        );
        // A comma INSIDE a function call is not a list separator. Treating it as one invents a table
        // (`dflt`) that no probe can satisfy, failing the guard below for a query that is fine.
        assert_eq!(
            tables(
                "SELECT 1 FROM epoch_stake es JOIN pool_hash ph \
                 ON ph.id = coalesce(es.pool_id, dflt) WHERE es.id = 1"
            ),
            set(&["epoch_stake", "pool_hash"]),
        );
        // Aliases, CTEs and sub-select aliases still stay out.
        assert_eq!(
            tables(
                "WITH params AS (SELECT 1 AS x), t AS (SELECT 1 FROM block b, params p) \
                 SELECT * FROM (SELECT a, b FROM t) q, params p"
            ),
            set(&["block"]),
        );
    }

    /// The exact unspent-as-of-reference clause. Pinned as a string because it is the half of the
    /// spentness rule that lives in SQL, and its sibling half lives in Rust — the test below is what
    /// holds the two together, and it can only do that if it knows which clause to model.
    const SPENTNESS_CLAUSE: &str =
        "AND (ti.id IS NULL OR sb.slot_no IS NULL OR sb.slot_no > p.ref)";

    /// The `spent_at` JSON `OBSERVATION_SQL` emits for a given `(consuming tx_in present, spending block
    /// slot)`, per its `CASE WHEN ti.id IS NULL THEN NULL ELSE json_build_object('slot_no', sb.slot_no)`.
    fn emitted_spent_at(ti_present: bool, sb_slot: Option<u64>) -> serde_json::Value {
        if !ti_present {
            serde_json::Value::Null
        } else {
            serde_json::json!({ "slot_no": sb_slot })
        }
    }

    /// A Rust model of [`SPENTNESS_CLAUSE`], evaluated on the same inputs Postgres would see. SQL
    /// three-valued logic collapses here because the clause is a plain disjunction of the three shapes.
    fn sql_predicate_keeps(ti_present: bool, sb_slot: Option<u64>, reference: u64) -> bool {
        !ti_present || sb_slot.is_none() || sb_slot.is_some_and(|s| s > reference)
    }

    #[test]
    fn the_sql_spentness_filter_and_the_rust_one_agree_on_every_shape() {
        // The vault read now PRE-FILTERS spent UTxOs in Postgres, but `observe_as_of` still applies its
        // own spentness test to whatever arrives. That is only an optimization while the two agree
        // EXACTLY: a row the SQL drops that the reduction would have kept is a silent unlock of real
        // locked ADA, and a row the SQL keeps that the reduction drops is merely wasted bytes. The
        // dangerous direction is unlockable in one line, so pin both halves against one case table.
        //
        // The third case is the one that looks like a bug and is not: a UTxO spent AFTER the reference
        // was still locked AT the reference, counts, and can win the largest-wins fold. The fourth is
        // the fail-OPEN parse — `observe_as_of` reads an unresolvable spend slot as "not spent", so the
        // SQL must keep that row rather than tidily dropping it.
        const REF: u64 = 1_000_000;
        const VAULT: &str = "168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7";
        const BEACON: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        assert!(
            OBSERVATION_SQL.contains(SPENTNESS_CLAUSE),
            "the vault read's unspent-as-of-reference clause moved; this test models it verbatim, so \
             re-derive the model with it or the two halves of the spentness rule can drift apart",
        );

        for (name, ti_present, sb_slot, expect_kept) in [
            ("never spent", false, None, true),
            (
                "spent strictly after the reference",
                true,
                Some(REF + 1),
                true,
            ),
            ("spend slot unresolvable (fails OPEN)", true, None, true),
            ("spent exactly at the reference", true, Some(REF), false),
            ("spent before the reference", true, Some(REF - 1), false),
        ] {
            let kept_by_sql = sql_predicate_keeps(ti_present, sb_slot, REF);
            let m = serde_json::json!({
                "transaction_id": "00",
                "output_index": 0,
                "value": {
                    "coins": "200000000",
                    "assets": { format!("{VAULT}.{BEACON}"): "1" },
                },
                "created_at": { "slot_no": 10 },
                "spent_at": emitted_spent_at(ti_present, sb_slot),
            });
            let kept_by_reduction = !crate::reduction::observe_as_of(&[m], VAULT, REF).is_empty();

            assert_eq!(
                kept_by_sql, expect_kept,
                "`{name}`: the SQL predicate disagrees with the pinned expectation",
            );
            assert_eq!(
                kept_by_reduction, expect_kept,
                "`{name}`: `observe_as_of` disagrees with the pinned expectation",
            );
            assert_eq!(
                kept_by_sql, kept_by_reduction,
                "`{name}`: the SQL pre-filter and `observe_as_of` disagree. The SQL clause is only \
                 sound while it drops EXACTLY the rows the reduction was already skipping — this \
                 mismatch either unlocks locked ADA or is dead weight, so fix the clause, never the \
                 expectation",
            );
        }
    }

    #[test]
    fn the_spentness_filter_does_not_reach_the_candidate_commitment_gate() {
        // `candidate_tuples` (the `inputs_commitment` pre-image) deliberately applies NO time filter, so
        // pre-filtering in SQL shrinks the candidate set and moves the commitment. That is safe only
        // because the runtime excludes the commitment from `check_inherent`'s equality test — assert the
        // property this change relies on, so a future runtime that starts comparing it fails here.
        const REF: u64 = 1_000_000;
        const VAULT: &str = "168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7";
        const BEACON: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let row = |spent: Option<u64>| {
            serde_json::json!({
                "transaction_id": "00",
                "output_index": 0,
                "value": { "coins": "200000000", "assets": { format!("{VAULT}.{BEACON}"): "1" } },
                "created_at": { "slot_no": 10 },
                "spent_at": emitted_spent_at(spent.is_some(), spent),
            })
        };
        // What the OLD query returned (a spent-before-ref row alongside the live one) versus the NEW one.
        let before = [row(Some(REF - 1)), row(None)];
        let after = [row(None)];

        assert_eq!(
            crate::reduction::observe_as_of(&before, VAULT, REF),
            crate::reduction::observe_as_of(&after, VAULT, REF),
            "the pre-filter must not move the reduced entries — that set IS consensus",
        );
        assert_ne!(
            crate::reduction::inputs_commitment(&before, VAULT),
            crate::reduction::inputs_commitment(&after, VAULT),
            "the pre-filter is expected to move the candidate commitment; if it stops doing so this \
             test is no longer describing the change it guards",
        );
    }

    #[test]
    fn every_ordered_aggregate_has_a_total_order() {
        // `json_agg` without an ORDER BY leaves row order to the planner, so two nodes can build
        // different Vecs from identical data. The reduction re-canonicalises the vault/stake/role sets
        // (BTreeMap/BTreeSet), which is what makes that safe — EXCEPT for `registrations`, whose
        // chain order decides the same-nonce Calidus winner. That one must stay explicitly ordered.
        assert!(
            ROLE_OBSERVATION_SQL.contains("json_agg(encode(bytes,'hex') ORDER BY id)"),
            "the registration aggregate decides the equal-nonce Calidus tie-break, so its order is \
             consensus-critical and must not be left to the planner",
        );
    }
}
