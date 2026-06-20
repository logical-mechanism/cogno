// M6 (DR-07) — the FOLLOWER's vault→weight sync, driven through the 3-of-5 FollowerCommittee.
//
// This is the committee-driven successor to app/scripts/m2d-sync-weight.mjs (which writes set_stake
// via sudo over the stale-at-spec-106 PAPI descriptors). It observes the talk_vault beacon UTxOs via
// Cardano db-sync (LARGEST-WINS per identity, never sum), looks up the bound account
// (CognoGate.AccountOf), and writes `talk_stake.set_stake(account, weight = locked lovelace)` (+ primes
// the capacity battery) through the committee — so the crown-jewel weight authority is off single-key sudo.
//
// Modes:
//   live  : DBSYNC_URL set + VAULT_HASH file present → observe db-sync, largest-wins, set_stake per identity.
//   dev   : --account <ss58> --weight <lovelace> → set_stake for one account (no Cardano needed).
//
//   WS=ws://127.0.0.1:9944 node sync-weight.mjs --account 5Grw… --weight 100000000          # dev
//   WS=… DBSYNC_URL=postgres://… node sync-weight.mjs --via committee                       # live
//   ... --via sudo   # the EnsureRoot dev fallback
//
// Read safety (committee-1): the db-sync read that drives the crown-jewel weight fails CLOSED — a read
// error aborts the whole sync rather than writing a wrong/partial weight — and an optional reorg-burial
// gate (CONFIRM_DEPTH_SLOTS) reads AS-OF a stable reference slot (tip − depth) so a UTxO that could still
// roll back is NOT credited. The burial tip now comes from db-sync `max(slot_no)`, which lags the live
// chain tip slightly — that LAG IS SAFE: it makes the burial gate MORE conservative (an extra-buried
// reference can only withhold a too-fresh UTxO, never credit one early).
//
// ⚠ HONESTY (DR-07): single-operator stack ⇒ D2-SHAPED, not D2-TRUST. See docs/D2-custody-runbook.md.
import fs from "node:fs";
import { isMain } from "../_shared/cli.mjs";
import { statePaths, migrateStatePath } from "../_shared/paths.mjs";
// The DETERMINISTIC observation core (in-protocol-observation step 2): the largest-wins / floor / as-of-
// reference logic that BOTH this off-chain reader and (later) the in-node inherent share byte-identically.
// `lockToWeight` lives there now; re-exported below so committee.test.mjs's import is unchanged.
import { lockToWeight, observeAsOf } from "../_shared/observation.mjs";
export { lockToWeight };
import { connect, drive, has, operators, resolveCommittee, assertRealKeys, assertGenesis } from "./lib.mjs";
import { readObservation, readUnspentMatches, tipSlot } from "./dbsync.mjs";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const DBSYNC = process.env.DBSYNC_URL || process.env.DBSYNC;
// The locked-vault descriptor, defaulting under the durable data dir (COGNO_DATA_DIR / systemd
// StateDirectory) rather than volatile /tmp; an existing /tmp copy is migrated on first read.
const { file: VAULT_FILE, legacy: VAULT_FILE_LEGACY } = statePaths("VAULT_FILE", "vault.json");
// Reorg-burial depth in Cardano SLOTS (DR-09b): only credit a vault UTxO buried this many slots past
// the db-sync tip, so a lock/exit that later rolls back can't set a wrong weight. 0 = credit as soon as
// it is unspent (fast, dev showcase); production sets a few hundred slots (≥ the no-rollback window for
// the in-protocol path, docs/IN-PROTOCOL-OBSERVATION.md §5.2). When > 0 the read is AS-OF a stable
// reference slot (db-sync tip − depth) via observeAsOf — the determinism-correct read — not the live
// unspent-now set. db-sync's `max(slot_no)` lags the live chain tip a touch, which only DEEPENS burial.
const CONFIRM_DEPTH_SLOTS = Number(process.env.CONFIRM_DEPTH_SLOTS || "0");

export function parseArgv(argv) {
	const o = { via: "committee" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--account") o.account = argv[++i];
		else if (a === "--weight") o.weight = BigInt(argv[++i]);
		else if (a === "--via") o.via = argv[++i];
	}
	return o;
}

