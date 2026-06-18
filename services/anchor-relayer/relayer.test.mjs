// Unit tests for the Anchor Relayer's pure helpers + the shared hardened fetch (relayer-9, themes
// 3/4). No framework, no live stack:  node relayer.test.mjs
import { missedIntervals, parseAckTokens } from "./lib.mjs";
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

console.log("\n[missedIntervals] tamper-evidence gap detection");
ok(missedIntervals(5n, 15n, 10n) === 0, "exactly one interval ahead → no gap");
ok(missedIntervals(5n, 17n, 10n) === 0, "1.x intervals ahead → no gap (normal jitter)");
ok(missedIntervals(5n, 25n, 10n) === 1, "two intervals ahead → 1 skipped");
ok(missedIntervals(5n, 105n, 10n) === 9, "ten intervals ahead → 9 skipped");
ok(missedIntervals(5n, 5n, 10n) === 0, "no advance → 0");
ok(missedIntervals(null, 7n, 10n) === 0, "first anchor below the interval → 0");
ok(missedIntervals(null, 37n, 10n) === 2, "first-ever anchor far ahead → ~2 skipped");

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
} finally {
	globalThis.fetch = realFetch;
}

console.log(`\n== relayer helpers: ${PASS} passed, ${FAIL} failed ==\n`);
process.exit(FAIL === 0 ? 0 : 1);
