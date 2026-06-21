#!/usr/bin/env node
// The Sponsored-Bind Relay (D1 bind-funding) — closes the new-user funding gap for the trustless
// identity bind WITHOUT weakening the chain's DoS defence.
//
// THE GAP: `cognoGate.link_identity_signed` is deliberately NOT feeless (the verify is ~68µs of
// ed25519 + 2× blake2 + CBOR, so a free call would be a cheap compute-DoS; the submitter pays). In the
// browser the submitter is the user's freshly sign-to-derived sr25519 posting account, which on a new
// chain has ZERO balance → the bind tx can't pay → it fails. A real new user can't complete a bind.
//
// THE FIX: this small funded service accepts a signed proof and submits link_identity_signed with its
// OWN funded key, paying the fee. The chain stays the sole verifier; the relay just pays + relays.
// The DoS defence is intact — SOMEONE always pays (here, the relay, which also rate-limits per-IP).
//
// ── TRUST POSTURE (load-bearing, see lib.mjs) ─────────────────────────────────────────────────
// LIVENESS party, never CORRECTNESS. The proof commits {account, genesis}; the relay cannot forge or
// retarget a binding, and a tombstoned identity is refused on-chain. A compromised relay key spams its
// own funds / censors — it can NOT fabricate an identity. (Contrast the RETIRED follower POST /bind,
// whose key WAS a correctness party.) The relay holds NO committee/sudo/FollowerOrigin authority — its
// key is merely funded. It does NOT verify the proof (the runtime does); it pre-checks size bounds only
// to avoid wasting fees on junk.
//
//   POST /bind        { cose_sign1, cose_key, thread_pointer? }  → cognoGate.link_identity_signed
//   POST /bind-stake  { cose_sign1, cose_key }                   → cognoGate.link_stake_signed (voting
//                                                                   power; account must be payment-bound)
//                       both fee-paid by the relay's funded key (liveness only — cannot forge/retarget)
//   GET  /health (/healthz)  → node reachable + relay funded (503 when unhealthy)
//   GET  /metrics            → Prometheus text (up / node_reachable / relay_balance / binds_* / stake_binds_*)
//
//   WS=ws://127.0.0.1:9944 RELAY_SEED=//Alice PORT=8091 node relay.mjs   # (use the nvm node v22 — PAPI)
import http from "node:http";
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { DEV_PHRASE, entropyToMiniSecret, mnemonicToEntropy, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cogno } from "@polkadot-api/descriptors";
import { isMain } from "../_shared/cli.mjs";
import { isDevKey } from "../_shared/keys.mjs";
import {
	validateBindBody,
	validateStakeBindBody,
	hexToBytes,
	extractLinked,
	extractStakeLinked,
	stringifyDispatchError,
	RateLimiter,
	RELAY_BADGES,
	healthBody,
	metricsBody,
} from "./lib.mjs";

// ── config (env-overridable) ──────────────────────────────────────────────────────────────────
const WS = process.env.WS || "ws://127.0.0.1:9944";
const PORT = Number(process.env.PORT || 8091); // follower is 8090; relay is 8091
const HOST = process.env.HOST || "127.0.0.1"; // bind host; 127.0.0.1 for the localhost showcase
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*"; // set to your frontend origin in production
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 10); // per-IP /bind cap (anti-abuse; 0=off)
const GENESIS = (process.env.GENESIS || "").toLowerCase().replace(/^0x/, ""); // optional chain pin
const MIN_BALANCE = BigInt(process.env.MIN_BALANCE || 1_000_000_000n); // /health: unhealthy below ~this many planck
const MAX_BODY = 16 * 1024; // /bind body cap (a valid proof is < 1 KB)
const PROBE_TTL_MS = Number(process.env.HEALTH_PROBE_TTL || 2) * 1000;
// Bound a single submission so a node that admits the tx but never FINALIZES it (a finality stall on
// the single-operator chain) can't wedge the serialized /bind queue forever — it fails that one request
// and frees the queue (mirrors the committee's SUBMIT_TIMEOUT=150 convention).
const SUBMIT_TIMEOUT_MS = Number(process.env.SUBMIT_TIMEOUT || 150) * 1000;

const stripHex = (h) => String(h).toLowerCase().replace(/^0x/, "");

