// Live acceptance for the in-protocol-observation D4 shadow→enforce path (step 4d). Against the LIVE
// preprod vault + a local node carrying the spec-108 cardanoObserver pallet, it proves:
//   1. SHADOW (the default): the verified `observe` inherent records a per-account PROJECTION
//      (`cardanoObserver.ShadowStake`) but does NOT write `talkStake.AllowedStake` — the committee
//      stays the sole weight writer.
//   2. ENFORCE: after `set_enforcement(true)`, the SAME inherent writes `AllowedStake` = the locked
//      lovelace (the demo's `credited=1`).
//
// ⚠ MECHANISM PROOF ONLY. On a single producer there is no independent verifier, so this is
// D4-SHAPED, NOT D4-TRUST (docs/IN-PROTOCOL-OBSERVATION.md §2/§6). Run it on a THROWAWAY local chain the
// production committee does not also sync (else enforce mode and the committee fight over AllowedStake).
//
//   KUPO=http://127.0.0.1:1442 WS=ws://127.0.0.1:9944 node obs-shadow-demo.mjs [--account //Bob]
import { encodeAddress } from "@polkadot/util-crypto";
import { isMain } from "../_shared/cli.mjs";
import { connect, drive, operators, fetchJson } from "./lib.mjs";
import { pickLargest } from "./sync-weight.mjs";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const KUPO = process.env.KUPO || "http://127.0.0.1:1442";

const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; };

// Subscribe to new heads and resolve when `predicate(blockNumber)` (async) returns truthy, or reject
// after `maxBlocks` heads — the deterministic way to wait for the every-block inherent to land.
async function waitForHead(api, label, maxBlocks, predicate) {
	let seen = 0;
	return new Promise((resolve, reject) => {
		let unsub;
		const done = (fn, v) => { if (unsub) unsub(); fn(v); };
		api.rpc.chain.subscribeNewHeads(async (header) => {
			const n = header.number.toNumber();
			try {
				const v = await predicate(n);
				if (v) return done(resolve, v);
			} catch (e) { return done(reject, e); }
			if (++seen >= maxBlocks) done(reject, new Error(`timed out after ${maxBlocks} blocks waiting for: ${label}`));
		}).then((u) => { unsub = u; }).catch(reject);
	});
}

async function main() {
	const api = await connect(WS);
	const ops = operators();
	const spec = api.runtimeVersion.specVersion.toNumber();
	console.log(`chain ${api.genesisHash.toHex().slice(0, 10)}… spec ${spec}`);
	if (!api.query.cardanoObserver?.shadowStake)
		throw new Error(`spec ${spec} has no cardanoObserver.shadowStake — needs the spec-108 observer`);

	// 1. Resolve the LIVE vault beacon from this node's own Kupo (the consensus-pinned policy id from chain).
	const vaultHex = api.consts.cardanoObserver.vaultPolicyId.toHex().replace(/^0x/, "");
	const matches = await fetchJson(`${KUPO}/matches/${vaultHex}.*?unspent`);
	const largest = pickLargest(matches, vaultHex);
	if (largest.size !== 1) throw new Error(`expected exactly one live vault beacon, found ${largest.size}`);
	const [beacon, lovelace] = [...largest][0];
	console.log(`live vault: beacon ${beacon.slice(0, 12)}… = ${lovelace} lovelace (policy ${vaultHex.slice(0, 12)}…)`);

	// 2. Bind the beacon → the demo account (sudo), unless already bound to it.
	const acctUri = arg("--account", "//Bob");
	const pair = ops.kr.addFromUri(acctUri);
	const account = encodeAddress(pair.publicKey, 42);
	const bound = await api.query.cognoGate.accountOf("0x" + beacon);
	if (bound.isNone) {
		console.log(`binding beacon → ${acctUri} (${account.slice(0, 8)}…) via sudo…`);
		await drive(api, api.tx.cognoGate.linkIdentity("0x" + beacon, account, null), { operators: ops, via: "sudo", log: () => {} });
	} else if (bound.unwrap().toString() !== account) {
		throw new Error(`beacon already bound to a DIFFERENT account ${bound.unwrap().toString()} (expected ${account}); use --account or a fresh chain`);
	} else {
		console.log(`beacon already bound to ${acctUri}`);
	}

	const wantWeight = lovelace; // weight == locked lovelace (>= MIN_LOCK 100 ADA)
	const shadowOf = async () => (await api.query.cardanoObserver.shadowStake(account)).toBigInt();
	const allowedOf = async () => (await api.query.talkStake.allowedStake(account)).toBigInt();

	// 3. SHADOW: wait for the inherent to PROJECT the weight, and assert AllowedStake stays untouched.
	const enforced0 = (await api.query.cardanoObserver.enforceWeight()).isTrue;
	if (enforced0) throw new Error("expected to start in SHADOW mode (EnforceWeight=false) — reset the chain");
	console.log("\n[SHADOW] waiting for the observe inherent to project the bound weight…");
	await waitForHead(api, "shadow projection", 12, async () => (await shadowOf()) === wantWeight);
	const allowedInShadow = await allowedOf();
	if (allowedInShadow !== 0n) throw new Error(`SHADOW violated: AllowedStake=${allowedInShadow} (expected 0 — the inherent must not write weight in shadow)`);
	console.log(`  ✓ ShadowStake[${acctUri}] = ${wantWeight} (projected by the inherent)`);
	console.log(`  ✓ AllowedStake[${acctUri}] = 0 (inherent did NOT apply weight in shadow — committee remains sole writer)`);

	// 4. ENFORCE: flip the gated flag, then assert the SAME inherent now writes AllowedStake.
	console.log("\n[ENFORCE] flipping set_enforcement(true) via sudo (the gated cutover control)…");
	await drive(api, api.tx.cardanoObserver.setEnforcement(true), { operators: ops, via: "sudo", log: () => {} });
	console.log("  waiting for the next observe inherent to APPLY the weight…");
	await waitForHead(api, "enforced application", 12, async () => (await allowedOf()) === wantWeight);
	console.log(`  ✓ AllowedStake[${acctUri}] = ${wantWeight} — set by the consensus-verified inherent (credited=1)`);

	// 5. Reset to the safe default (shadow) so the chain is not left in an enforce posture.
	await drive(api, api.tx.cardanoObserver.setEnforcement(false), { operators: ops, via: "sudo", log: () => {} });
	console.log("  ✓ reset to SHADOW (the safe default)");

	console.log("\n=== MECHANISM PROVEN: the in-protocol observation inherent CAN write talk-stake weight ===");
	console.log("⚠ NOT a trust property on a single producer — D4-SHAPED, not D4-TRUST. Cutover is gated on");
	console.log("  ≥3 independent producers (IN-PROTOCOL-OBSERVATION.md §2/§9); the committee path is untouched.");
	await api.disconnect();
	process.exit(0);
}

if (isMain(import.meta.url)) main().catch((e) => { console.error("DEMO FAILED:", e?.message || e); process.exit(1); });