// PURE: from a list of db-sync vault matches, pick the largest valid single-beacon UTxO per beacon
// (anti-Sybil largest-wins, never a sum). A match counts only if it carries EXACTLY ONE asset of the
// vault policy at quantity 1 AND positive lovelace; with `confirmDepth>0` it must also be buried >=
// confirmDepth slots past `tipSlot` (an un-buried or slot-less match is skipped, never credited).
//
// Returns Map<beaconHex, lovelace>. Pass `{ reasons }` (a Map) to capture WHY each skipped match was
// rejected — this is a PURE function so it can't log; the caller surfaces the reasons (gap 7/12). A
// zero-lovelace beacon (a swept/degenerate UTxO that still carries the NFT) is NOT credited: a real
// lock always holds positive lovelace, and `0n > -1n` would otherwise list the identity as
// "observed" with no value behind it (gap 1). The floor is therefore `0n`, not the `-1n` sentinel.
//
// The `reasons` map is keyed per-UTxO (transaction_id#output_index), NOT per-beacon, so two rejected
// UTxOs for the SAME beacon (e.g. an old too-fresh re-lock + a swept dust UTxO) don't overwrite each
// other; and a rejection is only surfaced if that beacon was NOT ultimately credited by another
// (buried, positive) UTxO — so a weighted identity is never also reported as "rejected".
export function pickLargest(matches, vaultHash, { tipSlot = null, confirmDepth = 0, reasons = null } = {}) {
	const largest = new Map();
	const rejected = []; // { utxo, beacon|null, why } — surfaced into `reasons` after credits are known
	const utxoId = (m, fallback) => `${m.transaction_id ?? fallback}#${m.output_index ?? 0}`;
	for (const m of matches) {
		const assets = m.value?.assets ?? {};
		const beacons = Object.entries(assets).filter(([k]) => k.split(".")[0].toLowerCase() === vaultHash.toLowerCase());
		if (beacons.length !== 1 || Number(beacons[0][1]) !== 1) {
			rejected.push({ utxo: utxoId(m, JSON.stringify(assets)), beacon: null, why: `not exactly one beacon at qty 1 (${beacons.length} vault asset(s))` });
			continue; // exactly one beacon, qty 1
		}
		const beacon = beacons[0][0].split(".")[1].toLowerCase();
		if (confirmDepth > 0) {
			const slot = m.created_at?.slot_no;
			if (slot == null || tipSlot == null || tipSlot - slot < confirmDepth) {
				rejected.push({ utxo: utxoId(m, beacon), beacon, why: slot == null || tipSlot == null
					? "burial gate: no slot/tip (fail closed)"
					: `burial gate: depth ${tipSlot - slot} < required ${confirmDepth} (too fresh)` });
				continue; // not buried ⇒ skip
			}
		}
		const coins = BigInt(m.value.coins);
		if (coins <= 0n) { rejected.push({ utxo: utxoId(m, beacon), beacon, why: "zero/negative lovelace (swept UTxO not credited)" }); continue; } // gap 1: never credit a value-less beacon
		// Floor is 0n (not the old -1n sentinel): a zero-coin match is already filtered above, so any
		// stored value is positive and largest-wins is unaffected.
		if (coins > (largest.get(beacon) ?? 0n)) largest.set(beacon, coins);
	}
	if (reasons) {
		for (const r of rejected) {
			if (r.beacon && largest.has(r.beacon)) continue; // credited by another UTxO ⇒ not a real rejection
			reasons.set(r.utxo, r.beacon ? `${r.beacon.slice(0, 16)}…: ${r.why}` : r.why);
		}
	}
	return largest;
}

// (`lockToWeight` and the deterministic as-of-reference observation now live in ../_shared/observation.mjs
// and are imported above — the SAME pure logic the in-node inherent will reuse byte-identically.)

// Observe the vault's beacon UTxOs and reduce to largest-wins lovelace per identity (committee-1).
// Returns { largest, total, reasons, referenceSlot? } so the caller can surface vault health (how many
// UTxOs db-sync returned, how many passed the filters, and WHY the rest were rejected — gaps 7/12/13).
//
// Two read postures (in-protocol-observation step 2):
//   • confirmDepth > 0 (production): read AS-OF a stable reference slot (db-sync tip − confirmDepth) via
//     readObservation, then apply the unspent-as-of-ref predicate via observeAsOf (the SAME pure logic the
//     in-node inherent reuses). This is the determinism-correct read: a UTxO spent AFTER the reference is
//     still counted as locked-at-ref, and a lock/exit that could still roll back (within `confirmDepth`)
//     is never credited. The tip is db-sync's `max(slot_no)`, which lags the live chain tip slightly —
//     making the burial gate MORE conservative (safe).
//   • confirmDepth == 0 (dev showcase): the unspent-now (readUnspentMatches) + pickLargest fast path. NOT
//     the enforced path.
async function observeDbsync(vaultHash, { dbsync = DBSYNC, confirmDepth = CONFIRM_DEPTH_SLOTS } = {}) {
	const reasons = new Map();
	if (confirmDepth > 0) {
		let tip, matches;
		try {
			tip = await tipSlot(dbsync); // null/throw ⇒ abort the sync (fail closed)
			if (tip == null) throw new Error("db-sync returned no tip");
			const referenceSlot = tip - BigInt(confirmDepth);
			({ matches } = await readObservation(dbsync, vaultHash, referenceSlot));
			const largest = observeAsOf(matches, { vaultHash, referenceSlot, reasons });
			return { largest, total: matches.length, reasons, referenceSlot };
		} catch (e) {
			// Fail closed — never write partial weight on a read failure (gap 13).
			throw new Error(`db-sync read failed: ${e?.message || e}`);
		}
	}
	// dev fast path (confirmDepth == 0): unspent-now, legacy pickLargest.
	let matches;
	try {
		matches = await readUnspentMatches(dbsync, vaultHash);
	} catch (e) {
		throw new Error(`db-sync read failed: ${e?.message || e}`);
	}
	const largest = pickLargest(matches, vaultHash, { reasons });
	return { largest, total: matches.length, reasons };
}

