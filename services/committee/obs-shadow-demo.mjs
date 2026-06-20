// Live acceptance for the in-protocol-observation D4 shadow→enforce path (step 4d). Against the LIVE
// preprod vault + a local node carrying the spec-109 cardanoObserver pallet, it proves:
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
//   DBSYNC_URL=postgres://… WS=ws://127.0.0.1:9944 node obs-shadow-demo.mjs
//
// The vault beacon must already be bound to an account via the trustless CIP-8 self-proof
// (`cognoGate.link_identity_signed`) — D1 removed the operator/sudo bind, so this demo no longer binds.
import { isMain } from "../_shared/cli.mjs";
import { connect, drive, operators } from "./lib.mjs";
import { pickLargest } from "./sync-weight.mjs";
import { readUnspentMatches } from "./dbsync.mjs";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const DBSYNC = process.env.DBSYNC_URL || process.env.DBSYNC;

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
	if (!DBSYNC) throw new Error("set DBSYNC_URL — this demo reads the live vault via Cardano db-sync");
	const api = await connect(WS);
	const ops = operators();
	const spec = api.runtimeVersion.specVersion.toNumber();
	console.log(`chain ${api.genesisHash.toHex().slice(0, 10)}… spec ${spec}`);
	if (!api.query.cardanoObserver?.shadowStake)
		throw new Error(`spec ${spec} has no cardanoObserver.shadowStake — needs the cardanoObserver pallet (spec >= 109)`);

	// 1. Resolve the LIVE vault beacon from db-sync (the consensus-pinned policy id from chain).
	const vaultHex = api.consts.cardanoObserver.vaultPolicyId.toHex().replace(/^0x/, "");
	const matches = await readUnspentMatches(DBSYNC, vaultHex);
	const largest = pickLargest(matches, vaultHex);
	if (largest.size !== 1) throw new Error(`expected exactly one live vault beacon, found ${largest.size}`);
	const [beacon, lovelace] = [...largest][0];
	console.log(`live vault: beacon ${beacon.slice(0, 12)}… = ${lovelace} lovelace (policy ${vaultHex.slice(0, 12)}…)`);

	// 2. Resolve the account the beacon is bound to. In the trustless world (D1) there is NO operator/sudo
	//    bind: the beacon→account link is a CIP-8 self-proof SIGNED BY THE VAULT OWNER
	//    (`cognoGate.link_identity_signed`), so this demo requires the beacon to be PRE-BOUND out-of-band
	//    (the in-browser bind, the sponsored-bind relay, or app/scripts/d1-acceptance with the vault wallet).
	const bound = await api.query.cognoGate.accountOf("0x" + beacon);
	if (bound.isNone)
		throw new Error(
			`live vault beacon ${beacon.slice(0, 12)}… is not bound to any account. Bind it first via the ` +
			`trustless self-proof (cognoGate.link_identity_signed) — there is no operator/sudo bind anymore. ` +
			`See docs/TRUSTLESS-IDENTITY.md and services/sponsored-bind-relay/.`,
		);
	const account = bound.unwrap().toString();
	const label = `${account.slice(0, 8)}…`;
	console.log(`beacon bound → ${label} (the CIP-8 self-proof target; the observer projects weight here)`);

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
	console.log(`  ✓ ShadowStake[${label}] = ${wantWeight} (projected by the inherent)`);
	console.log(`  ✓ AllowedStake[${label}] = 0 (inherent did NOT apply weight in shadow — committee remains sole writer)`);

	// 4. ENFORCE: flip the gated flag, then assert the SAME inherent now writes AllowedStake.
	console.log("\n[ENFORCE] flipping set_enforcement(true) via sudo (the gated cutover control)…");
	await drive(api, api.tx.cardanoObserver.setEnforcement(true), { operators: ops, via: "sudo", log: () => {} });
	console.log("  waiting for the next observe inherent to APPLY the weight…");
	await waitForHead(api, "enforced application", 12, async () => (await allowedOf()) === wantWeight);
	console.log(`  ✓ AllowedStake[${label}] = ${wantWeight} — set by the consensus-verified inherent (credited=1)`);

	// 5. Reset to the safe default (shadow) so the chain is not left in an enforce posture.
	await drive(api, api.tx.cardanoObserver.setEnforcement(false), { operators: ops, via: "sudo", log: () => {} });
	console.log("  ✓ reset the FLAG to SHADOW (the AllowedStake credited in enforce is left as-is — throwaway chain only)");

	console.log("\n=== MECHANISM PROVEN: the in-protocol observation inherent CAN write talk-stake weight ===");
	console.log("⚠ NOT a trust property on a single producer — D4-SHAPED, not D4-TRUST. Cutover is gated on");
	console.log("  ≥3 independent producers (IN-PROTOCOL-OBSERVATION.md §2/§9); the committee path is untouched.");
	await api.disconnect();
	process.exit(0);
}

if (isMain(import.meta.url)) main().catch((e) => { console.error("DEMO FAILED:", e?.message || e); process.exit(1); });
