// M6 — the general operator CLI: drive ANY privileged call through the 3-of-5 FollowerCommittee or
// sudo. This generalizes the M2/M3 single-purpose sudo drivers (grant-weight / sync-weight /
// anchor_ack) into one reusable propose→vote→close (or sudo) tool.
//
//   node op.mjs --call <pallet>.<method> --args '<jsonArray>' [--via committee|sudo] [--ws <url>]
//
// Examples (camelCase pallet.method, JSON args; ss58 addresses + decimal-string bignums):
//   node op.mjs --call talkStake.setStake     --args '["5Grw…", "42000000"]'
//   node op.mjs --call anchor.anchorAck       --args '[123, "0x<root>", "0x<txhash>", 7, 0]'
//   node op.mjs --call validatorSet.addValidator --args '["5FHneW…"]'  --via committee
//   node op.mjs --call talkStake.setStake     --args '["5Grw…", "0"]'  --via sudo   # dev fallback
import { isMain } from "../_shared/cli.mjs";
import { connect, drive, find, operators, resolveCommittee, assertRealKeys, assertGenesis } from "./lib.mjs";

function parseArgv(argv) {
	const o = { via: "committee" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--call") o.call = argv[++i];
		else if (a === "--args") o.args = argv[++i];
		else if (a === "--via") o.via = argv[++i];
		else if (a === "--ws") o.ws = argv[++i];
		else if (a === "--threshold") o.threshold = Number(argv[++i]);
	}
	return o;
}

// Revive decimal strings into BigInt so large balances/weights encode losslessly; pass through
// hex strings, ss58 addresses, numbers, null. (JSON has no BigInt; we use decimal-string convention.)
export function revive(v) {
	if (typeof v === "string" && /^[0-9]+$/.test(v) && v.length > 0) return BigInt(v);
	return v;
}

async function main() {
	const opt = parseArgv(process.argv.slice(2));
	if (!opt.call || !opt.args) {
		console.error("usage: node op.mjs --call <pallet>.<method> --args '<jsonArray>' [--via committee|sudo]");
		process.exit(2);
	}
	const [pallet, method] = opt.call.split(".");
	const args = JSON.parse(opt.args).map(revive);

	const api = await connect(opt.ws);
	try {
		const spec = api.runtimeVersion.specVersion.toNumber();
		console.log(`chain ${api.genesisHash.toHex().slice(0, 10)}… spec ${spec} | ${opt.call}(${args.length} args) via ${opt.via}`);
		if (!api.tx[pallet] || !api.tx[pallet][method])
			throw new Error(`no such call api.tx.${pallet}.${method} (check camelCase + spec ${spec})`);

		assertRealKeys(opt.via); // fail-closed (Phase 3): no public dev keys under COGNO_PROFILE=prod
		assertGenesis(api);      // pin the chain (Phase 3): refuse the wrong chain if GENESIS is set

		const innerCall = api.tx[pallet][method](...args);
		const ops = operators();
		const driveOpts = { via: opt.via, log: (m) => console.log("  " + m) };
		if (opt.via === "committee") {
			// Threshold from ON-CHAIN membership (Phase 3): ceil(n*3/5), not a hardcoded 3 (which fails
			// the 3/5 origin on any non-5-seat committee). Also reconciles your seeds vs the live members.
			const rc = await resolveCommittee(api, ops, { explicitThreshold: opt.threshold });
			Object.assign(driveOpts, { threshold: rc.threshold, members: rc.members, operators: ops });
			console.log(`  committee: ${rc.threshold}-of-${rc.onchainCount} (threshold from on-chain membership)`);
		} else {
			driveOpts.threshold = opt.threshold;
		}
		const res = await drive(api, innerCall, driveOpts);

		// Surface the executed inner result (collective Executed wraps the dispatch result).
		const executed = find(res.evs, "followerCommittee", "Executed") || find(res.evs, "sudo", "Sudid");
		const okMsg = executed
			? `executed (${executed.section}.${executed.method}); inner events: ${res.evs.map((e) => `${e.section}.${e.method}`).filter((s) => !s.startsWith("system.") && !s.startsWith("followerCommittee.") && !s.startsWith("balances.")).join(", ") || "(see chain)"}`
			: "(submitted)";
		console.log(`✓ ${opt.call} ${okMsg}`);
		await api.disconnect();
		process.exit(0);
	} catch (e) {
		console.error("OP FAILED:", e?.message || e);
		await api.disconnect();
		process.exit(1);
	}
}

// Run only when invoked directly (not when imported by tests).
if (isMain(import.meta.url)) main();