// In-process counters for /metrics — the relay is a documented operator service, alertable like the
// follower/relayer (a funded service that stops binding should page someone). The stake_* set tracks
// the /bind-stake voting-power route separately; rate_limited is shared across both routes.
const counters = {
	binds_total: 0,
	binds_ok: 0,
	binds_rejected: 0,
	stake_binds_total: 0,
	stake_binds_ok: 0,
	stake_binds_rejected: 0,
	rate_limited: 0,
};

/**
 * Build the relay's FUNDED submitter signer from RELAY_SEED. This key is NOT privileged — it holds no
 * committee/sudo/FollowerOrigin authority; it only pays fees. Default dev //Bob (a funded endowed dev
 * account that is NOT the --dev sudo key //Alice); set RELAY_SEED to a real funded seed (a `//path` on
 * the dev phrase, or a full mnemonic) in any real deployment.
 */
function makeRelaySigner() {
	const seed = (process.env.RELAY_SEED || "//Bob").trim();
	// Refuse a publicly-known dev key under prod — both a `//Name` path AND the raw dev-phrase mnemonic
	// root (isDevKey only catches the former; the latter derives an equally-public account).
	if ((process.env.COGNO_PROFILE || "").toLowerCase() === "prod" && (isDevKey(seed) || seed === DEV_PHRASE))
		throw new Error(
			`COGNO_PROFILE=prod: RELAY_SEED is a public dev key (${isDevKey(seed) ? seed : "the dev-phrase mnemonic"}) — refusing to fund binds from a key everyone holds. Set a real funded seed.`,
		);
	const isPath = seed.startsWith("//");
	const derive = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(isPath ? DEV_PHRASE : seed)));
	const kp = derive(isPath ? seed : "");
	return {
		signer: getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign),
		ss58: ss58Address(kp.publicKey, 42),
	};
}

// Serialize submissions on the single relay key so concurrent POSTs don't race the account nonce
// (PAPI derives the nonce per-submit; two in-flight binds on one key would collide). Binds are rare, so
// strict serialization is fine and keeps the relay correct under a burst.
let _chain = Promise.resolve();
function serialize(fn) {
	const run = _chain.then(fn, fn);
	_chain = run.then(
		() => {},
		() => {},
	);
	return run;
}

/**
 * Submit cognoGate.link_identity_signed, signed (fee-paid) by the relay's funded key. The BOUND account
 * is the one the proof commits, NOT the relay. Returns { ok, identity, who } or { ok:false, error }.
 */
async function submitBind(api, signer, { coseSign1, coseKey, thread }) {
	const tx = api.tx.CognoGate.link_identity_signed({
		cose_sign1: Binary.fromBytes(hexToBytes(coseSign1)),
		cose_key: Binary.fromBytes(hexToBytes(coseKey)),
		thread_pointer: thread ? Binary.fromBytes(hexToBytes(thread)) : undefined,
	});
	// PAPI's signAndSubmit resolves on FINALIZATION (or a terminal invalid/dropped status). If the node
	// admits the tx but finality stalls it neither settles — so race it against a timeout that rejects,
	// freeing the serialized queue for the next bind rather than wedging it (the timed-out tx may still
	// land later; the client gets an error and can retry).
	let timer;
	const timeout = new Promise((_, rej) => {
		timer = setTimeout(() => rej(new Error(`bind did not finalize within ${SUBMIT_TIMEOUT_MS / 1000}s`)), SUBMIT_TIMEOUT_MS);
	});
	let res;
	try {
		res = await Promise.race([tx.signAndSubmit(signer), timeout]);
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) return { ok: false, error: stringifyDispatchError(res.dispatchError) };
	const linked = extractLinked(res.events);
	if (!linked) return { ok: false, error: "submitted ok but no CognoGate.IdentityLinked event was found" };
	return { ok: true, identity: stripHex(linked.identity), who: linked.who };
}

/**
 * Submit cognoGate.link_stake_signed (the voting-power bind), signed (fee-paid) by the relay's funded
 * key. Identical trust posture to {@link submitBind}: the BOUND account is the one the proof commits,
 * NOT the relay — the proof's pinned payload carries the sr25519 account and the runtime binds THAT, so
 * the relay cannot retarget the credential (it can only pay or censor). `link_stake_signed` takes no
 * thread pointer. Returns { ok, stake_cred (0x-hex), who } or { ok:false, error }.
 */
