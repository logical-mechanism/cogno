// Pure, dependency-free helpers for the Sponsored-Bind Relay (D1 bind-funding). Kept free of any
// polkadot-api import so the unit tests run as a plain `node relay.test.mjs` WITHOUT the
// app/node_modules symlink — the same philosophy as services/_shared/net.mjs + metrics.mjs. The
// PAPI-touching submit lives in relay.mjs and is exercised by the live acceptance script.
//
// ── TRUST POSTURE (load-bearing) ──────────────────────────────────────────────────────────────
// This relay is a LIVENESS party, never a CORRECTNESS party. It blindly pays the tx fee for
// `cognoGate.link_identity_signed` and relays the user's proof; the RUNTIME is the sole verifier
// (`pallet_cogno_gate::cip8`). The CIP-8 proof cryptographically commits {account, genesis}, so the
// relay CANNOT forge an identity or change the bound account, and a tombstoned identity is refused
// on-chain. (The one field the signature does NOT cover is the optional `thread_pointer` — a
// non-identity cogno_v3 thread hint the relay, like any submitter, could set or drop; it carries no
// identity or capacity weight, and the frontend bind sends none.) A
// compromised relay key can spam its own funds away or refuse service (censor) — it can NOT fabricate
// a single identity. (Contrast the RETIRED follower POST /bind, whose key WAS a correctness party:
// compromise ⇒ forge any identity.) The validation below is ANTI-ABUSE only — to avoid wasting the
// relay's funds on obviously-junk input — NOT a correctness gate; over-bound/invalid proofs the chain
// would reject anyway are merely refused early so they never cost a paid submission.

import { renderPrometheus } from "../_shared/metrics.mjs"; // builtins-only (node:http) — no app deps

// On-wire bounds of cognoGate.link_identity_signed (pallets/cogno-gate/src/lib.rs): a blob over these
// is rejected at decode, so refuse early to save a paid (failed) submission.
export const COSE_SIGN1_MAX_BYTES = 512; // BoundedVec<u8, ConstU32<512>>
export const COSE_KEY_MAX_BYTES = 128; // BoundedVec<u8, ConstU32<128>>
export const THREAD_MAX_BYTES = 10; // do_bind: ConstU32<10> (5 raw bytes / 10 hex, DR-23)

const HEX_RE = /^[0-9a-f]*$/;

// The honestly-named badges the relay serves on /health — mirrors the follower's BADGES vocabulary.
export const RELAY_BADGES = {
	identity: "trustless self-proof (D1, on-chain)",
	relay: "sponsored bind — liveness-only fee payer (cannot forge)",
	chain: "operator-run (v1)",
};

/** Normalize 0x-prefixed / mixed-case hex to lowercase, no 0x. Returns null if not even-length hex. */
export function normalizeHex(s) {
	if (typeof s !== "string") return null;
	const h = s.replace(/^0x/i, "").toLowerCase();
	if (h.length % 2 !== 0 || !HEX_RE.test(h)) return null;
	return h;
}

export const hexByteLen = (h) => h.length / 2;

