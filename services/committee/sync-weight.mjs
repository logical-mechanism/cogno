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
// Read safety (committee-1): the Kupo read that drives the crown-jewel weight is hardened — res.ok +
// JSON validation + timeout + bounded retry (fetchJson), and an optional reorg-burial gate
// (CONFIRM_DEPTH_SLOTS, cross-checked against the Ogmios tip) so a UTxO that could still roll back is
// NOT credited. A read failure aborts the whole sync rather than writing a wrong/partial weight.
//
// ⚠ HONESTY (DR-07): single-operator stack ⇒ D2-SHAPED, not D2-TRUST. See docs/D2-custody-runbook.md.
import fs from "node:fs";
import { isMain } from "../_shared/cli.mjs";
import { connect, drive, has, operators, fetchJson } from "./lib.mjs";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const KUPO = process.env.KUPO;
const OGMIOS = process.env.OGMIOS || "http://127.0.0.1:1337";
const VAULT_FILE = process.env.VAULT_FILE || "/tmp/cogno-m2/vault.json";
const MIN_LOCK = 100_000_000n;
// Reorg-burial depth in Cardano SLOTS (DR-09b): only credit a vault UTxO buried this many slots past
// the tip, so a lock/exit that later rolls back can't set a wrong weight. 0 = credit as soon as it is
// unspent (fast, dev showcase); production sets a few hundred slots.
const CONFIRM_DEPTH_SLOTS = Number(process.env.CONFIRM_DEPTH_SLOTS || "0");

export function parseArgv(argv) {
	const o = { via: "committee" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--account") o.account = argv[++i];
		else if (a === "--weight") o.weight = BigInt(argv[++i]);
		else if (a === "--via") o.via = argv[++i];
	}
	return o;
}

// PURE: from a list of Kupo matches, pick the largest valid single-beacon UTxO per beacon
// (anti-Sybil largest-wins, never a sum). A match counts only if it carries EXACTLY ONE asset of the
// vault policy at quantity 1; with `confirmDepth>0` it must also be buried >= confirmDepth slots past
// `tipSlot` (an un-buried or slot-less match is skipped, never credited). Returns Map<beaconHex, lovelace>.
export function pickLargest(matches, vaultHash, { tipSlot = null, confirmDepth = 0 } = {}) {
	const largest = new Map();
	for (const m of matches) {
		const assets = m.value?.assets ?? {};
		const beacons = Object.entries(assets).filter(([k]) => k.split(".")[0].toLowerCase() === vaultHash.toLowerCase());
		if (beacons.length !== 1 || Number(beacons[0][1]) !== 1) continue; // exactly one beacon, qty 1
		if (confirmDepth > 0) {
			const slot = m.created_at?.slot_no;
			if (slot == null || tipSlot == null || tipSlot - slot < confirmDepth) continue; // not buried ⇒ skip
		}
		const beacon = beacons[0][0].split(".")[1].toLowerCase();
		const coins = BigInt(m.value.coins);
		if (coins > (largest.get(beacon) ?? -1n)) largest.set(beacon, coins);
	}
	return largest;
}

// PURE: the MIN_LOCK gate — locked lovelace at/above the floor becomes weight, below it is zero.
export const lockToWeight = (lovelace, minLock = MIN_LOCK) => (lovelace >= minLock ? lovelace : 0n);

// The Cardano tip slot via Ogmios (for the reorg-burial gate). Throws on failure — when a burial
// depth is required we must FAIL CLOSED rather than credit weight without the check.
async function ogmiosTipSlot(ogmios = OGMIOS) {
	const { result } = await fetchJson(ogmios, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", method: "queryNetwork/tip" }),
	});
	const slot = result?.slot;
	if (slot == null) throw new Error("Ogmios queryNetwork/tip returned no slot");
	return slot;
}

// Observe the vault's beacon UTxOs and reduce to largest-wins lovelace per identity (committee-1).
async function observeKupo(vaultHash, { kupo = KUPO, ogmios = OGMIOS, confirmDepth = CONFIRM_DEPTH_SLOTS } = {}) {
	// Quote the Kupo `.*` pattern arg defensively (shell-glob gotcha) — here it's a URL, so it's literal.
	const matches = await fetchJson(`${kupo}/matches/${vaultHash}.*?unspent`);
	if (!Array.isArray(matches)) throw new Error(`Kupo /matches did not return an array for ${vaultHash}`);
	let tipSlot = null;
	if (confirmDepth > 0) {
		tipSlot = await ogmiosTipSlot(ogmios); // throws ⇒ abort the sync (fail closed)
	}
	return pickLargest(matches, vaultHash, { tipSlot, confirmDepth });
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
			// dev mode: one account, explicit operator-supplied weight (the showcase path when Cardano
			// is not wired). The MIN_LOCK gate applies only to live vault-observed lovelace, not to a
			// manual override, so the explicit weight is used verbatim.
			await setStakeFor(api, ops, opt, opt.account, opt.weight);
		} else if (KUPO) {
			// live mode: observe the vault, largest-wins, set_stake per bound identity.
			const vaultHash = JSON.parse(fs.readFileSync(VAULT_FILE, "utf8")).vaultHash;
			const largest = await observeKupo(vaultHash);
			console.log(`observed ${largest.size} identity(ies) from the vault (confirm-depth ${CONFIRM_DEPTH_SLOTS} slots)`);
			for (const [beacon, lovelace] of largest) {
				// AccountOf lookup via @polkadot/api (dynamic) — beacon is a 32-byte hash key.
				const account = await api.query.cognoGate.accountOf("0x" + beacon);
				if (account.isNone) { console.log(`  · ${beacon.slice(0, 12)}… ${lovelace} — NOT bound, skip`); continue; }
				await setStakeFor(api, ops, opt, account.unwrap().toString(), lockToWeight(lovelace));
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

// Run only when invoked directly (not when imported by tests).
if (isMain(import.meta.url)) main();
