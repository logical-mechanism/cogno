// Unit tests for the deterministic Cardano-observation library (observation.mjs).
// No framework, no live stack:  node services/_shared/observation.test.mjs
// Style mirrors shared.test.mjs / committee.test.mjs: ok()/throws(), final "== N passed, M failed ==".
//
// The headline test (mission step 2): two independent reads of the SAME stable point — including the
// matches arriving in a DIFFERENT order — produce BYTE-IDENTICAL canonical output. That is the
// determinism the inherent's check_inherent will rest on.
import {
	MIN_LOCK,
	lockToWeight,
	cardanoReferenceSlot,
	referenceFromAuraSlot,
	observeAsOf,
	canonicalBytes,
	canonicalHex,
} from "./observation.mjs";
import { isMain } from "./cli.mjs";

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log(`  ✓ ${m}`); } else { FAIL++; console.log(`  ✗ FAIL: ${m}`); } };
function throws(fn, m) { try { fn(); ok(false, `${m} (should have thrown)`); } catch { ok(true, `${m} → threw`); } }

const V = "168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7"; // live vault policy id
const A = "aa".repeat(32); // beacon A
const B = "bb".repeat(32); // beacon B
const C = "cc".repeat(32); // beacon C

// A vault match: one vault beacon at qty 1, `coins` lovelace, created/spent slots, extra assets.
const mk = (beacon, coins, { created = 0, spent = null, extra = {}, tx = "tx", ix = 0 } = {}) => ({
	transaction_id: tx,
	output_index: ix,
	value: { coins: String(coins), assets: { [`${V}.${beacon}`]: "1", ...extra } },
	created_at: { slot_no: created, header_hash: "hh" },
	spent_at: spent == null ? null : { slot_no: spent, header_hash: "hh" },
});

