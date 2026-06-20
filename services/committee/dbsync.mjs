// Read-only Cardano **db-sync** reader for the committee tooling — the off-chain twin of the node's
// `node/src/dbsync.rs`. Replaces the retired Kupo `/matches` reads in the observation path (shadow-diff's
// recompute oracle, sync-weight's set_stake driver, obs-shadow-demo). Ogmios still handles L1 tx
// submission elsewhere; db-sync is read-only and cannot submit.
//
// The SQL here is the JS twin of `node/src/dbsync.rs::OBSERVATION_SQL` and the follower's `vault.py` — all
// three emit the SAME Kupo-shaped match JSON, so the shared pure reduction (`observeAsOf` / `pickLargest`)
// consumes them BYTE-IDENTICALLY (only the data source moved). Determinism choices, all mirrored across
// the three languages (a divergence is a chain fork):
//   • spentness from `tx_in` (canonical ledger data), NOT `consumed_by_tx_id` (a denormalized,
//     config-dependent column — observed NULL for a known-spent vault UTxO on the live instance);
//   • coins / quantities emitted as `::text` (lovelace can exceed 2^53 — `MaxStakeWeight` = 4.5e16 — so a
//     JS Number would lose precision; `pg` also returns int8/numeric as strings by default);
//   • driven from `tx_out.payment_cred = <vault script hash>` (indexed: `idx_tx_out_payment_cred`) — the
//     vault script address equals the beacon policy id, the indexed analog of Kupo `/matches/{policy}.*`;
//   • the deterministic stable-block anchor is the single `block` row at `max(slot_no) <= reference`
//     (≤1 block/slot on settled history ⇒ unique across every fully-synced db-sync — the false-Mismatch
//     fix Kupo's sparse, tip-relative `/checkpoints` ladder could not give).
// See docs/IN-PROTOCOL-OBSERVATION.md §15.3.
import pg from "pg";

// One consistent-snapshot read: freshness tip + the deterministic stable-block anchor + the vault matches
// AS-OF `$1` (the node's exact read; in-protocol-observation §15.3). `$2` = the vault policy id hex.
const OBSERVATION_SQL = `
WITH params AS (SELECT $1::bigint AS ref, $2::text AS pol),
freshness AS (SELECT max(slot_no) AS tip_slot FROM block),
anchor AS (
  SELECT b.slot_no AS anchor_slot, encode(b.hash,'hex') AS anchor_hash
  FROM block b, params p WHERE b.slot_no <= p.ref ORDER BY b.slot_no DESC LIMIT 1),
vault AS (
  SELECT COALESCE(json_agg(json_build_object(
    'transaction_id', encode(ctx.hash,'hex'),
    'output_index',   o.index,
    'value', json_build_object(
       'coins',  o.value::text,
       'assets', (SELECT json_object_agg(encode(a.policy,'hex')||'.'||encode(a.name,'hex'), m.quantity::text)
                  FROM ma_tx_out m JOIN multi_asset a ON a.id = m.ident
                  WHERE m.tx_out_id = o.id AND a.policy = decode(p.pol,'hex'))),
    'created_at', json_build_object('slot_no', cb.slot_no),
    'spent_at',   CASE WHEN ti.id IS NULL THEN NULL ELSE json_build_object('slot_no', sb.slot_no) END)),
    '[]'::json) AS matches
  FROM tx_out o
  JOIN tx ctx   ON ctx.id = o.tx_id
  JOIN block cb ON cb.id = ctx.block_id
  LEFT JOIN tx_in ti ON ti.tx_out_id = o.tx_id AND ti.tx_out_index = o.index
  LEFT JOIN tx stx   ON stx.id = ti.tx_in_id
  LEFT JOIN block sb ON sb.id = stx.block_id, params p
  WHERE o.payment_cred = decode(p.pol,'hex')
    AND cb.slot_no <= p.ref
    AND EXISTS (SELECT 1 FROM ma_tx_out m JOIN multi_asset a ON a.id = m.ident
                WHERE m.tx_out_id = o.id AND a.policy = decode(p.pol,'hex')))
SELECT f.tip_slot, a.anchor_slot, a.anchor_hash, v.matches, (SELECT EXISTS (SELECT 1 FROM tx_in)) AS tx_in_ok
FROM freshness f, vault v LEFT JOIN anchor a ON true`;

