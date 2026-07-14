// Read-only Cardano **db-sync** reader for the off-chain tooling — the JS twin of the node's
// `node/src/dbsync.rs`. The observation reads (shadow-diff's recompute oracle, sync-weight's set_stake
// driver, obs-shadow-demo) all source the talk_vault here; the write-path helpers at the bottom serve the
// anchor-relayer + the M2d demo scripts. Ogmios still handles L1 tx submission; db-sync is read-only and
// cannot submit.
//
// The OBSERVATION SQL here is the JS twin of `node/src/dbsync.rs::OBSERVATION_SQL` and the follower's
// `vault.py` — all three emit the SAME match JSON, so the shared pure reduction (`observeAsOf` /
// `pickLargest`) consumes them BYTE-IDENTICALLY. Determinism choices, all mirrored across the three
// languages (a divergence is a chain fork):
//   • spentness from `tx_in` (canonical ledger data), NOT `consumed_by_tx_id` (a denormalized,
//     config-dependent column — observed NULL for a known-spent vault UTxO on the live instance);
//   • coins / quantities emitted as `::text` (lovelace can exceed 2^53 — `MaxStakeWeight` = 4.5e16 — so a
//     JS Number would lose precision; `pg` also returns int8/numeric as strings by default);
//   • driven from `tx_out.payment_cred = <vault script hash>` (indexed: `idx_tx_out_payment_cred`) — the
//     vault script address equals the beacon policy id;
//   • the deterministic stable-block anchor is the single `block` row at `max(slot_no) <= reference`
//     (≤1 block/slot on settled history ⇒ unique across every fully-synced db-sync).
// See docs/IN-PROTOCOL-OBSERVATION.md.
import pg from "pg";

// One consistent-snapshot read: freshness tip + the deterministic stable-block anchor + the vault matches
// AS-OF `$1` (the node's exact read). `$2` = the vault policy id hex.
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

// Currently-unspent vault UTxOs for the legacy `pickLargest` fast path. `$1` = vault policy id hex.
// `spent_at` is always null (these are unspent by construction).
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

// Currently-unspent vault matches for the legacy pickLargest fast path.
export async function readUnspentMatches(url, vaultHex) {
	return withClient(url, async (c) => {
		const { rows } = await c.query(UNSPENT_SQL, [lower(vaultHex)]);
		assertTxInEnabled(rows[0]?.tx_in_ok);
		return rows[0]?.matches ?? [];
	});
}

// ── Stake-key VOTING POWER observation (epoch_stake) ─────────────────────────────────────────────
// The voting-power source (spec 114): the TOTAL Cardano stake of a PROVEN stake credential, read from
// db-sync's per-epoch `epoch_stake` snapshot — the same snapshot Cardano uses for leader election and
// CIP-1694/Catalyst use for voting power. Deterministic + manipulation-resistant (an epoch snapshot is
// immutable once closed; the ~2-epoch lookback resists borrow-and-snapshot). The committee folds this
// per bound stake credential and pushes it on-chain via `talkStake.set_voting_power` (op.mjs). Distinct
// from the vault observation above: that meters POSTING capacity from locked ADA; this drives VOTES.

// The Shelley-era reward-address header nibble for a vkey stake credential is 0b1110; the low nibble is
// the network (0 = testnet/preprod, 1 = mainnet). db-sync's `stake_address.hash_raw` is that 29-byte
// value (1 header byte + the 28-byte credential). Map a bare 28-byte stake credential → that hash_raw.
export function rewardHashRaw(stakeCredHex, network = 0) {
	const cred = lower(stakeCredHex);
	if (cred.length !== 56) throw new Error(`stake credential must be 28 bytes (56 hex), got ${cred.length}`);
	const header = (0b1110 << 4) | (network & 0x0f); // 0xe0 testnet, 0xe1 mainnet
	return header.toString(16).padStart(2, "0") + cred;
}

// Total stake (lovelace) delegated under a stake credential AS-OF a given epoch. `$1` = the 29-byte
// reward `hash_raw` hex; `$2` = the epoch number. `::text` (totals can exceed 2^53). The probe column
// fails closed when epoch_stake is unpopulated (an empty table would read 0 for everyone — wrong).
const EPOCH_STAKE_SQL = `
SELECT (SELECT EXISTS (SELECT 1 FROM epoch_stake)) AS epoch_stake_ok,
  COALESCE((
    SELECT SUM(es.amount)::text
    FROM epoch_stake es
    JOIN stake_address sa ON sa.id = es.addr_id
    WHERE sa.hash_raw = decode($1,'hex') AND es.epoch_no = $2
  ), '0') AS total`;

function assertEpochStakeEnabled(ok) {
	if (ok === false)
		throw new Error("db-sync epoch_stake table is empty; the voting-power observation requires a populated epoch_stake (fail closed)");
}

// The latest epoch for which db-sync holds an `epoch_stake` snapshot (BigInt), or null if none. This is
// the deterministic "as-of" epoch the committee folds (the most recent immutable snapshot).
export async function latestStakeEpoch(url) {
	return withClient(url, async (c) => {
		const { rows } = await c.query("SELECT max(epoch_no) AS e FROM epoch_stake");
		return rows[0]?.e != null ? BigInt(rows[0].e) : null;
	});
}