async function submitStakeBind(api, signer, { coseSign1, coseKey }) {
	const tx = api.tx.CognoGate.link_stake_signed({
		cose_sign1: Binary.fromBytes(hexToBytes(coseSign1)),
		cose_key: Binary.fromBytes(hexToBytes(coseKey)),
	});
	// Same finality-stall guard as submitBind: race signAndSubmit against a timeout so a tx the node
	// admits but never finalizes frees the serialized queue rather than wedging it.
	let timer;
	const timeout = new Promise((_, rej) => {
		timer = setTimeout(() => rej(new Error(`stake bind did not finalize within ${SUBMIT_TIMEOUT_MS / 1000}s`)), SUBMIT_TIMEOUT_MS);
	});
	let res;
	try {
		res = await Promise.race([tx.signAndSubmit(signer), timeout]);
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) return { ok: false, error: stringifyDispatchError(res.dispatchError) };
	const linked = extractStakeLinked(res.events);
	if (!linked) return { ok: false, error: "submitted ok but no CognoGate.StakeLinked event was found" };
	return { ok: true, stake_cred: linked.stake_cred, who: linked.who };
}

// ── liveness probe (TTL-cached so a /health flood can't stampede the node) ──────────────────────
const _probe = { at: 0, node_reachable: false, balance: null };
async function probe(api, relaySs58) {
	const now = Date.now();
	if (now - _probe.at < PROBE_TTL_MS) return _probe;
	try {
		const acct = await api.query.System.Account.getValue(relaySs58);
		_probe.balance = acct?.data?.free ?? 0n;
		_probe.node_reachable = true;
	} catch {
		_probe.node_reachable = false;
		_probe.balance = null;
	}
	_probe.at = Date.now();
	return _probe;
}

function makeServer(api, relay, rate) {
	const send = (res, code, obj) => {
		const body = JSON.stringify(obj);
		res.writeHead(code, {
			"content-type": "application/json",
			"access-control-allow-origin": CORS_ORIGIN,
			"access-control-allow-headers": "content-type",
			"access-control-allow-methods": "GET, POST, OPTIONS",
		});
		res.end(body);
	};

	// Shared POST handler for the two sponsored-bind routes (/bind = identity, /bind-stake = voting
	// power). They are byte-identical except the validator, the submitter, and which counter set they
	// bump — one handler keeps them in lockstep: the runtime is the sole verifier for BOTH, and the
	// relay only pays the fee (it cannot forge or retarget either binding — the proof commits the
	// account). `count` names the {total, ok, rejected} counter keys; each terminal path bumps exactly
	// one of ok/rejected so the invariant total == ok + rejected holds.
	const handleSponsorRoute = (req, res, ip, { validate, submit, count }) => {
		if (!rate.allow(ip)) {
			counters.rate_limited++;
			return send(res, 429, { ok: false, error: "rate limited — slow down (the relay bounds binds per IP)" });
		}
		counters[count.total]++;
		let raw = "";
		let aborted = false;
		req.on("data", (c) => {
			raw += c;
			if (raw.length > MAX_BODY) {
				aborted = true;
				counters[count.rejected]++;
				send(res, 413, { ok: false, error: "request body too large" });
				req.destroy();
			}
		});
		req.on("end", () => {
			if (aborted) return;
			let parsed;
			try {
				parsed = JSON.parse(raw || "{}");
			} catch {
				counters[count.rejected]++;
				return send(res, 400, { ok: false, error: "body is not valid JSON" });
			}
			const v = validate(parsed);
			if (!v.ok) {
				counters[count.rejected]++;
				return send(res, 400, { ok: false, error: v.error });
			}
			// Submit on the serialized chain (one in-flight bind per relay key). The runtime is the
			// verifier — a bad proof comes back as a dispatch error (ProofInvalid / WrongGenesis /
			// NotPaymentBound / *AlreadyBound / *Tombstoned …), which we relay verbatim to the client.
			serialize(() => submit(api, relay.signer, v)).then(
				(out) => {
					if (out.ok) counters[count.ok]++;
					else counters[count.rejected]++;
					send(res, out.ok ? 200 : 422, out);
				},
				(e) => {
					counters[count.rejected]++;
					console.error(`[bind-error] ${e?.message || e}`);
					send(res, 502, { ok: false, error: `relay submission failed: ${e?.message || e}` });
				},
			);
		});
		req.on("error", () => {
			// A mid-stream socket error is also a terminal reject — bump count.rejected so the
			// total == ok + rejected invariant holds here too (when aborted, the 413 path already did).
			if (!aborted) {
				counters[count.rejected]++;
				send(res, 400, { ok: false, error: "request stream error" });
			}
		});
	};

	return http.createServer((req, res) => {
		const url = (req.url || "/").split("?")[0];
		const ip = req.socket?.remoteAddress || "?";

		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"access-control-allow-origin": CORS_ORIGIN,
				"access-control-allow-headers": "content-type",
				"access-control-allow-methods": "GET, POST, OPTIONS",
			});
			return res.end();
		}

		if (req.method === "GET" && (url === "/health" || url === "/healthz")) {
			return void probe(api, relay.ss58).then((p) => {
				const { code, obj } = healthBody(p, MIN_BALANCE);
				send(res, code, obj);
			});
		}

		if (req.method === "GET" && url === "/metrics") {
			return void probe(api, relay.ss58).then((p) => {
				res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "access-control-allow-origin": CORS_ORIGIN });
				res.end(metricsBody(p, counters));
			});
		}

		// POST /bind — the identity (payment-key) bind: cognoGate.link_identity_signed.
		if (req.method === "POST" && url === "/bind") {
			return handleSponsorRoute(req, res, ip, {
				validate: validateBindBody,
				submit: submitBind,
				count: { total: "binds_total", ok: "binds_ok", rejected: "binds_rejected" },
			});
		}

		// POST /bind-stake — the voting-power (stake-key) bind: cognoGate.link_stake_signed. The account
		// must already be payment-bound; the runtime returns NotPaymentBound otherwise (relayed verbatim).
		if (req.method === "POST" && url === "/bind-stake") {
			return handleSponsorRoute(req, res, ip, {
				validate: validateStakeBindBody,
				submit: submitStakeBind,
				count: { total: "stake_binds_total", ok: "stake_binds_ok", rejected: "stake_binds_rejected" },
			});
		}

		return send(res, 404, { ok: false, error: "not found" });
	});
}

