// Unit tests for the shared off-chain helpers — net.mjs (hardened fetch), cli.mjs (run-as-main guard),
// and paths.mjs (durable data dir + crash-safe persistence + single-instance lock). No framework, no
// live stack:  node shared.test.mjs
// Style mirrors anchor-relayer/relayer.test.mjs: ok()/throws(), final "== N passed, M failed ==".
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fetchJson } from "./net.mjs";
import { isMain } from "./cli.mjs";
import { resolveDataDir, statePaths, writeFileAtomic, migrateFromLegacy, migrateStatePath, ensureParentDir, acquireSingleInstanceLock, LEGACY_DIR } from "./paths.mjs";
import { renderPrometheus } from "./metrics.mjs";
import { DEV_KEY_RE, isDevKey } from "./keys.mjs";

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

// ---------------------------------------------------------------------------------------------------
console.log("\n[paths.resolveDataDir] resolution priority (pure: env + home injected)");
{
	const home = "/home/test";
	ok(resolveDataDir({ COGNO_DATA_DIR: "/explicit/dir" }, home) === "/explicit/dir", "COGNO_DATA_DIR wins over everything");
	ok(resolveDataDir({ STATE_DIRECTORY: "/var/lib/cogno" }, home) === "/var/lib/cogno", "STATE_DIRECTORY (systemd) used when no COGNO_DATA_DIR");
	ok(resolveDataDir({ STATE_DIRECTORY: "/var/lib/cogno:/other" }, home) === "/var/lib/cogno", "colon-separated STATE_DIRECTORY takes the first entry");
	ok(resolveDataDir({ XDG_STATE_HOME: "/xdg" }, home) === "/xdg/cogno", "XDG_STATE_HOME/cogno when set");
	ok(resolveDataDir({}, home) === "/home/test/.local/state/cogno", "defaults to ~/.local/state/cogno — never /tmp");
	ok(!resolveDataDir({}, home).startsWith("/tmp"), "default data dir is never under /tmp");
	ok(resolveDataDir({ COGNO_DATA_DIR: "/a", STATE_DIRECTORY: "/b", XDG_STATE_HOME: "/c" }, home) === "/a", "priority order COGNO_DATA_DIR > STATE_DIRECTORY > XDG");
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[paths.statePaths] explicit override vs durable default + legacy");
{
	const home = "/home/test";
	const explicit = statePaths("STATE_FILE", "anchor-state.json", { STATE_FILE: "/custom/anchor.json" }, home);
	ok(explicit.file === "/custom/anchor.json", "explicit env override is the file path");
	ok(explicit.legacy === null, "explicit override has NO legacy fallback (operator named the path)");
	const def = statePaths("STATE_FILE", "anchor-state.json", { COGNO_DATA_DIR: "/var/lib/cogno" }, home);
	ok(def.file === "/var/lib/cogno/anchor-state.json", "default file is <dataDir>/<name>");
	ok(def.legacy === join(LEGACY_DIR, "anchor-state.json"), "default exposes the legacy /tmp path to migrate from");
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[paths.writeFileAtomic] persists content with 0600 perms, no leftover temp");
{
	const dir = fs.mkdtempSync(join(os.tmpdir(), "cogno-paths-"));
	try {
		const f = join(dir, "state.json");
		writeFileAtomic(f, '{"anchors":[]}');
		ok(fs.readFileSync(f, "utf8") === '{"anchors":[]}', "file holds the written content");
		ok((fs.statSync(f).mode & 0o777) === 0o600, `file mode is 0600 (got ${(fs.statSync(f).mode & 0o777).toString(8)})`);
		ok(!fs.readdirSync(dir).some((n) => n.includes(".tmp")), "no leftover .tmp file after the rename");
		// Overwrite must replace atomically (the rename target already exists).
		writeFileAtomic(f, '{"anchors":[1]}');
		ok(fs.readFileSync(f, "utf8") === '{"anchors":[1]}', "atomic overwrite replaces existing content");
		// It creates the parent dir (0700) if missing.
		const nested = join(dir, "sub", "deep.json");
		writeFileAtomic(nested, "x");
		ok(fs.existsSync(nested), "creates a missing parent directory");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[paths.migrateFromLegacy] copies a legacy file once, 0600, idempotent");
{
	const dir = fs.mkdtempSync(join(os.tmpdir(), "cogno-paths-"));
	try {
		const legacy = join(dir, "legacy", "owner.json");
		const file = join(dir, "data", "owner.json");
		fs.mkdirSync(dirname(legacy), { recursive: true });
		fs.writeFileSync(legacy, '{"mnemonic":["x"]}');
		ok(migrateFromLegacy(file, legacy) === true, "migrates when target absent + legacy present");
		ok(fs.readFileSync(file, "utf8") === '{"mnemonic":["x"]}', "migrated content matches the legacy file");
		ok((fs.statSync(file).mode & 0o777) === 0o600, "migrated file is 0600");
		ok(migrateFromLegacy(file, legacy) === false, "no-op when the target already exists (idempotent)");
		ok(migrateFromLegacy(join(dir, "other.json"), null) === false, "no-op when there is no legacy path");
		ok(migrateFromLegacy(join(dir, "other.json"), join(dir, "nope.json")) === false, "no-op when the legacy file does not exist");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[paths.migrateStatePath] migrate + standard warning, returns whether it migrated");
{
	const dir = fs.mkdtempSync(join(os.tmpdir(), "cogno-paths-"));
	try {
		const legacy = join(dir, "legacy", "vault.json");
		const file = join(dir, "data", "vault.json");
		fs.mkdirSync(dirname(legacy), { recursive: true });
		fs.writeFileSync(legacy, '{"vaultHash":"ab"}');
		ok(migrateStatePath(file, legacy, "vault descriptor") === true, "migrates + returns true when legacy present");
		ok(fs.readFileSync(file, "utf8") === '{"vaultHash":"ab"}', "migrated content matches the legacy file");
		ok(migrateStatePath(file, legacy, "vault descriptor") === false, "no-op (false) when the target already exists");
		ok(migrateStatePath(join(dir, "x.json"), null, "x") === false, "no-op (false) when there is no legacy path");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[paths.ensureParentDir] creates the file's OWN parent dir (explicit override outside data dir)");
{
	const dir = fs.mkdtempSync(join(os.tmpdir(), "cogno-paths-"));
	try {
		const file = join(dir, "explicit", "deep", "owner.json");  // parent does not exist yet
		ok(!fs.existsSync(dirname(file)), "precondition: the parent dir is absent");
		ok(ensureParentDir(file) === file, "returns the file path");
		ok(fs.existsSync(dirname(file)) && fs.statSync(dirname(file)).isDirectory(), "creates dirname(file), not the default data dir");
		// The wallet-brew failure mode: writing to an explicit path in a fresh dir now succeeds.
		fs.writeFileSync(file, "{}");
		ok(fs.readFileSync(file, "utf8") === "{}", "a write to the explicit path no longer ENOENTs");
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[keys.isDevKey] detects the public dev seeds (//Alice…), tolerant of whitespace");
{
	ok(isDevKey("//Alice") && isDevKey("//Bob") && isDevKey("//Ferdie") && isDevKey("//Grace"), "all well-known dev seeds match");
	ok(isDevKey("  //Eve  ") === true, "leading/trailing whitespace is tolerated");
	ok(isDevKey("//Mallory") === false, "a non-dev //derivation is not a dev key");
	ok(isDevKey("bottom drive obey lake curtain smoke basket hold race lonely fit walk") === false, "a real mnemonic is not flagged by the // regex");
	ok(isDevKey("") === false && isDevKey(null) === false && isDevKey(undefined) === false, "empty/null/undefined ⇒ false (no throw)");
	ok(DEV_KEY_RE.test("//Charlie") === true, "DEV_KEY_RE is exported for direct use");
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[paths.acquireSingleInstanceLock] exclusive, reclaims a stale lock");
{
	const dir = fs.mkdtempSync(join(os.tmpdir(), "cogno-paths-"));
	const savedDataDir = process.env.COGNO_DATA_DIR;
	process.env.COGNO_DATA_DIR = dir;
	try {
		const lock = acquireSingleInstanceLock("cogno-relayer-test");
		ok(fs.existsSync(lock.lockFile), "lock file created in the data dir");
		ok(Number(fs.readFileSync(lock.lockFile, "utf8").trim()) === process.pid, "lock file records the holder pid");
		// A second acquire sees a LIVE holder (this very process) and must refuse.
		let refused = false;
		try { acquireSingleInstanceLock("cogno-relayer-test"); } catch { refused = true; }
		ok(refused, "second acquire refuses while a live instance holds the lock");
		lock.release();
		ok(!fs.existsSync(lock.lockFile), "release() removes the lock file");
		// A STALE lock (dead pid) must be reclaimed.
		fs.writeFileSync(lock.lockFile, "999999999");
		const relock = acquireSingleInstanceLock("cogno-relayer-test");
		ok(Number(fs.readFileSync(relock.lockFile, "utf8").trim()) === process.pid, "stale lock (dead pid) is reclaimed by the next acquire");
		relock.release();
	} finally {
		if (savedDataDir === undefined) delete process.env.COGNO_DATA_DIR; else process.env.COGNO_DATA_DIR = savedDataDir;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------------------------------
console.log("\n[metrics.renderPrometheus] Prometheus text-exposition format");
{
	const out = renderPrometheus([
		{ name: "g_big", help: "h", value: 1332000000n },
		{ name: "g_big", value: 5n },             // second sample of same metric: no repeated HELP/TYPE
		{ name: "g_null", value: null },           // skipped (unmeasured, not zeroed)
		{ name: "g_undef", value: undefined },     // skipped
		{ name: "g_nan", value: NaN },             // skipped
		{ name: "g_neg", value: -1 },
		{ name: "c_total", type: "counter", value: 3 },
		{ name: "lbl", value: 7, labels: { via: "committee", q: 'a"b' } },
	]);
	ok(out.includes("g_big 1332000000"), "BigInt rendered losslessly as an integer");
	ok(out.includes("g_big 5"), "a second sample of the same metric is still emitted");
	ok((out.match(/# TYPE g_big/g) || []).length === 1, "HELP/TYPE emitted once per metric name");
	ok(!out.includes("g_null") && !out.includes("g_undef") && !out.includes("g_nan"),
		"null/undefined/NaN samples are SKIPPED (omitted, never zeroed)");
	ok(out.includes("# TYPE g_neg gauge") && out.includes("g_neg -1"), "default type is gauge; negatives pass");
	ok(out.includes("# TYPE c_total counter"), "explicit type is respected");
	ok(out.includes('lbl{via="committee",q="a\\"b"} 7'), "labels rendered with double-quote escaping");
	ok(out.endsWith("\n"), "output ends with a trailing newline");
}

console.log(`\n== shared helpers: ${PASS} passed, ${FAIL} failed ==\n`);
process.exit(FAIL === 0 ? 0 : 1);