function main() {
	console.log("\n== deterministic observation library ==");

	// ── lockToWeight (the MIN_LOCK floor) ────────────────────────────────────────────────────────
	console.log("\n[lockToWeight] MIN_LOCK gate (applied at weight-application, not in observeAsOf)");
	ok(MIN_LOCK === 100_000_000n, "MIN_LOCK is 100_000_000 lovelace");
	ok(lockToWeight(100_000_000n) === 100_000_000n, "exactly MIN_LOCK passes");
	ok(lockToWeight(99_999_999n) === 0n, "below MIN_LOCK ⇒ 0");
	ok(lockToWeight(0n) === 0n, "zero ⇒ 0");
	ok(lockToWeight(150n, 200n) === 0n, "custom minLock: below the custom floor ⇒ 0");

	// ── cardanoReferenceSlot (fail-closed checked arithmetic) ──────────────────────────────────────
	console.log("\n[cardanoReferenceSlot] deterministic, fail-closed reference (§5.1/§5.2)");
	const PREPROD = { shelleyStartUnix: 1655769600, shelleyStartSlot: 86400, stabilitySlots: 129600 };
	// Round-trip a known preprod point: at unix 1655769600 + 200000s, the cardano slot is 86400+200000,
	// and the reference is that minus the 36h window.
	const t = 1655769600 + 200000;
	const expected = BigInt(86400 + 200000 - 129600);
	ok(cardanoReferenceSlot({ unixSeconds: t, ...PREPROD }) === expected, "preprod round-trip: ref = shelleySlot(t) − window");
	// Wrap-safety: a time BEFORE the Shelley anchor must return null, NOT a wrapped near-u64::MAX slot
	// (the release-WASM overflow-checks-off trap the Rust port must avoid).
	ok(cardanoReferenceSlot({ unixSeconds: 1654041600, ...PREPROD }) === null, "pre-Shelley (Byron systemStart) time ⇒ null (wrap-safe, fail closed)");
	ok(cardanoReferenceSlot({ unixSeconds: 0, ...PREPROD }) === null, "epoch-0 time ⇒ null (never a giant wrapped slot)");
	// Young chain: a window larger than the elapsed Shelley slots underflows the era floor ⇒ null.
	ok(cardanoReferenceSlot({ unixSeconds: 1655769600 + 100, ...PREPROD }) === null, "reference before the Shelley anchor slot ⇒ null");
	// Exactly at the boundary: window-elapsed gives reference == shelleyStartSlot (allowed).
	ok(cardanoReferenceSlot({ unixSeconds: 1655769600 + 129600, ...PREPROD }) === 86400n, "reference exactly at the Shelley anchor slot is allowed");
	// A non-1s slot length is refused (a future HF is a code change, never silent).
	throws(() => cardanoReferenceSlot({ unixSeconds: t, slotLengthMs: 20000, ...PREPROD }), "non-1s slot length is refused");

	console.log("\n[referenceFromAuraSlot] parent-Aura-slot → canonical unix → reference");
	// Aura slot is absolute (unix_ms / slotDuration); slot 1655769600/6 * ... — pick a slot whose
	// canonical time is well past Shelley. slot * 6000ms / 1000 = slot*6 seconds.
	const auraSlot = Math.floor((1655769600 + 300000) / 6); // canonical time ≈ 1655769600+300000
	const r = referenceFromAuraSlot({ auraSlot, slotDurationMs: 6000, ...PREPROD });
	ok(r !== null && r > 86400n, "a recent parent Aura slot yields a valid reference");
	ok(referenceFromAuraSlot({ auraSlot: 0, slotDurationMs: 6000, ...PREPROD }) === null, "genesis (slot 0) ⇒ pre-Shelley ⇒ null (fail closed)");

	// (The sealed stable-block anchor is not a JS reduction — it is a single db-sync SQL row, `block` at
	// `max(slot_no) <= reference`; see services/committee/dbsync.mjs. §15.3.)

	// ── observeAsOf (as-of-ref largest-wins) ───────────────────────────────────────────────────────
	console.log("\n[observeAsOf] as-of-reference largest-wins (replaces ?unspent + tip burial)");
	const REF = 1000n;
	ok(observeAsOf([mk(A, 250_000_000, { created: 10 })], { vaultHash: V, referenceSlot: REF }).get(A) === 250_000_000n,
		"a clean buried-before-ref unspent vault is credited at its lovelace");
	// LARGEST-WINS, never sum.
	let g = observeAsOf([mk(A, 100_000_000, { created: 1 }), mk(A, 250_000_000, { created: 2 }), mk(A, 180_000_000, { created: 3 })], { vaultHash: V, referenceSlot: REF });
	ok(g.get(A) === 250_000_000n && g.size === 1, "largest-wins per beacon (never sum: 100+250+180 ⇒ 250)");
	// Distinct beacons coexist.
	g = observeAsOf([mk(A, 100_000_000, { created: 1 }), mk(B, 300_000_000, { created: 1 })], { vaultHash: V, referenceSlot: REF });
	ok(g.get(A) === 100_000_000n && g.get(B) === 300_000_000n, "distinct beacons each credited");

	// THE as-of-ref fix: a UTxO SPENT AFTER the reference is STILL counted (locked-as-of-ref); a UTxO
	// spent AT/BEFORE the reference is NOT — the bug `?unspent` ("unspent now") would get backwards.
	ok(observeAsOf([mk(A, 200_000_000, { created: 10, spent: 1500 })], { vaultHash: V, referenceSlot: REF }).get(A) === 200_000_000n,
		"spent AFTER the reference ⇒ still locked-as-of-ref ⇒ credited (the ?unspent-would-drop case)");
	ok(observeAsOf([mk(A, 200_000_000, { created: 10, spent: 1000 })], { vaultHash: V, referenceSlot: REF }).size === 0,
		"spent exactly AT the reference ⇒ not locked-as-of-ref ⇒ NOT credited");
	ok(observeAsOf([mk(A, 200_000_000, { created: 10, spent: 500 })], { vaultHash: V, referenceSlot: REF }).size === 0,
		"spent BEFORE the reference ⇒ NOT credited");
	// created AFTER ref ⇒ too fresh, skip.
	ok(observeAsOf([mk(A, 200_000_000, { created: 1500 })], { vaultHash: V, referenceSlot: REF }).size === 0,
		"created AFTER the reference ⇒ too fresh ⇒ NOT credited");
	ok(observeAsOf([mk(A, 200_000_000, { created: 1000 })], { vaultHash: V, referenceSlot: REF }).get(A) === 200_000_000n,
		"created exactly AT the reference ⇒ credited (≤ ref is inclusive)");

	// integrity / sybil-edge filters (parity with legacy pickLargest)
	ok(observeAsOf([mk(A, 0, { created: 1 })], { vaultHash: V, referenceSlot: REF }).size === 0, "zero-coin beacon is NOT credited");
	ok(observeAsOf([mk(A, 0, { created: 1 }), mk(A, 120_000_000, { created: 2 })], { vaultHash: V, referenceSlot: REF }).get(A) === 120_000_000n, "a positive UTxO wins over a zero-coin one for the same beacon");
	const twoBeacons = [{ transaction_id: "t", output_index: 0, value: { coins: "900", assets: { [`${V}.${A}`]: "1", [`${V}.${B}`]: "1" } }, created_at: { slot_no: 1 }, spent_at: null }];
	ok(observeAsOf(twoBeacons, { vaultHash: V, referenceSlot: REF }).size === 0, "a UTxO carrying TWO vault beacons is rejected (not exactly one)");
	ok(observeAsOf([mk(A, 700_000_000, { created: 1, extra: { ["cc".repeat(28) + ".deadbeef"]: "5" } })], { vaultHash: V, referenceSlot: REF }).get(A) === 700_000_000n, "a non-vault native asset alongside the beacon is ignored");
	ok(observeAsOf([mk(A, 100_000_000, { created: 1 })], { vaultHash: "ff".repeat(28), referenceSlot: REF }).size === 0, "wrong vault policy ⇒ nothing credited (silent-but-empty)");
	// fail-closed: missing created slot, and a null reference (abstain).
	ok(observeAsOf([{ value: { coins: "200000000", assets: { [`${V}.${A}`]: "1" } }, spent_at: null }], { vaultHash: V, referenceSlot: REF }).size === 0, "missing created_at.slot_no ⇒ skip (fail closed)");
	ok(observeAsOf([mk(A, 200_000_000, { created: 1 })], { vaultHash: V, referenceSlot: null }).size === 0, "null reference (abstain) ⇒ empty observation");

	// reasons surfacing: a rejection is reported only if the beacon wasn't credited by another UTxO.
	console.log("\n[observeAsOf] reason surfacing (operator visibility)");
	let why = new Map();
	observeAsOf([mk(A, 0, { created: 1 }), mk(B, 500_000_000, { created: 1, tx: "t2" })], { vaultHash: V, referenceSlot: REF, reasons: why });
	ok(why.size === 1 && [...why.values()][0].includes("zero/negative"), "a swept (zero-coin) UTxO is surfaced as rejected");
	why = new Map();
	observeAsOf([mk(A, 100_000_000, { created: 1, tx: "lo" }), mk(A, 400_000_000, { created: 1500, tx: "hi" })], { vaultHash: V, referenceSlot: REF, reasons: why });
	ok(why.size === 0, "a too-fresh UTxO is NOT surfaced when the beacon is credited by a buried one");

	// ── canonical encoding + DETERMINISM (the headline) ─────────────────────────────────────────────
	console.log("\n[canonical] byte-identical determinism — same stable point ⇒ identical bytes");
	const matchesInOrder = [mk(A, 250_000_000, { created: 10 }), mk(B, 150_000_000, { created: 20 }), mk(C, 999_000_000, { created: 5 })];
	// A SHUFFLED, differently-keyed read of the SAME stable state (different array order, duplicate +
	// too-fresh + spent-after noise that must not change the result).
	const matchesShuffled = [
		mk(C, 999_000_000, { created: 5, tx: "x" }),
		mk(A, 100_000_000, { created: 9, tx: "dup-lo" }), // a smaller dup of A (largest-wins drops it)
		mk(B, 150_000_000, { created: 20, tx: "y" }),
		mk(A, 250_000_000, { created: 10, tx: "z" }),
		mk(A, 999_999_999_999, { created: 1500, tx: "fresh" }), // created after ref — excluded
	];
	const h1 = canonicalHex({ referenceSlot: REF, observed: observeAsOf(matchesInOrder, { vaultHash: V, referenceSlot: REF }) });
	const h2 = canonicalHex({ referenceSlot: REF, observed: observeAsOf(matchesShuffled, { vaultHash: V, referenceSlot: REF }) });
	ok(h1 === h2, "two independent reads of the same stable point ⇒ BYTE-IDENTICAL canonical output");
	ok(h1.length > 0 && /^[0-9a-f]+$/.test(h1), "canonicalHex is lowercase hex");

	// canonicalBytes is independent of insertion order into the Map (sort by beacon bytes).
	const mapAB = new Map([[A, 1n], [B, 2n]]);
	const mapBA = new Map([[B, 2n], [A, 1n]]);
	ok(canonicalHex({ referenceSlot: 7n, observed: mapAB }) === canonicalHex({ referenceSlot: 7n, observed: mapBA }), "canonical bytes are independent of Map insertion order");
	// reference slot is part of the witness — same set at a different reference ⇒ different bytes.
	ok(canonicalHex({ referenceSlot: 7n, observed: mapAB }) !== canonicalHex({ referenceSlot: 8n, observed: mapAB }), "the reference slot is committed in the canonical bytes");

	// Known vector: empty set at reference 0 ⇒ u64(0) LE (16 hex zeros) + compact len 0 (one zero byte).
	ok(canonicalHex({ referenceSlot: 0n, observed: new Map() }) === "0000000000000000" + "00", "empty observation encodes to u64(0) + compact(0)");
	// One entry: reference 1, beacon A (32×aa), lovelace 1 ⇒ u64(1)LE + compact(1)=0x04 + 32×aa + u128(1)LE.
	ok(canonicalHex({ referenceSlot: 1n, observed: new Map([[A, 1n]]) }) ===
		"0100000000000000" + "04" + "aa".repeat(32) + "01000000000000000000000000000000",
		"single-entry canonical encoding matches the SCALE-compatible byte vector");
	// a bad-length beacon is rejected by the encoder (defence against malformed input).
	throws(() => canonicalBytes({ referenceSlot: 0n, observed: new Map([["aa", 1n]]) }), "a non-32-byte beacon is rejected by canonicalBytes");

	console.log(`\n== ${PASS} passed, ${FAIL} failed ==`);
	if (FAIL > 0) process.exit(1);
}

if (isMain(import.meta.url)) main();
export { main };