export function hexToBytes(hex) {
	const h = normalizeHex(hex) ?? "";
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/**
 * Validate + normalize a POST /bind body (ANTI-ABUSE only — NOT correctness; the chain verifies the
 * proof). Accepts { cose_sign1, cose_key, thread_pointer? } as hex strings (0x optional; a couple of
 * camelCase spellings tolerated). Returns { ok:true, coseSign1, coseKey, thread } (lowercase bare hex;
 * thread is "" when absent) or { ok:false, error } carrying a 400-grade message.
 */
export function validateBindBody(body) {
	if (body == null || typeof body !== "object")
		return { ok: false, error: "body must be a JSON object { cose_sign1, cose_key, thread_pointer? }" };
	const coseSign1 = normalizeHex(body.cose_sign1 ?? body.coseSign1);
	const coseKey = normalizeHex(body.cose_key ?? body.coseKey);
	if (coseSign1 == null) return { ok: false, error: "cose_sign1 must be a hex string" };
	if (coseKey == null) return { ok: false, error: "cose_key must be a hex string" };
	if (hexByteLen(coseSign1) === 0) return { ok: false, error: "cose_sign1 is empty" };
	if (hexByteLen(coseKey) === 0) return { ok: false, error: "cose_key is empty" };
	if (hexByteLen(coseSign1) > COSE_SIGN1_MAX_BYTES)
		return { ok: false, error: `cose_sign1 exceeds the ${COSE_SIGN1_MAX_BYTES}-byte on-chain bound` };
	if (hexByteLen(coseKey) > COSE_KEY_MAX_BYTES)
		return { ok: false, error: `cose_key exceeds the ${COSE_KEY_MAX_BYTES}-byte on-chain bound` };
	let thread = "";
	const rawThread = body.thread_pointer ?? body.thread ?? body.threadPointer;
	if (rawThread != null && rawThread !== "") {
		const t = normalizeHex(rawThread);
		if (t == null) return { ok: false, error: "thread_pointer must be a hex string" };
		if (hexByteLen(t) > THREAD_MAX_BYTES)
			return { ok: false, error: `thread_pointer exceeds the ${THREAD_MAX_BYTES}-byte on-chain bound` };
		thread = t;
	}
	return { ok: true, coseSign1, coseKey, thread };
}

/**
 * Validate + normalize a POST /bind-stake body (the voting-power bind). Same anti-abuse posture as
 * {@link validateBindBody} — NOT correctness; the chain verifies the stake proof — but for
 * `cognoGate.link_stake_signed`, which takes ONLY the two COSE blobs (NO `thread_pointer`). Accepts
 * { cose_sign1, cose_key } as hex strings (0x optional; a couple of camelCase spellings tolerated; any
 * extra fields are ignored). Returns { ok:true, coseSign1, coseKey } (lowercase bare hex) or
 * { ok:false, error } carrying a 400-grade message.
 */
export function validateStakeBindBody(body) {
	if (body == null || typeof body !== "object")
		return { ok: false, error: "body must be a JSON object { cose_sign1, cose_key }" };
	const coseSign1 = normalizeHex(body.cose_sign1 ?? body.coseSign1);
	const coseKey = normalizeHex(body.cose_key ?? body.coseKey);
	if (coseSign1 == null) return { ok: false, error: "cose_sign1 must be a hex string" };
	if (coseKey == null) return { ok: false, error: "cose_key must be a hex string" };
	if (hexByteLen(coseSign1) === 0) return { ok: false, error: "cose_sign1 is empty" };
	if (hexByteLen(coseKey) === 0) return { ok: false, error: "cose_key is empty" };
	if (hexByteLen(coseSign1) > COSE_SIGN1_MAX_BYTES)
		return { ok: false, error: `cose_sign1 exceeds the ${COSE_SIGN1_MAX_BYTES}-byte on-chain bound` };
	if (hexByteLen(coseKey) > COSE_KEY_MAX_BYTES)
		return { ok: false, error: `cose_key exceeds the ${COSE_KEY_MAX_BYTES}-byte on-chain bound` };
	return { ok: true, coseSign1, coseKey };
}

/**
 * Per-IP sliding-window limiter (mirrors the Python follower's RateLimiter): bound /bind so one client
 * can't drain the relay's funds. ANTI-ABUSE (liveness) only — nothing to do with binding correctness.
 * `per_min <= 0` disables it. `now` is injectable purely so the unit test needn't burn wall-clock.
 */
export class RateLimiter {
	constructor(perMin, windowMs = 60_000) {
		this.perMin = perMin;
		this.windowMs = windowMs;
		this._hits = new Map();
	}

	allow(ip, now = Date.now()) {
		if (this.perMin <= 0) return true;
		const hits = (this._hits.get(ip) || []).filter((t) => now - t < this.windowMs);
		if (hits.length >= this.perMin) {
			this._hits.set(ip, hits);
			return false;
		}
		hits.push(now);
		this._hits.set(ip, hits);
		if (this._hits.size > 4096) {
			// opportunistic prune of idle IPs to bound memory
			for (const [k, v] of this._hits) if (!v.length || now - v[v.length - 1] > this.windowMs) this._hits.delete(k);
		}
		return true;
	}
}

/**
 * PURE /health decision: given the relay's live probe ({ node_reachable, balance }) and the operator's
 * MIN_BALANCE floor, return { code, obj }. Healthy (200) only when the node answered AND the relay's
 * free balance is at/above the floor — a node that is down OR a relay that ran out of funds both report
 * 503 (a relay too broke to pay a fee can't sponsor binds, so it is genuinely unhealthy). `balance` is
 * a BigInt or null (unknown). `minBalance` is a BigInt.
 */
export function healthBody(probe, minBalance) {
	const reachable = Boolean(probe?.node_reachable);
	const balance = probe?.balance ?? null;
	const funded = reachable && balance != null && balance >= minBalance;
	const healthy = reachable && funded;
	return {
		code: healthy ? 200 : 503,
		obj: {
			ok: healthy,
			node_reachable: reachable,
			relay_funded: reachable ? funded : null,
			relay_balance: balance == null ? null : balance.toString(),
			min_balance: minBalance.toString(),
			badges: RELAY_BADGES,
		},
	};
}

/**
 * PURE /metrics rendering: the Prometheus text for the relay's probe + lifetime counters. The balance
 * sample is OMITTED (not zeroed) when the node is unreachable, so a "relay broke" alert never misfires
 * on a plain node outage (the renderPrometheus convention). `counters` = { binds_total, binds_ok,
 * binds_rejected, rate_limited, stake_binds_total, stake_binds_ok, stake_binds_rejected } (the
 * stake_* set counts the /bind-stake voting-power route; rate_limited is shared across both routes).
 */
export function metricsBody(probe, counters) {
	const reachable = Boolean(probe?.node_reachable);
	const balance = probe?.balance ?? null;
	const c = counters || {};
	return renderPrometheus([
		{ name: "cogno_bind_relay_up", value: 1, help: "1 while the relay process is running", type: "gauge" },
		{ name: "cogno_bind_relay_node_reachable", value: reachable ? 1 : 0, help: "1 if the L3 node RPC answered", type: "gauge" },
		{ name: "cogno_bind_relay_balance_planck", value: reachable && balance != null ? balance : null, help: "the relay submitter's free balance (planck)", type: "gauge" },
		{ name: "cogno_bind_relay_binds_total", value: c.binds_total ?? 0, help: "POST /bind submissions attempted", type: "counter" },
		{ name: "cogno_bind_relay_binds_ok_total", value: c.binds_ok ?? 0, help: "POST /bind that landed a binding", type: "counter" },
		{ name: "cogno_bind_relay_binds_rejected_total", value: c.binds_rejected ?? 0, help: "POST /bind rejected (bad input or chain reject)", type: "counter" },
		{ name: "cogno_bind_relay_stake_binds_total", value: c.stake_binds_total ?? 0, help: "POST /bind-stake submissions attempted", type: "counter" },
		{ name: "cogno_bind_relay_stake_binds_ok_total", value: c.stake_binds_ok ?? 0, help: "POST /bind-stake that landed a stake (voting-power) binding", type: "counter" },
		{ name: "cogno_bind_relay_stake_binds_rejected_total", value: c.stake_binds_rejected ?? 0, help: "POST /bind-stake rejected (bad input or chain reject)", type: "counter" },
		{ name: "cogno_bind_relay_rate_limited_total", value: c.rate_limited ?? 0, help: "POST /bind or /bind-stake refused by the per-IP rate limit", type: "counter" },
	]);
}

/** Extract the IdentityLinked { identity (0x-hex), who (ss58) } from a PAPI tx result's events, or null. */
export function extractLinked(events) {
	if (!Array.isArray(events)) return null;
	const ev = events.find((e) => e?.type === "CognoGate" && e?.value?.type === "IdentityLinked");
	const v = ev?.value?.value;
	if (!v) return null;
	const identity = typeof v.identity?.asHex === "function" ? v.identity.asHex() : v.identity;
	return { identity, who: v.who };
}

/** Extract the StakeLinked { stake_cred (0x-hex), who (ss58) } from a PAPI tx result's events, or null. */
export function extractStakeLinked(events) {
	if (!Array.isArray(events)) return null;
	const ev = events.find((e) => e?.type === "CognoGate" && e?.value?.type === "StakeLinked");
	const v = ev?.value?.value;
	if (!v) return null;
	const stakeCred = typeof v.stake_cred?.asHex === "function" ? v.stake_cred.asHex() : v.stake_cred;
	return { stake_cred: stakeCred, who: v.who };
}

/**
 * Stringify a PAPI dispatch error (or any thrown value) for the relay's JSON `error` field. Walks the
 * nested { type, value } discriminated union to the leaf variant name (Module → CognoGate →
 * IdentityTombstoned) so the client gets a clean "Module.CognoGate.IdentityTombstoned" rather than a
 * blob; BigInt-safe JSON fallback for anything else.
 */
export function stringifyDispatchError(err) {
	if (err == null) return "unknown dispatch error";
	if (typeof err === "string") return err;
	if (typeof err === "object") {
		const names = [];
		let node = err;
		for (let depth = 0; node && typeof node === "object" && typeof node.type === "string" && depth < 8; depth++) {
			names.push(node.type);
			node = node.value;
		}
		if (typeof node === "string") names.push(node);
		if (names.length) return names.join(".");
		try {
			return JSON.stringify(err, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
		} catch {
			return String(err);
		}
	}
	return String(err);
}
