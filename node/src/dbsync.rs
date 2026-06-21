//! Read-only Cardano **db-sync** client for the in-protocol observation (D4) — the on-node Cardano IO,
//! kept separate from [`crate::cardano_observer`] (which holds the pure reduction).
//!
//! ONE read-only snapshot per block ([`read_observation`]) returns the three things the node-side
//! `InherentDataProvider` needs, from a single consistent Postgres MVCC snapshot (so the tip, anchor and
//! matches all come from ONE atomic view — they cannot diverge across an inter-call rollback):
//!   1. `tip_slot` — db-sync freshness (`max(block.slot_no)`). The node ABSTAINS (→ `CannotVerify`) when
//!      its own db-sync is behind the reference (a point-existence freshness guard).
//!   2. `anchor` — the **deterministic** stable Cardano block AT/UNDER the reference: the single `block`
//!      row with the max `slot_no <= reference`. Cardano has ≤1 block per slot on settled history, so this
//!      is unique and identical across every fully-synced db-sync (in-protocol-observation §15.3).
//!   3. `matches` — the vault UTxOs shaped (in SQL) into the canonical match JSON the pure reduction
//!      (`observe_as_of` / `candidate_tuples`) consumes BYTE-IDENTICALLY, UNCHANGED. Spentness is read
//!      from `tx_in` (canonical ledger data), NOT `consumed_by_tx_id` (a denormalized, config-dependent
//!      column — observed NULL for a known-spent vault UTxO on the live instance — which would be a
//!      cross-node determinism trap). A tx_in-ENABLED db-sync is REQUIRED: under `--consumed-tx-out` mode
//!      `tx_in` is empty (spentness moves to `consumed_by_tx_id`), so the read probes
//!      `EXISTS (SELECT 1 FROM tx_in)` and ABSTAINS otherwise (fail-closed; we do not fall back to the
//!      unreliable column). Coins/quantities are emitted as STRINGS (lovelace can exceed 2^53;
//!      `MaxStakeWeight` = 4.5e16). Driven from `tx_out.payment_cred = <vault script hash>` (indexed):
//!      the vault script address equals the beacon policy id (verified: 0 escaped beacons in all preprod
//!      history; ADA-only-at-address UTxOs are excluded by the asset `EXISTS`).

use crate::cardano_observer::hex32;
use pallet_cardano_observer::{BeaconName, StakeCredential};
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
    AND EXISTS (SELECT 1 FROM ma_tx_out m JOIN multi_asset a ON a.id = m.ident \
                WHERE m.tx_out_id = o.id AND a.policy = decode(p.pol,'hex'))) \
