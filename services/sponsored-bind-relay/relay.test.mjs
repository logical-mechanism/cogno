// Unit tests for the Sponsored-Bind Relay's pure helpers (D1 bind-funding). No framework, no live
// stack — the PAPI submit + the HTTP wiring are exercised by the live acceptance script:
//   node relay.test.mjs
import {
	normalizeHex,
	hexByteLen,
	hexToBytes,
	validateBindBody,
	RateLimiter,
	extractLinked,
	stringifyDispatchError,
	COSE_SIGN1_MAX_BYTES,
	COSE_KEY_MAX_BYTES,
	THREAD_MAX_BYTES,
	RELAY_BADGES,
	healthBody,
	metricsBody,
} from "./lib.mjs";

const MIN = 1_000_000_000n; // a representative MIN_BALANCE floor for the health-decision tests

let PASS = 0,
	FAIL = 0;
const ok = (c, m) => {
	if (c) {
		PASS++;
		console.log(`  ✓ ${m}`);
	} else {
		FAIL++;
		console.log(`  ✗ FAIL: ${m}`);
	}
};

console.log("\n[normalizeHex] strips 0x, lowercases, rejects odd/non-hex");
ok(normalizeHex("0xDEADbeef") === "deadbeef", "0x + mixed case → lowercase bare hex");
ok(normalizeHex("abcd") === "abcd", "bare even hex passes through");
ok(normalizeHex("abc") === null, "odd-length → null");
ok(normalizeHex("xyz0") === null, "non-hex → null");
ok(normalizeHex(123) === null, "non-string → null");
ok(hexByteLen("deadbeef") === 4, "hexByteLen counts bytes not chars");
ok(Array.from(hexToBytes("0x0aff")).join(",") === "10,255", "hexToBytes decodes 0x-prefixed");

console.log("\n[validateBindBody] anti-abuse pre-check (NOT correctness — the chain verifies)");
const sign1 = "ab".repeat(80); // 80 bytes — within the 512 bound
const key = "cd".repeat(40); // 40 bytes — within the 128 bound
ok(validateBindBody({ cose_sign1: sign1, cose_key: key }).ok, "valid sign1+key → ok");
{
	const v = validateBindBody({ cose_sign1: "0x" + sign1, cose_key: key });
	ok(v.ok && v.coseSign1 === sign1 && v.thread === "", "0x-prefixed normalized; thread defaults to ''");
}
ok(validateBindBody({ coseSign1: sign1, coseKey: key }).ok, "camelCase spellings tolerated");
ok(!validateBindBody(null).ok, "null body → rejected");
ok(!validateBindBody("nope").ok, "string body → rejected");
ok(!validateBindBody({ cose_key: key }).ok, "missing cose_sign1 → rejected");
ok(!validateBindBody({ cose_sign1: sign1 }).ok, "missing cose_key → rejected");
ok(!validateBindBody({ cose_sign1: "zz", cose_key: key }).ok, "non-hex cose_sign1 → rejected");
ok(!validateBindBody({ cose_sign1: "", cose_key: key }).ok, "empty cose_sign1 → rejected");
ok(
	!validateBindBody({ cose_sign1: "ab".repeat(COSE_SIGN1_MAX_BYTES + 1), cose_key: key }).ok,
	`cose_sign1 over ${COSE_SIGN1_MAX_BYTES}B → rejected (matches on-chain BoundedVec)`,
);
ok(
	!validateBindBody({ cose_sign1: sign1, cose_key: "cd".repeat(COSE_KEY_MAX_BYTES + 1) }).ok,
	`cose_key over ${COSE_KEY_MAX_BYTES}B → rejected`,
);
{
	const v = validateBindBody({ cose_sign1: sign1, cose_key: key, thread_pointer: "0a".repeat(THREAD_MAX_BYTES) });
	ok(v.ok && v.thread === "0a".repeat(THREAD_MAX_BYTES), `thread at the ${THREAD_MAX_BYTES}B bound → ok`);
}
ok(
	!validateBindBody({ cose_sign1: sign1, cose_key: key, thread_pointer: "0a".repeat(THREAD_MAX_BYTES + 1) }).ok,
	`thread over ${THREAD_MAX_BYTES}B → rejected (DR-23)`,
);
ok(!validateBindBody({ cose_sign1: sign1, cose_key: key, thread_pointer: "zz" }).ok, "non-hex thread → rejected");

