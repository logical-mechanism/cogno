// Unit tests for the Anchor Relayer's pure helpers + the shared hardened fetch (relayer-9, themes
// 3/4). No framework, no live stack:  node relayer.test.mjs
import { missedIntervals, parseAckTokens, oldestPendingAnchor, classifyPendingAck, validateHex } from "./lib.mjs";
import { fetchJson } from "../_shared/net.mjs";

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log(`  ✓ ${m}`); } else { FAIL++; console.log(`  ✗ FAIL: ${m}`); } };
async function throws(fn, m) {
	try { await fn(); ok(false, `${m} (should have thrown)`); }
	catch { ok(true, `${m} → threw`); }
}

console.log("\n[parseAckTokens] ack result detection");
ok(parseAckTokens("inner events: anchor.AnchorAcked").acked === true, "detects AnchorAcked");
ok(parseAckTokens("· anchor_ack → AckIgnored (no-op)").ignored === true, "detects AckIgnored");
const none = parseAckTokens("submitted, no recognizable event");
ok(none.acked === false && none.ignored === false, "neither token → both false (caller fails hard)");
// gap 2: robustness to the realistic op.mjs / sudo event-output shapes the relayer actually parses.
// op.mjs prints @polkadot/api event records; the relayer only cares that EITHER token is present.
ok(parseAckTokens("  Event: anchor.AnchorAcked\n    block_number: 145\n    last: 130").acked === true, "multi-line pallet event block → acked");
ok(parseAckTokens("{ section: 'anchor', method: 'AnchorAcked', data: [145] }").acked === true, "polkadot.js event object → acked");
ok(parseAckTokens("· anchor_ack → AckIgnored (block #130, last #145)").ignored === true, "AckIgnored with parenthesised fields → ignored");
const both = parseAckTokens("anchor.AckIgnored ... then anchor.AnchorAcked");
ok(both.acked === true && both.ignored === true, "both tokens present → both true (caller takes acked-or-ignored as recorded)");
ok(parseAckTokens("").acked === false && parseAckTokens("").ignored === false, "empty op.mjs stdout (crash/timeout) → neither (hard failure)");
ok(parseAckTokens("Error: WsProvider timed out\n  at connect").acked === false, "op.mjs stack trace, no token → not acked");
ok(parseAckTokens("event: anchor.anchoracked").acked === false, "case matters: lower-cased 'anchoracked' is NOT the real token → not acked");
ok(parseAckTokens(undefined).acked === false && parseAckTokens(null).ignored === false, "non-string input is coerced, not thrown");

console.log("\n[missedIntervals] tamper-evidence gap detection");
ok(missedIntervals(5n, 15n, 10n) === 0, "exactly one interval ahead → no gap");
ok(missedIntervals(5n, 17n, 10n) === 0, "1.x intervals ahead → no gap (normal jitter)");
ok(missedIntervals(5n, 25n, 10n) === 1, "two intervals ahead → 1 skipped");
ok(missedIntervals(5n, 105n, 10n) === 9, "ten intervals ahead → 9 skipped");
ok(missedIntervals(5n, 5n, 10n) === 0, "no advance → 0");
ok(missedIntervals(null, 7n, 10n) === 0, "first anchor below the interval → 0");
ok(missedIntervals(null, 37n, 10n) === 2, "first-ever anchor far ahead → ~2 skipped");
// gap 1: backwards time / reorg. A FINALIZED head that regresses below `last` (GRANDPA reversion or a
// wiped/forked L3) must NOT yield a phantom gap count from BigInt floor-division of a negative diff.
ok(missedIntervals(100n, 50n, 10n) === 0, "backwards head (finalized 50 < last 100) → 0, not a negative/garbage count");
ok(missedIntervals(100n, 99n, 10n) === 0, "small backwards jitter (99 < 100) → 0");
ok(missedIntervals(100n, 100n, 10n) === 0, "equal (no advance) → 0");
ok(missedIntervals(100n, 109n, 10n) === 0, "barely ahead within one interval → 0");
ok(missedIntervals(5n, 25n, 0n) === 0, "every <= 0 guard → 0 (no division by zero)");

