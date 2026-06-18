// Unit tests for the shared off-chain helpers — net.mjs (hardened fetch) + cli.mjs (run-as-main
// guard). No framework, no live stack:  node shared.test.mjs
// Style mirrors anchor-relayer/relayer.test.mjs: ok()/throws(), final "== N passed, M failed ==".
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fetchJson } from "./net.mjs";
import { isMain } from "./cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log(`  ✓ ${m}`); } else { FAIL++; console.log(`  ✗ FAIL: ${m}`); } };
async function throws(fn, m) {
	try { await fn(); ok(false, `${m} (should have thrown)`); }
	catch { ok(true, `${m} → threw`); }
}
// Capture-and-restore the noisy warn/error logging fetchJson now emits so the test output stays
// readable; we restore in a finally so a thrown assertion never leaks the silence into later blocks.
const silence = () => {
	const w = console.warn, e = console.error;
	console.warn = () => {}; console.error = () => {};
	return () => { console.warn = w; console.error = e; };
};

// A fetch mock returning a fixed JSON body; defaults to a valid application/json 200.
const okFetch = (text = '{"x":42}', ct = "application/json") =>
	async () => ({ ok: true, status: 200, statusText: "OK", headers: { get: () => ct }, text: async () => text });

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------------------------------
console.log("\n[net.fetchJson] timeout abort fires within bound (no infinite hang)");
{
	const restore = silence();
	try {
		// fetch never resolves until aborted; the AbortController signal must reject it. With timeoutMs=50
		// and retries=1, fetchJson must throw well within ~300ms — if the timer/signal were broken this
		// promise would hang forever and fail CI by timing out (gap 1).
		globalThis.fetch = (url, { signal } = {}) => new Promise((_resolve, reject) => {
			signal?.addEventListener("abort", () => {
				const err = new Error("aborted"); err.name = "AbortError"; reject(err);
			});
		});
		const start = Date.now();
		let threw = false;
		try { await fetchJson("http://hang", { timeoutMs: 50, retries: 1, backoffMs: 1, sleep: async () => {} }); }
		catch { threw = true; }
		const elapsed = Date.now() - start;
		ok(threw, "never-resolving fetch is aborted and throws (does not hang)");
		ok(elapsed < 1000, `aborted quickly (${elapsed}ms < 1000ms bound)`);
	} finally { restore(); globalThis.fetch = realFetch; }
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[net.fetchJson] malformed JSON after looksJson check is caught + retried (not undefined)");
{
	const restore = silence();
	try {
		// Body STARTS with '{' so looksJson === true, but JSON.parse throws SyntaxError. It must be caught
		// and retried, never silently returned as undefined which could drive a privileged write (gap 2).
		let calls = 0, result, threw = false;
		globalThis.fetch = async () => {
			calls++;
			return { ok: true, status: 200, statusText: "OK", headers: { get: () => "application/json" }, text: async () => "{broken json no closing" };
		};
		try { result = await fetchJson("http://x", { retries: 3, backoffMs: 1, sleep: async () => {} }); }
		catch { threw = true; }
		ok(threw, "malformed JSON throws, not silently undefined");
		ok(result === undefined, "no value returned on parse failure");
		ok(calls === 3, `parse-failure was RETRIED the full ${3} attempts (got ${calls})`);
	} finally { restore(); globalThis.fetch = realFetch; }

	// Same payload but with a recovery on attempt 2 — proves the retry actually re-fetches and can succeed.
	const restore2 = silence();
	try {
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			const text = calls < 2 ? "{not valid json" : '{"recovered":true}';
			return { ok: true, status: 200, statusText: "OK", headers: { get: () => "application/json" }, text: async () => text };
		};
		const r = await fetchJson("http://x", { retries: 3, backoffMs: 1, sleep: async () => {} });
		ok(r.recovered === true && calls === 2, "retries past a transient parse failure then succeeds");
	} finally { restore2(); globalThis.fetch = realFetch; }
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[net.fetchJson] exponential backoff schedule is correct + bounded");
{
	const restore = silence();
	try {
		// Inject a sleep that records the delays instead of waiting. With backoffMs=500, retries=4 the
		// schedule must be 500, 1000, 2000 (3 sleeps for 4 attempts — no sleep after the last) (gap 4).
		const delays = [];
		globalThis.fetch = async () => { throw new Error("always fails"); };
		await throws(() => fetchJson("http://x", { retries: 4, backoffMs: 500, sleep: async (ms) => { delays.push(ms); } }),
			"exhausts retries");
		ok(JSON.stringify(delays) === JSON.stringify([500, 1000, 2000]), `delays follow 500/1000/2000 (got ${JSON.stringify(delays)})`);
	} finally { restore(); globalThis.fetch = realFetch; }

	// backoffMs=0 ⇒ every computed delay is 0 (no accidental nonzero from the exponent).
	const restore2 = silence();
	try {
		const delays = [];
		globalThis.fetch = async () => { throw new Error("nope"); };
		await throws(() => fetchJson("http://x", { retries: 3, backoffMs: 0, sleep: async (ms) => { delays.push(ms); } }),
			"exhausts retries with zero backoff");
		ok(delays.every((d) => d === 0) && delays.length === 2, `backoffMs=0 stays 0 for all sleeps (got ${JSON.stringify(delays)})`);
	} finally { restore2(); globalThis.fetch = realFetch; }

	// Large but bounded: backoffMs=1000, retries=10 ⇒ last sleep = 2^8 * 1000 = 256000 (finite, not NaN/Infinity).
	const restore3 = silence();
	try {
		const delays = [];
		globalThis.fetch = async () => { throw new Error("nope"); };
		await throws(() => fetchJson("http://x", { retries: 10, backoffMs: 1000, sleep: async (ms) => { delays.push(ms); } }),
			"exhausts 10 retries");
		const lastDelay = delays[delays.length - 1];
		ok(delays.length === 9, `9 sleeps for 10 attempts (got ${delays.length})`);
		ok(lastDelay === 256000 && Number.isFinite(lastDelay), `largest delay is finite 2^8*1000=256000 (got ${lastDelay})`);
	} finally { restore3(); globalThis.fetch = realFetch; }
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[net.fetchJson] exactly N attempts then throw (boundary)");
{
	const restore = silence();
	try {
		let calls = 0;
		globalThis.fetch = async () => { calls++; throw new Error(`fail-${calls}`); };
		let msg = "";
		try { await fetchJson("http://x", { retries: 2, backoffMs: 1, sleep: async () => {} }); }
		catch (e) { msg = e.message; }
		ok(calls === 2, `fetch called exactly retries=2 times (got ${calls})`);
		ok(msg.includes("failed after 2 attempts"), "error names the attempt count");
		ok(msg.includes("fail-2"), "final error carries the LAST attempt's error, not the first");
	} finally { restore(); globalThis.fetch = realFetch; }
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[net.fetchJson] final error is never blank (empty / missing message)");
{
	const restore = silence();
	try {
		// last.message === '' previously rendered "...attempts: " (blank). Must fall back to a useful string.
		globalThis.fetch = async () => { throw new Error(""); };
		let msg = "";
		try { await fetchJson("http://x", { retries: 1, backoffMs: 1, sleep: async () => {} }); }
		catch (e) { msg = e.message; }
		// The thrown message includes the stack (or name) of the empty Error, so it must not end blank.
		ok(/failed after 1 attempts: .+/.test(msg), `empty-message error still yields a non-blank final message (got: ${JSON.stringify(msg.slice(0, 80))})`);
	} finally { restore(); globalThis.fetch = realFetch; }

	// A thrown non-Error primitive must also format, not become "undefined".
	const restore2 = silence();
	try {
		globalThis.fetch = async () => { throw "string failure"; };
		let msg = "";
		try { await fetchJson("http://x", { retries: 1, backoffMs: 1, sleep: async () => {} }); }
		catch (e) { msg = e.message; }
		ok(msg.includes("string failure"), "non-Error thrown value is still surfaced in the final message");
	} finally { restore2(); globalThis.fetch = realFetch; }
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[net.fetchJson] content-type handling");
{
	const restore = silence();
	try {
		// 'json' substring in a nonstandard content-type still triggers a JSON.parse attempt; with a valid
		// JSON body that parse must succeed (documents the current permissive behavior, gap 9).
		globalThis.fetch = okFetch('[{"a":1}]', "text/x-json-lines");
		const r = await fetchJson("http://x", { retries: 1, backoffMs: 1, sleep: async () => {} });
		ok(Array.isArray(r) && r[0].a === 1, "content-type containing 'json' + valid JSON body parses");

		// content-type WITHOUT 'json' but a body that looks like JSON ('{') is still accepted by the
		// looksJson fallback — a real Ogmios/Kupo behavior the relayer depends on.
		globalThis.fetch = okFetch('{"y":7}', "application/octet-stream");
		const r2 = await fetchJson("http://x", { retries: 1, backoffMs: 1, sleep: async () => {} });
		ok(r2.y === 7, "non-json content-type but JSON-looking body is accepted (looksJson fallback)");

		// content-type WITHOUT 'json' and a body that does NOT look like JSON is rejected (not undefined).
		globalThis.fetch = okFetch("plain text here", "text/plain");
		await throws(() => fetchJson("http://x", { retries: 1, backoffMs: 1, sleep: async () => {} }),
			"non-json content-type + non-JSON body is rejected");
	} finally { restore(); globalThis.fetch = realFetch; }
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[net.fetchJson] non-200 status throws (does not parse body)");
{
	const restore = silence();
	try {
		// A 500 with a JSON-shaped body must NOT be parsed/returned — res.ok gates everything.
		let parsed = false;
		globalThis.fetch = async () => ({ ok: false, status: 500, statusText: "err",
			headers: { get: () => "application/json" }, text: async () => { parsed = true; return '{"sneaky":1}'; } });
		await throws(() => fetchJson("http://x", { retries: 1, backoffMs: 1, sleep: async () => {} }),
			"HTTP 500 throws");
		ok(parsed === false, "body is NOT read/parsed on a non-ok response");
	} finally { restore(); globalThis.fetch = realFetch; }
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[cli.isMain] run-as-main guard");
{
	// This test file IS the process entrypoint (run via `node shared.test.mjs`), so isMain on its own
	// URL must be TRUE — the positive self-detection case in-process.
	ok(isMain(import.meta.url) === true, "isMain(import.meta.url) is TRUE for the actual entrypoint");

	// A URL that does not match argv[1] at all ⇒ false (a sibling module that was imported, not run).
	ok(isMain("file:///definitely/not/the/entrypoint.mjs") === false, "mismatched URL → false");

	// Defensive: an empty / missing argv[1] must never spuriously match (the !!process.argv[1] guard).
	ok(isMain("") === false, "empty URL → false (no spurious match)");

	// A standalone script that calls isMain(import.meta.url) on ITSELF and exits 0 iff true. Running it
	// directly must report true (proves the entrypoint is detected, gap 3). Then importing that same
	// script from another module must report false (no false-positive main()).
	const selfMain = join(HERE, "__ismain_selfcheck.mjs");
	const out = execFileSync(process.execPath, [selfMain], { encoding: "utf8" }).trim();
	ok(out === "MAIN:true", `script run directly reports isMain true (got "${out}")`);

	// Same script invoked via a RELATIVE argv[1] (cwd = _shared) must still resolve to true — pathToFileURL
	// normalizes relative→absolute (gap 10).
	const outRel = execFileSync(process.execPath, ["__ismain_selfcheck.mjs"], { encoding: "utf8", cwd: HERE }).trim();
	ok(outRel === "MAIN:true", `script run via a relative path still reports isMain true (got "${outRel}")`);

	// Importing the selfcheck script (not running it) must report false — no test pollution.
	const importer = `import { check } from ${JSON.stringify(pathToFileURL(selfMain).href)}; console.log("IMPORTED:" + check());`;
	const outImp = execFileSync(process.execPath, ["--input-type=module", "-e", importer], { encoding: "utf8" }).trim();
	ok(outImp === "IMPORTED:false", `same script reports isMain FALSE when imported (got "${outImp}")`);
}

console.log(`\n== shared helpers: ${PASS} passed, ${FAIL} failed ==\n`);
process.exit(FAIL === 0 ? 0 : 1);