async function setStakeFor(api, ops, opt, account, weight, committeeOpts = {}) {
	// set_stake (the weight) + force_set_capacity (prime the battery), BOTH through the chosen origin.
	// committeeOpts carries the on-chain-resolved { threshold, members } for the committee path (Phase 3).
	const r1 = await drive(api, api.tx.talkStake.setStake(account, weight), { operators: ops, via: opt.via, ...committeeOpts, log: (m) => console.log("    " + m) });
	if (!has(r1.evs, "talkStake", "StakeSet")) throw new Error("set_stake did not execute");
	const capRatio = api.consts.microblog.capRatio.toBigInt();
	const ceiling = api.consts.microblog.ceiling.toBigInt();
	const full = weight * capRatio < ceiling ? weight * capRatio : ceiling;
	await drive(api, api.tx.microblog.forceSetCapacity(account, full), { operators: ops, via: opt.via, ...committeeOpts, log: () => {} });
	console.log(`  ✓ ${account} ← weight ${weight} (battery ${full}) via ${opt.via}`);
}

async function main() {
	const opt = parseArgv(process.argv.slice(2));
	const api = await connect(WS);
	const ops = operators();
	const spec = api.runtimeVersion.specVersion.toNumber();
	console.log(`chain spec ${spec} | follower set_stake via ${opt.via}`);
	assertRealKeys(opt.via); // fail-closed (Phase 3): no public dev keys under COGNO_PROFILE=prod
	assertGenesis(api);      // pin the chain (Phase 3): refuse the wrong chain if GENESIS is set
	// Resolve the committee threshold from ON-CHAIN membership (Phase 3) once, reused for every write.
	let committeeOpts = {};
	if (opt.via === "committee") {
		const rc = await resolveCommittee(api, ops, { explicitThreshold: opt.threshold });
		committeeOpts = { threshold: rc.threshold, members: rc.members };
		console.log(`  ⚠ single-operator: D2-SHAPED, not D2-TRUST (one operator holds all keys) — committee ${rc.threshold}-of-${rc.onchainCount} (from on-chain membership)`);
	}

	try {
		if (opt.account && opt.weight !== undefined) {
			// dev mode: one account, explicit operator-supplied weight (the showcase path when Cardano
			// is not wired). The MIN_LOCK gate applies only to live vault-observed lovelace, not to a
			// manual override, so the explicit weight is used verbatim.
			await setStakeFor(api, ops, opt, opt.account, opt.weight, committeeOpts);
		} else if (DBSYNC) {
			// live mode: observe the vault, largest-wins, set_stake per bound identity.
			migrateStatePath(VAULT_FILE, VAULT_FILE_LEGACY, "vault descriptor");
			const vaultHash = JSON.parse(fs.readFileSync(VAULT_FILE, "utf8")).vaultHash;
			const { largest, total, reasons, referenceSlot } = await observeDbsync(vaultHash);
			const asOf = referenceSlot != null ? `as-of slot ${referenceSlot}` : "unspent-now (dev fast path)";
			console.log(`db-sync returned ${total} match(es) [${asOf}]; ${largest.size} credited, ${reasons.size} rejected (confirm-depth ${CONFIRM_DEPTH_SLOTS} slots)`);
			// Surface WHY UTxOs were filtered out so an operator can tell "too fresh" (will pass next
			// block) from "never will be buried" / "swept" / "malformed" (gaps 7/12).
			for (const [key, why] of reasons) console.log(`  ⊘ ${String(key).slice(0, 16)}… rejected: ${why}`);
			for (const [beacon, lovelace] of largest) {
				// AccountOf lookup via @polkadot/api (dynamic) — beacon is a 32-byte hash key.
				const account = await api.query.cognoGate.accountOf("0x" + beacon);
				if (account.isNone) { console.log(`  · ${beacon.slice(0, 12)}… ${lovelace} — NOT bound, skip`); continue; }
				await setStakeFor(api, ops, opt, account.unwrap().toString(), lockToWeight(lovelace), committeeOpts);
			}
		} else {
			console.error("usage: --account <ss58> --weight <lovelace>   (dev)   |   set DBSYNC_URL=… for live vault mode");
			process.exit(2);
		}
		console.log("\nfollower sync complete — weight written by the committee (no sudo on the privileged path).");
		await api.disconnect();
		process.exit(0);
	} catch (e) {
		console.error("SYNC FAILED:", e?.message || e);
		await api.disconnect();
		process.exit(1);
	}
}

// Run only when invoked directly (not when imported by tests).
if (isMain(import.meta.url)) main();
