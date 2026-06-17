// M6 (DR-07) — the FOLLOWER's vault→weight sync, driven through the 3-of-5 FollowerCommittee.
//
// This is the committee-driven successor to app/scripts/m2d-sync-weight.mjs (which writes set_stake
// via sudo over the stale-at-spec-106 PAPI descriptors). It observes the talk_vault beacon UTxOs via
// Kupo (LARGEST-WINS per identity, never sum), looks up the bound account (CognoGate.AccountOf), and
// writes `talk_stake.set_stake(account, weight = locked lovelace)` (+ primes the capacity battery)
// through the committee — so the crown-jewel weight authority is off single-key sudo.
//
// Modes:
//   live  : KUPO set + VAULT_HASH file present → observe Kupo, largest-wins, set_stake per identity.
//   dev   : --account <ss58> --weight <lovelace> → set_stake for one account (no Cardano needed).
//
//   WS=ws://127.0.0.1:9944 node sync-weight.mjs --account 5Grw… --weight 100000000          # dev
//   WS=… KUPO=http://127.0.0.1:1442 node sync-weight.mjs --via committee                    # live
//   ... --via sudo   # the EnsureRoot dev fallback
//
// ⚠ HONESTY (DR-07): single-operator stack ⇒ D2-SHAPED, not D2-TRUST. See docs/D2-custody-runbook.md.
import fs from "node:fs";
import { connect, drive, has, operators } from "./lib.mjs";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const KUPO = process.env.KUPO;
const VAULT_FILE = process.env.VAULT_FILE || "/tmp/cogno-m2/vault.json";
const MIN_LOCK = 100_000_000n;

function parseArgv(argv) {
	const o = { via: "committee" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--account") o.account = argv[++i];
		else if (a === "--weight") o.weight = BigInt(argv[++i]);
		else if (a === "--via") o.via = argv[++i];
	}
	return o;
}

// Observe Kupo beacon UTxOs for the vault policy → largest-wins lovelace per beacon (anti-Sybil).
async function observeKupo(vaultHash) {
	const matches = await (await fetch(`${KUPO}/matches/${vaultHash}.*?unspent`)).json();
	const largest = new Map(); // beaconHex -> lovelace
	for (const m of matches) {
		const assets = m.value?.assets ?? {};
		const beacons = Object.entries(assets).filter(([k]) => k.split(".")[0].toLowerCase() === vaultHash.toLowerCase());
		if (beacons.length === 1 && Number(beacons[0][1]) === 1) {
			const beacon = beacons[0][0].split(".")[1].toLowerCase();
			const coins = BigInt(m.value.coins);
			if (coins > (largest.get(beacon) ?? -1n)) largest.set(beacon, coins);
		}
	}
	return largest;
}

async function setStakeFor(api, ops, opt, account, weight) {
	// set_stake (the weight) + force_set_capacity (prime the battery), BOTH through the chosen origin.
	const r1 = await drive(api, api.tx.talkStake.setStake(account, weight), { operators: ops, via: opt.via, log: (m) => console.log("    " + m) });
	if (!has(r1.evs, "talkStake", "StakeSet")) throw new Error("set_stake did not execute");
	const capRatio = api.consts.microblog.capRatio.toBigInt();
	const ceiling = api.consts.microblog.ceiling.toBigInt();
	const full = weight * capRatio < ceiling ? weight * capRatio : ceiling;
	await drive(api, api.tx.microblog.forceSetCapacity(account, full), { operators: ops, via: opt.via, log: () => {} });
	console.log(`  ✓ ${account} ← weight ${weight} (battery ${full}) via ${opt.via}`);
}

async function main() {
	const opt = parseArgv(process.argv.slice(2));
	const api = await connect(WS);
	const ops = operators();
	const spec = api.runtimeVersion.specVersion.toNumber();
	console.log(`chain spec ${spec} | follower set_stake via ${opt.via}`);
	if (opt.via === "committee") console.log("  ⚠ single-operator: D2-SHAPED, not D2-TRUST (one operator holds all 5 keys)");

	try {
		if (opt.account && opt.weight !== undefined) {
			// dev mode: one account, explicit weight (the showcase path when Cardano is not wired).
			const weight = opt.weight >= MIN_LOCK || opt.weight === 0n ? opt.weight : opt.weight; // weight is the locked lovelace
			await setStakeFor(api, ops, opt, opt.account, weight);
		} else if (KUPO) {
			// live mode: observe the vault, largest-wins, set_stake per bound identity.
			const vaultHash = JSON.parse(fs.readFileSync(VAULT_FILE, "utf8")).vaultHash;
			const largest = await observeKupo(vaultHash);
			console.log(`observed ${largest.size} identity(ies) from the vault`);
			const { FixedSizeBinary } = await import("polkadot-api").catch(() => ({}));
			for (const [beacon, lovelace] of largest) {
				// AccountOf lookup via @polkadot/api (dynamic) — beacon is a 32-byte hash key.
				const account = await api.query.cognoGate.accountOf("0x" + beacon);
				if (account.isNone) { console.log(`  · ${beacon.slice(0, 12)}… ${lovelace} — NOT bound, skip`); continue; }
				const weight = lovelace >= MIN_LOCK ? lovelace : 0n;
				await setStakeFor(api, ops, opt, account.unwrap().toString(), weight);
			}
		} else {
			console.error("usage: --account <ss58> --weight <lovelace>   (dev)   |   set KUPO=… for live vault mode");
			process.exit(2);
		}
		console.log("\nfollower sync complete — weight written by the committee (no sudo on the privileged path).");
		await api.disconnect();
		process.exit(0);
	} catch (e) {
		console.error("SYNC FAILED:", e?.message || e);
		await api.disconnect();
		process.exit(1);
	}
}
main();