console.log("\n[oldestPendingAnchor] resume-ordering (gap 5)");
// A "pending" anchor has a confirmed Cardano tx (cardanoTx + slot) but no L3 ack yet, and is not
// permanently failed. The relayer drains the OLDEST such anchor first so a paid tx is never re-minted.
const A = (block, o = {}) => ({ block, cardanoTx: "tx" + block, slot: 1000 + block, acked: false, failed: false, ...o });
ok(oldestPendingAnchor({ anchors: [] }) === null, "empty state → null (nothing to resume)");
ok(oldestPendingAnchor({}) === null, "missing anchors array → null (no throw)");
ok(oldestPendingAnchor({ anchors: [A(30), A(10), A(20)] }).block === 10, "picks the lowest block among pending");
ok(oldestPendingAnchor({ anchors: [A(10, { acked: true }), A(20)] }).block === 20, "skips an already-acked anchor");
ok(oldestPendingAnchor({ anchors: [A(10, { failed: true }), A(20)] }).block === 20, "skips a permanently-failed anchor (relayer-4, won't wedge the loop)");
ok(oldestPendingAnchor({ anchors: [A(10, { slot: null }), A(20)] }).block === 20, "skips a tx that never confirmed (slot null)");
ok(oldestPendingAnchor({ anchors: [A(10, { cardanoTx: null }), A(20)] }).block === 20, "skips an entry with no Cardano tx");
ok(oldestPendingAnchor({ anchors: [A(10, { acked: true }), A(20, { failed: true })] }) === null, "all acked-or-failed → null");
// gap 5: the canonical mixed-order resume scenario — block 10 pending, 20 failed, 30 pending. Drain
// must return 10 first; after 10 is acked, the next call must return 30 (never the failed 20).
{
	const mixed = { anchors: [A(10), A(20, { failed: true }), A(30)] };
	const first = oldestPendingAnchor(mixed);
	ok(first.block === 10, "mixed state: first resume is block 10");
	first.acked = true; // simulate a successful ack
	const second = oldestPendingAnchor(mixed);
	ok(second.block === 30, "mixed state: after 10 is acked, next is 30 (failed 20 stays skipped)");
	second.acked = true;
	ok(oldestPendingAnchor(mixed) === null, "mixed state: drained — failed 20 is never processed");
}

console.log("\n[classifyPendingAck] regression / ordering guard (gap 4, relayer-4)");
const E = (block, postCount, ts) => ({ block, postCount, ts });
ok(classifyPendingAck(E(50, 5, 1000), null).proceed === true, "no on-chain checkpoint → proceed (transient/first)");
ok(classifyPendingAck(E(50, 5, 1000), undefined).proceed === true, "undefined checkpoint (read failed) → proceed (treated transient)");
ok(classifyPendingAck(E(50, 5, 1000), { block: 50, postCount: 5, ts: 1000 }).covered === true, "checkpoint == entry block → covered (idempotent no-op)");
ok(classifyPendingAck(E(50, 5, 1000), { block: 60, postCount: 9, ts: 2000 }).covered === true, "checkpoint ahead of entry block → covered");
// the core relayer-4 wedge guard: a re-acked OLD anchor whose count/ts would regress vs the on-chain
// checkpoint can NEVER succeed (pallet rejects NonMonotonicAnchor) → mark failed, do not retry forever.
{
	const v = classifyPendingAck(E(40, 5, 1000), { block: 30, postCount: 10, ts: 2000 });
	ok(v.failed === true, "lower postCount than checkpoint → failed (would regress → NonMonotonicAnchor)");
	ok(typeof v.reason === "string" && v.reason.includes("NonMonotonicAnchor"), "failed verdict carries a descriptive reason");
}
ok(classifyPendingAck(E(40, 10, 1500), { block: 30, postCount: 10, ts: 2000 }).failed === true, "equal postCount but LOWER ts → failed (asymmetric regression)");
ok(classifyPendingAck(E(40, 8, 2500), { block: 30, postCount: 10, ts: 2000 }).failed === true, "higher ts but LOWER postCount → still failed");
ok(classifyPendingAck(E(40, 12, 2500), { block: 30, postCount: 10, ts: 2000 }).proceed === true, "ahead in block AND monotonic count+ts → proceed");
ok(classifyPendingAck(E(40, 10, 2000), { block: 30, postCount: 10, ts: 2000 }).proceed === true, "equal count+ts, higher block → proceed (boundary, no regression)");