console.log("\n[RateLimiter] per-IP sliding window (anti-abuse / liveness only)");
{
	const rl = new RateLimiter(2, 1000);
	ok(rl.allow("1.2.3.4", 0) === true, "1st within window → allowed");
	ok(rl.allow("1.2.3.4", 100) === true, "2nd within window → allowed");
	ok(rl.allow("1.2.3.4", 200) === false, "3rd within window → blocked");
	ok(rl.allow("9.9.9.9", 200) === true, "different IP → independent bucket");
	ok(rl.allow("1.2.3.4", 1300) === true, "after the window slides → allowed again");
	const off = new RateLimiter(0);
	ok(off.allow("1.2.3.4", 0) && off.allow("1.2.3.4", 0), "per_min<=0 disables the limiter");
}

console.log("\n[extractLinked] reads CognoGate.IdentityLinked from PAPI events");
{
	const events = [
		{ type: "System", value: { type: "ExtrinsicSuccess" } },
		{ type: "CognoGate", value: { type: "IdentityLinked", value: { who: "5GxAccount", identity: { asHex: () => "0xfeed" } } } },
	];
	const l = extractLinked(events);
	ok(l && l.who === "5GxAccount" && l.identity === "0xfeed", "extracts who + identity (asHex)");
	ok(extractLinked([]) === null, "no event → null");
	ok(extractLinked(undefined) === null, "non-array → null");
	ok(extractLinked([{ type: "CognoGate", value: { type: "Revoked" } }]) === null, "wrong CognoGate event → null");
}

console.log("\n[stringifyDispatchError] walks the nested variant union to the leaf name");
ok(
	stringifyDispatchError({ type: "Module", value: { type: "CognoGate", value: { type: "IdentityTombstoned" } } }) ===
		"Module.CognoGate.IdentityTombstoned",
	"Module → CognoGate → IdentityTombstoned",
);
ok(stringifyDispatchError({ type: "BadOrigin" }) === "BadOrigin", "shallow variant → its name");
ok(stringifyDispatchError("plain string") === "plain string", "string passes through");
ok(stringifyDispatchError(null) === "unknown dispatch error", "null → readable default");
ok(/123/.test(stringifyDispatchError({ value: 123n })), "BigInt-safe JSON fallback for shapeless objects");

console.log("\n[healthBody] funded-and-reachable decision (503 when broke or node down)");
ok(healthBody({ node_reachable: true, balance: 5_000_000_000n }, MIN).code === 200, "reachable + funded → 200");
ok(healthBody({ node_reachable: true, balance: 0n }, MIN).code === 503, "reachable + broke → 503");
ok(healthBody({ node_reachable: true, balance: MIN }, MIN).code === 200, "balance exactly at the floor → 200");
ok(healthBody({ node_reachable: false, balance: null }, MIN).code === 503, "node down → 503");
{
	const b = healthBody({ node_reachable: true, balance: 7n }, MIN).obj;
	ok(b.badges === RELAY_BADGES && b.relay_balance === "7", "health body carries badges + stringified balance");
}

console.log("\n[metricsBody] Prometheus text exposition");
{
	const m = metricsBody({ node_reachable: true, balance: 42n }, { binds_total: 3, binds_ok: 2 });
	ok(/cogno_bind_relay_up 1/.test(m), "emits up gauge");
	ok(/cogno_bind_relay_balance_planck 42/.test(m), "emits balance when known");
	ok(/cogno_bind_relay_binds_total 3/.test(m) && /cogno_bind_relay_binds_ok_total 2/.test(m), "emits lifetime counters");
	const down = metricsBody({ node_reachable: false, balance: null }, {});
	ok(/cogno_bind_relay_node_reachable 0/.test(down), "node_reachable 0 when down");
	ok(!/cogno_bind_relay_balance_planck/.test(down), "balance OMITTED (not zeroed) when unknown");
}

console.log(`\n== sponsored-bind relay: ${PASS} passed, ${FAIL} failed ==\n`);
process.exit(FAIL === 0 ? 0 : 1);