// Total stake (BigInt lovelace) for a bare 28-byte stake credential at `epochNo`, on `network`
// (0 = preprod). Throws (fail closed) if epoch_stake is unpopulated.
export async function stakeForCredential(url, stakeCredHex, epochNo, network = 0) {
	return withClient(url, async (c) => {
		const { rows } = await c.query(EPOCH_STAKE_SQL, [rewardHashRaw(stakeCredHex, network), String(epochNo)]);
		assertEpochStakeEnabled(rows[0]?.epoch_stake_ok);
		return BigInt(rows[0]?.total ?? "0");
	});
}

// ── Write-path helpers (the anchor-relayer + the M2d demo scripts) ───────────────────────────────
// These are NOT part of the consensus observation lockstep above (no Rust/Python twin): they serve the
// L1 WRITE path — the relayer/wallet's own unspent UTxOs (so MeshTxBuilder can coin-select), tx-in-a-
// block confirmation by hash, and reading a tx's metadata back. Ogmios still SUBMITS the tx + serves
// cost models (db-sync is read-only). Same MAINNET PREREQUISITE: db-sync FULL + tx_in-enabled + TLS.
// Assumes the standard db-sync schema (the denormalized `tx_out.address` text column), like the node.

// Unspent UTxOs at a bech32 address, already shaped as MeshJS `UTxO` objects:
//   { input: { txHash, outputIndex }, output: { address, amount: [{ unit, quantity }] } }
// `amount` lists lovelace first then each native asset as a MeshJS unit (policyId ++ assetNameHex, no
// separator); quantities are `::text` (lovelace can exceed 2^53). `$1` = the bech32 address.
const ADDRESS_UTXOS_SQL = `
SELECT (SELECT EXISTS (SELECT 1 FROM tx_in)) AS tx_in_ok,
  COALESCE(json_agg(json_build_object(
    'input',  json_build_object('txHash', encode(ctx.hash,'hex'), 'outputIndex', o.index),
    'output', json_build_object(
       'address', o.address,
       'amount', (
         SELECT json_agg(amt) FROM (
           SELECT json_build_object('unit', 'lovelace', 'quantity', o.value::text) AS amt
           UNION ALL
           SELECT json_build_object('unit', encode(a.policy,'hex') || encode(a.name,'hex'), 'quantity', m.quantity::text)
           FROM ma_tx_out m JOIN multi_asset a ON a.id = m.ident WHERE m.tx_out_id = o.id
         ) z
       )))), '[]'::json) AS utxos
FROM tx_out o
JOIN tx ctx ON ctx.id = o.tx_id
WHERE o.address = $1
  AND NOT EXISTS (SELECT 1 FROM tx_in ti WHERE ti.tx_out_id = o.tx_id AND ti.tx_out_index = o.index)`;

// The unspent UTxOs at `address`, MeshJS-shaped. Throws on a non-tx_in db-sync (fail closed: NOT EXISTS
// (tx_in) would otherwise treat SPENT outputs as unspent and coin-select a vanished UTxO).
export async function fetchAddressUtxos(url, address) {
	return withClient(url, async (c) => {
		const { rows } = await c.query(ADDRESS_UTXOS_SQL, [address]);
		assertTxInEnabled(rows[0]?.tx_in_ok);
		return rows[0]?.utxos ?? [];
	});
}

// A MeshJS IFetcher SUBSET backed by db-sync — only the method the relayer + M2d tx-builders actually
// reach (fetchAddressUTxOs, via MeshWallet.getUtxos / coin selection). Protocol params + Plutus cost
// models come from Ogmios (fetchCostModels), so fetchProtocolParameters throws a clear pointer rather
// than silently returning empty data.
export function dbsyncFetcher(url) {
	return {
		async fetchAddressUTxOs(address) {
			return fetchAddressUtxos(url, address);
		},
		fetchProtocolParameters() {
			throw new Error("dbsyncFetcher: protocol params/cost models come from Ogmios — use setCostModels(await fetchCostModels()), not the fetcher.");
		},
	};
}

// The slot a tx landed in, or null if it is not (yet) in a db-sync block. db-sync rolls back WITH the
// chain, so a tx that was seen and is now null has rolled back — the relayer's confirmation/rollback signal.
export async function txSlot(url, txHash) {
	return withClient(url, async (c) => {
		const { rows } = await c.query(
			"SELECT b.slot_no AS slot FROM tx JOIN block b ON b.id = tx.block_id WHERE tx.hash = decode($1,'hex')",
			[lower(txHash)],
		);
		return rows[0]?.slot != null ? BigInt(rows[0].slot) : null;
	});
}

// The decoded metadata JSON for `txHash` under numeric `label` (db-sync `tx_metadata.json`, already the
// CBOR-decoded value the tx attached), or null if the tx has no metadata under that label — the anchor
// verify's Cardano witness read.
export async function txMetadata(url, txHash, label) {
	return withClient(url, async (c) => {
		const { rows } = await c.query(
			"SELECT md.json AS json FROM tx_metadata md JOIN tx ON tx.id = md.tx_id WHERE tx.hash = decode($1,'hex') AND md.key = $2",
			[lower(txHash), String(label)],
		);
		return rows[0]?.json ?? null;
	});
}