SELECT f.tip_slot, a.anchor_slot, a.anchor_hash, v.matches, (SELECT EXISTS (SELECT 1 FROM tx_in)) AS tx_in_ok \
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
	let (client, connection) =
		tokio_postgres::connect(url, NoTls).await.map_err(|e| format!("db-sync connect failed: {e}"))?;
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
		if slot.as_ref().map_or(true, |c| c.is_closed()) {
			*slot = Some(connect(url).await?);
		}
		let ref_i64 = i64::try_from(reference_slot).map_err(|_| "reference slot exceeds i64".to_string())?;
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
			},
		};
		drop(slot); // release the connection lock before the pure decode work

		// Fail-closed: the spentness join requires a tx_in-ENABLED db-sync. Under db-sync `--consumed-tx-out`
		// mode the `tx_in` consuming rows are pruned (spentness lives in `tx_out.consumed_by_tx_id` instead),
		// so the `LEFT JOIN tx_in` would silently emit `spent_at = NULL` for an actually-spent vault UTxO ⇒ a
		// WRONG observation (a spent vault read as locked) and a cross-node fork at the enforced cutover. We
		// mirror Midnight's `SELECT EXISTS (SELECT 1 FROM tx_in)` probe and ABSTAIN — the consensus-safe
		// choice. We do NOT fall back to `consumed_by_tx_id`: it was observed unreliable (NULL for a
		// known-spent vault) on the live instance, so a tx_in-enabled db-sync is a hard requirement
		// (MAINNET PREREQUISITE: do NOT run db-sync with `--consumed-tx-out`).
		if !row.get::<_, bool>(4) {
			return Err("db-sync tx_in table is empty (--consumed-tx-out mode?); the observation requires a \
			            tx_in-enabled db-sync — abstaining (fail closed)"
				.to_string());
		}

		let tip_slot = row
			.get::<_, Option<i64>>(0)
			.and_then(|s| u64::try_from(s).ok())
			.ok_or_else(|| "db-sync returned no tip slot".to_string())?;
		// anchor: both columns present + the hash is 32-byte hex ⇒ Some; otherwise None (fail closed).
		let anchor = match (row.get::<_, Option<i64>>(1), row.get::<_, Option<String>>(2)) {
			(Some(slot_no), Some(hash)) => match (u64::try_from(slot_no).ok(), hex32(&hash)) {
				(Some(s), Some(h)) => Some((s, h)),
				_ => None,
			},
			_ => None,
		};
		let matches = row
			.get::<_, serde_json::Value>(3)
			.as_array()
			.cloned()
			.ok_or_else(|| "db-sync matches column was not a JSON array".to_string())?;
		Ok(DbsyncRead { tip_slot, anchor, matches })
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
		return Ok(DbsyncStakeRead { entries: Vec::new() });
	}
	let read = async {
		let mut slot = client_cell().lock().await;
		if slot.as_ref().map_or(true, |c| c.is_closed()) {
			*slot = Some(connect(url).await?);
		}
		let ref_i64 = i64::try_from(reference_slot).map_err(|_| "reference slot exceeds i64".to_string())?;
		let lookback_i64 = i64::try_from(lookback).map_err(|_| "lookback exceeds i64".to_string())?;
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
			},
		};
		drop(slot);

		// Fail-closed: epoch_stake must be populated, and the target epoch must be snapshotted (else a
		// not-yet-indexed node would read 0 for a real staker → a false unlock-clamp / cross-node fork).
		if !row.get::<_, bool>(0) {
			return Err("db-sync epoch_stake table is empty; the voting-power read requires a populated \
			            epoch_stake — abstaining (fail closed)"
				.to_string());
		}
		if !row.get::<_, bool>(1) {
			return Err("db-sync has no epoch_stake snapshot for the target epoch yet (source behind) — \
			            abstaining (defer/CannotVerify)"
				.to_string());
		}
		let rows = row
			.get::<_, serde_json::Value>(2)
			.as_array()
			.cloned()
			.ok_or_else(|| "db-sync epoch_stake rows column was not a JSON array".to_string())?;
		let mut entries: Vec<(StakeCredential, u128)> = Vec::with_capacity(rows.len());
		for r in &rows {
			let cred_hex = r.get("cred").and_then(|v| v.as_str()).ok_or("missing cred")?;
			let total = r
				.get("total")
				.and_then(|v| v.as_str())
				.and_then(|s| s.parse::<u128>().ok())
				.ok_or("bad total")?;
			let bytes = hex28(cred_hex).ok_or("bad credential hex")?;
			entries.push((bytes, total));
		}
		Ok(DbsyncStakeRead { entries })
	};

	tokio::time::timeout(DBSYNC_TIMEOUT, read)
		.await
		.map_err(|_| format!("db-sync epoch_stake read timed out after {}s", DBSYNC_TIMEOUT.as_secs()))?
}

/// Parse a 56-char (28-byte) hex string into a `StakeCredential`; `None` on bad length/chars.
fn hex28(s: &str) -> Option<StakeCredential> {
	let s = s.strip_prefix("0x").unwrap_or(s);
	if s.len() != 56 {
		return None;
	}
	let b = s.as_bytes();
	let mut out = [0u8; 28];
	for i in 0..28 {
		let hi = (b[2 * i] as char).to_digit(16)?;
		let lo = (b[2 * i + 1] as char).to_digit(16)?;
		out[i] = ((hi << 4) | lo) as u8;
	}
	Some(out)
}