console.log("\n[validateHex] early hash validation (gap 6/10)");
ok(validateHex("0x" + "ab".repeat(32)) === "ab".repeat(32), "valid 0x-prefixed 32-byte hash → stripped lower hex");
ok(validateHex("AB".repeat(32)) === "ab".repeat(32), "uppercase, no 0x → lower-cased");
throws(() => validateHex("ab".repeat(31) + "a"), "63-char (odd) hash → throws (truncation caught early, not silently halved)");
throws(() => validateHex("0x" + "ab".repeat(31)), "31-byte hash → throws (wrong length)");
throws(() => validateHex("0x" + "ab".repeat(33)), "33-byte hash → throws (too long)");
throws(() => validateHex("0x12zz" + "ab".repeat(30)), "non-hex characters → throws");
throws(() => validateHex(""), "empty string → throws");
throws(() => validateHex(null), "null → throws (not a string)");
throws(() => validateHex(12345), "number → throws (not a string)");
ok(validateHex("deadbeef", 0) === "deadbeef", "expectedBytes=0 disables the length check (any even hex)");
throws(() => validateHex("abc", 0), "odd length still rejected even with length check disabled");

console.log("\n[fetchJson] hardened HTTP (mocked fetch)");
const realFetch = globalThis.fetch;
try {
	globalThis.fetch = async () => ({ ok: true, headers: { get: () => "application/json" }, text: async () => '{"x":42}' });
	ok((await fetchJson("http://x")).x === 42, "valid JSON response is parsed");

	globalThis.fetch = async () => ({ ok: false, status: 500, statusText: "err", headers: { get: () => "" }, text: async () => "" });
	await throws(() => fetchJson("http://x", { retries: 2, backoffMs: 1 }), "non-ok (500) throws after retries");

	globalThis.fetch = async () => ({ ok: true, headers: { get: () => "text/html" }, text: async () => "<html>oops</html>" });
	await throws(() => fetchJson("http://x", { retries: 2, backoffMs: 1 }), "HTML (non-JSON) body throws, not silently undefined");

	let calls = 0;
	globalThis.fetch = async () => {
		calls++;
		if (calls < 2) throw new Error("transient");
		return { ok: true, headers: { get: () => "application/json" }, text: async () => '{"ok":1}' };
	};
	ok((await fetchJson("http://x", { retries: 3, backoffMs: 1 })).ok === 1, "retries a transient failure then succeeds");

	// gap 11: timeout + retry interaction. A real timeout fires the AbortController, which rejects the
	// in-flight fetch — that rejection must COUNT as an attempt (not hang, not loop forever). Model a
	// fetch that honours the abort signal: it stays pending until aborted, then rejects like the runtime.
	const abortable = () => new Promise((_resolve, reject) => {
		// `signal` is the 2nd-arg's .signal; grab it off the call. fetchJson always passes { signal }.
		const sig = abortable._sig;
		if (sig.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
		sig.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
	});
	let timeoutAttempts = 0;
	globalThis.fetch = (_url, opts) => { timeoutAttempts++; abortable._sig = opts.signal; return abortable(); };
	await throws(() => fetchJson("http://x", { retries: 3, backoffMs: 1, timeoutMs: 5 }), "every attempt times out → throws after all retries");
	ok(timeoutAttempts === 3, "a timeout counts as an attempt (3 retries ⇒ exactly 3 fetch calls)");

	// gap 11 cont.: a SLOW first attempt that times out, then a fast success on the next attempt → the
	// timeout is recoverable, not fatal; the retry resolves with the body.
	let mixedAttempts = 0;
	globalThis.fetch = (_url, opts) => {
		mixedAttempts++;
		if (mixedAttempts === 1) { abortable._sig = opts.signal; return abortable(); } // first attempt times out
		return Promise.resolve({ ok: true, headers: { get: () => "application/json" }, text: async () => '{"ok":7}' });
	};
	ok((await fetchJson("http://x", { retries: 3, backoffMs: 1, timeoutMs: 5 })).ok === 7, "timeout then success → recovers on retry");
	ok(mixedAttempts === 2, "exactly 2 attempts: one timed-out, one succeeded");
} finally {
	globalThis.fetch = realFetch;
}

console.log(`\n== relayer helpers: ${PASS} passed, ${FAIL} failed ==\n`);
process.exit(FAIL === 0 ? 0 : 1);