// Currently-unspent vault UTxOs (the Kupo `?unspent` analog), Kupo-shaped, for the legacy `pickLargest`
// fast path. `$1` = vault policy id hex. `spent_at` is always null (these are unspent by construction).
const UNSPENT_SQL = `
SELECT (SELECT EXISTS (SELECT 1 FROM tx_in)) AS tx_in_ok,
  COALESCE(json_agg(json_build_object(
  'transaction_id', encode(ctx.hash,'hex'),
  'output_index',   o.index,
  'value', json_build_object(
     'coins',  o.value::text,
     'assets', (SELECT json_object_agg(encode(a.policy,'hex')||'.'||encode(a.name,'hex'), m.quantity::text)
                FROM ma_tx_out m JOIN multi_asset a ON a.id = m.ident
                WHERE m.tx_out_id = o.id AND a.policy = decode($1,'hex'))),
  'created_at', json_build_object('slot_no', cb.slot_no),
  'spent_at',   NULL)), '[]'::json) AS matches
FROM tx_out o
JOIN tx ctx   ON ctx.id = o.tx_id
JOIN block cb ON cb.id = ctx.block_id
WHERE o.payment_cred = decode($1,'hex')
  AND NOT EXISTS (SELECT 1 FROM tx_in ti WHERE ti.tx_out_id = o.tx_id AND ti.tx_out_index = o.index)
  AND EXISTS (SELECT 1 FROM ma_tx_out m JOIN multi_asset a ON a.id = m.ident
              WHERE m.tx_out_id = o.id AND a.policy = decode($1,'hex'))`;

// Connect, run `fn(client)`, always disconnect. Plaintext (the read-only `cogno_reader` role; TLS is a
// MAINNET PREREQUISITE) — `pg` honors the URL and uses no SSL by default, like the node's `NoTls`.
async function withClient(url, fn) {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end().catch(() => {});
	}
}

const lower = (h) => String(h).toLowerCase().replace(/^0x/, "");

// Fail-closed: the spentness join requires a tx_in-ENABLED db-sync. Under `--consumed-tx-out` mode tx_in is
// empty (spentness moves to consumed_by_tx_id), which would make this read emit spent_at=NULL for spent
// vaults ⇒ a wrong/forking observation. Mirror Midnight's `SELECT EXISTS (SELECT 1 FROM tx_in)` probe and
// THROW (the caller fails closed) — we do NOT fall back to the unreliable consumed_by_tx_id column.
function assertTxInEnabled(txInOk) {
	if (txInOk === false)
		throw new Error("db-sync tx_in table is empty (--consumed-tx-out mode?); requires a tx_in-enabled db-sync (fail closed)");
}

// AS-OF read. Returns { tipSlot: BigInt, anchor: { slot: BigInt, hash } | null, matches: [...] }.
export async function readObservation(url, vaultHex, refSlot) {
	return withClient(url, async (c) => {
		const { rows } = await c.query(OBSERVATION_SQL, [String(refSlot), lower(vaultHex)]);
		const r = rows[0] ?? {};
		assertTxInEnabled(r.tx_in_ok);
		const tipSlot = r.tip_slot != null ? BigInt(r.tip_slot) : null;
		const anchor =
			r.anchor_slot != null && r.anchor_hash != null
				? { slot: BigInt(r.anchor_slot), hash: String(r.anchor_hash).toLowerCase() }
				: null;
		return { tipSlot, anchor, matches: r.matches ?? [] };
	});
}

// db-sync freshness tip slot (BigInt) — `max(block.slot_no)`.
export async function tipSlot(url) {
	return withClient(url, async (c) => {
		const { rows } = await c.query("SELECT max(slot_no) AS tip FROM block");
		return rows[0]?.tip != null ? BigInt(rows[0].tip) : null;
	});
}

// Currently-unspent vault matches (Kupo `?unspent` analog) for the legacy pickLargest fast path.
export async function readUnspentMatches(url, vaultHex) {
	return withClient(url, async (c) => {
		const { rows } = await c.query(UNSPENT_SQL, [lower(vaultHex)]);
		assertTxInEnabled(rows[0]?.tx_in_ok);
		return rows[0]?.matches ?? [];
	});
}