async function main() {
	const relay = makeRelaySigner();
	const client = createClient(getWsProvider(WS));
	const api = client.getTypedApi(cogno);

	// Pin the chain (mirrors the relayer): a mis-pointed WS could otherwise sponsor binds on the wrong
	// chain. Also surfaces the live genesis the proofs must commit.
	const genesisHex = stripHex((await client.getChainSpecData()).genesisHash);
	if (GENESIS && GENESIS !== genesisHex)
		throw new Error(
			`genesis mismatch: connected chain ${genesisHex.slice(0, 16)}… != expected GENESIS ${GENESIS.slice(0, 16)}… — refusing to sponsor binds on the wrong chain.`,
		);

	// Warn (don't refuse) if the relay account is unfunded at boot — the operator must top it up, but a
	// node that is still syncing should not crash startup.
	const acct = await api.query.System.Account.getValue(relay.ss58).catch(() => null);
	const balance = acct?.data?.free ?? null;

	const rate = new RateLimiter(RATE_LIMIT_PER_MIN);
	const server = makeServer(api, relay, rate);
	server.listen(PORT, HOST, () => {
		console.log(`Sponsored-Bind Relay (D1 bind-funding) on ${HOST}:${PORT}`, RELAY_BADGES);
		console.log(`  L3        = ${WS}  genesis ${genesisHex}`);
		console.log(`  relay key = ${relay.ss58}  (funded fee-payer — NOT a privileged key)`);
		console.log(`  balance   = ${balance == null ? "unknown (node syncing?)" : `${balance} planck`}${balance != null && balance < MIN_BALANCE ? "  ⚠ below MIN_BALANCE — top it up" : ""}`);
		console.log(`  routes    = POST /bind (identity), POST /bind-stake (voting power)`);
		console.log(`  limits    = ${RATE_LIMIT_PER_MIN}/min per-IP on each bind route, CORS ${CORS_ORIGIN}`);
		console.log(`  role      = LIVENESS-only fee payer: the runtime verifies every proof; the relay cannot forge or retarget a binding (D1)`);
	});
	server.on("error", (e) => {
		console.error(`[fatal] relay server (:${PORT}): ${e?.message || e}`);
		process.exit(1);
	});
}

if (isMain(import.meta.url))
	main().catch((e) => {
		console.error(`[startup-error] ${e?.message || e}`);
		process.exit(1);
	});
