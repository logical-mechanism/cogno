// M6 Track 1 live acceptance — MUTABLE Aura+GRANDPA validators (L3 §8.2).
//
// Assumes a multi-node `--chain local` network is already up (orchestrated by run-m6-track1.sh):
//   Alice  :9944 (genesis authority, this script's RPC)   Bob :9945 (genesis authority)
//   Charlie:9946 (full node, --charlie keys, NOT yet a validator)
//
// Proves end-to-end on a live network:
//   (0) genesis set = [Alice, Bob]; BOTH author (Aura) and finality advances (GRANDPA needs both).
//   (1) ADD a genuinely-new validator Charlie: register its (Aura, Grandpa) session keys with a
//       real proof-of-possession (setKeys), then `add_validator`. At the next-but-one session
//       boundary Charlie becomes active — it AUTHORS blocks (Aura) AND finality keeps advancing
//       (GRANDPA, which now needs Charlie's votes too). Aura↔GRANDPA stay in lockstep (setId++).
//   (2) REMOVE Bob: at the boundary the set drops to [Alice, Charlie] WITHOUT stalling finality.
//
// The proof-of-possession (the newer pallet-session API) is `sign("POP_" ++ account32)` with EACH
// session key, SCALE-encoded as the tuple (aura_sig, grandpa_sig) — see sp-core proof_of_possession.
import { connect, send, find, has } from "./lib.mjs";
import { Keyring } from "@polkadot/keyring";
import { u8aConcat, u8aToHex, stringToU8a } from "@polkadot/util";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const VIA = process.env.VIA || "sudo"; // add/remove driver; committee is proven in Track 2
const AURA_ENGINE = "0x61757261"; // "aura"
const ok = (m) => console.log(`  ✓ ${m}`);
const log = (m) => console.log(m);
const fail = (m) => { throw new Error(`TRACK-1 FAIL: ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function finalizedNumber(api) {
	const h = await api.rpc.chain.getFinalizedHead();
	return (await api.rpc.chain.getHeader(h)).number.toNumber();
}
async function bestNumber(api) {
	return (await api.rpc.chain.getHeader()).number.toNumber();
}
function auraAuthorIndex(api, header, nAuthorities) {
	const pre = header.digest.logs.find(
		(l) => l.isPreRuntime && l.asPreRuntime[0].toHex() === AURA_ENGINE,
	);
	if (!pre) return null;
	const slot = api.createType("u64", pre.asPreRuntime[1]).toBigInt(); // LE u64
	return Number(slot % BigInt(nAuthorities));
}
// Watch ~`blocks` new heads; return the set of distinct Aura author indices seen.
async function observeAuthors(api, blocks, nAuthorities) {
	const seen = new Set();
	let n = 0;
	await new Promise((resolve) => {
		let unsub;
		api.rpc.chain.subscribeNewHeads((header) => {
			const idx = auraAuthorIndex(api, header, nAuthorities);
			if (idx !== null) seen.add(idx);
			if (++n >= blocks) { if (unsub) unsub(); resolve(); }
		}).then((u) => (unsub = u));
	});
	return seen;
}
// Poll until predicate(validators) holds or timeout; returns the validators when it does.
async function waitForValidatorSet(api, predicate, label, timeoutMs = 240_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const vals = (await api.query.session.validators()).map((v) => v.toString());
		if (predicate(vals)) return vals;
		await sleep(3_000);
	}
	fail(`timed out waiting for: ${label}`);
}
// Assert finality advances by >= `by` blocks within the timeout (GRANDPA is live, not stalled).
async function assertFinalityAdvances(api, by, timeoutMs = 120_000) {
	const start = await finalizedNumber(api);
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const now = await finalizedNumber(api);
		if (now >= start + by) return now;
		await sleep(3_000);
	}
	fail(`finality did NOT advance ${by} blocks in ${timeoutMs / 1000}s (start=${start}) — GRANDPA STALLED`);
}

async function main() {
	const api = await connect(WS);
	const srKr = new Keyring({ type: "sr25519", ss58Format: 42 });
	const edKr = new Keyring({ type: "ed25519" });
	const acct = (n) => srKr.addFromUri(`//${n}`);
	const [alice, bob, charlie] = ["Alice", "Bob", "Charlie"].map(acct);

	const spec = api.runtimeVersion.specVersion.toNumber();
	log(`genesis: ${api.genesisHash.toHex()} | spec: ${spec} | add/remove via: ${VIA}`);
	if (spec !== 106) fail(`spec_version ${spec} != 106`);
	ok("spec_version == 106 (M6 runtime)");

	const sessionVals = async () => (await api.query.session.validators()).map((v) => v.toString());
	const auraLen = async () => (await api.query.aura.authorities()).length;
	const setId = async () => (await api.query.grandpa.currentSetId()).toNumber();
	const grandpaLen = async () => (await api.call.grandpaApi.grandpaAuthorities()).length;

	// ── (0) genesis set = [Alice, Bob]; both author; finality advances ──────────────────────────
	let vals = await sessionVals();
	log(`initial session.validators (${vals.length}): ${vals.map((v) => v.slice(0, 8)).join(", ")}`);
	if (vals.length !== 2) fail(`expected 2 genesis validators, got ${vals.length}`);
	if (!vals.includes(alice.address) || !vals.includes(bob.address)) fail("genesis set != [Alice, Bob]");
	if ((await auraLen()) !== 2 || (await grandpaLen()) !== 2) fail("aura/grandpa authorities != 2 at genesis");
	ok(`genesis validators = [Alice, Bob]; Aura==2 and GRANDPA==2 authorities (lockstep)`);

	const auraIdx = (a) => vals.indexOf(a.address); // index in the ordered authority list
	log("  observing ~6 blocks for Aura authorship…");
	let authors = await observeAuthors(api, 6, 2);
	if (!authors.has(0) || !authors.has(1)) fail(`only authority indices ${[...authors]} authored — both should`);
	ok(`BOTH genesis authorities author (saw Aura indices ${[...authors].sort().join(", ")})`);
	await assertFinalityAdvances(api, 2);
	ok("finality advances at genesis (GRANDPA finalizing with the 2-validator set)");

	const setId0 = await setId();

	// ── (1) ADD a genuinely-new validator: Charlie (register session keys + PoP, then add) ───────
	log("\n[phase 1] onboarding a NEW validator //Charlie (setKeys + proof-of-possession → add_validator)");
	// Build Charlie's (Aura sr25519, Grandpa ed25519) session keys + the PoP over "POP_"++account.
	const cAura = srKr.addFromUri("//Charlie"); // sr25519 — also the account id
	const cGran = edKr.addFromUri("//Charlie"); // ed25519
	const statement = u8aConcat(stringToU8a("POP_"), charlie.publicKey); // owner = 32-byte account
	const proof = u8aToHex(u8aConcat(cAura.sign(statement), cGran.sign(statement))); // tuple(Sig,Sig)=128B
	// @polkadot/api resolves the SessionKeys type from the setKeys arg; pass {aura, grandpa} directly.
	const keys = { aura: u8aToHex(cAura.publicKey), grandpa: u8aToHex(cGran.publicKey) };
	await send(api, api.tx.session.setKeys(keys, proof), charlie, "setKeys");
	const nextKeys = await api.query.session.nextKeys(charlie.address);
	if (nextKeys.isNone) fail("Charlie's session keys were NOT registered (setKeys/PoP rejected?)");
	ok("Charlie registered its (Aura, Grandpa) session keys via setKeys + a valid proof-of-possession");

	const submittedAt = await bestNumber(api);
	if (VIA === "committee") {
		const { drive } = await import("./lib.mjs");
		await drive(api, api.tx.validatorSet.addValidator(charlie.address), { via: "committee", log: (m) => log("  " + m) });
	} else {
		await send(api, api.tx.sudo.sudo(api.tx.validatorSet.addValidator(charlie.address)), alice, "add_validator");
	}
	const addEvt = "ValidatorAdditionInitiated"; // the audit-log event
	ok(`add_validator(//Charlie) accepted at #${submittedAt} (event ${addEvt}); queued to a session boundary`);

	log("  waiting for the session boundary to ACTIVATE Charlie (~2 sessions)…");
	vals = await waitForValidatorSet(api, (v) => v.includes(charlie.address) && v.length === 3, "[Alice,Bob,Charlie]");
	ok(`session boundary applied: session.validators now [Alice, Bob, Charlie] (${vals.length})`);
	if ((await auraLen()) !== 3) fail(`Aura authorities ${await auraLen()} != 3 after add`);
	if ((await grandpaLen()) !== 3) fail(`GRANDPA authorities ${await grandpaLen()} != 3 after add`);
	const setId1 = await setId();
	if (setId1 <= setId0) fail(`GRANDPA set id did not advance on the authority change (${setId0} -> ${setId1})`);
	ok(`Aura==3 AND GRANDPA==3 (in lockstep); GRANDPA set id advanced ${setId0} -> ${setId1}`);

	// Re-read the ordered set to map Charlie's Aura index, then confirm Charlie AUTHORS.
	vals = await sessionVals();
	const charlieIdx = vals.indexOf(charlie.address);
	log(`  observing ~12 blocks for Charlie (Aura index ${charlieIdx}) to author…`);
	authors = await observeAuthors(api, 12, 3);
	if (!authors.has(charlieIdx)) fail(`new validator //Charlie (index ${charlieIdx}) did NOT author (saw ${[...authors]})`);
	ok(`the NEW validator //Charlie AUTHORS blocks (saw its Aura index ${charlieIdx})`);
	await assertFinalityAdvances(api, 3);
	ok("finality advances WITH the 3-validator set — GRANDPA needs Charlie's votes, so Charlie is finalizing too");

	// ── (2) REMOVE Bob: set shrinks to [Alice, Charlie] without stalling finality ────────────────
	log("\n[phase 2] removing //Bob (set shrinks to [Alice, Charlie]) — finality must NOT stall");
	if (VIA === "committee") {
		const { drive } = await import("./lib.mjs");
		await drive(api, api.tx.validatorSet.removeValidator(bob.address), { via: "committee", log: (m) => log("  " + m) });
	} else {
		await send(api, api.tx.sudo.sudo(api.tx.validatorSet.removeValidator(bob.address)), alice, "remove_validator");
	}
	ok("remove_validator(//Bob) accepted (event ValidatorRemovalInitiated); queued to a session boundary");
	log("  waiting for the session boundary to drop Bob (~2 sessions)…");
	vals = await waitForValidatorSet(api, (v) => !v.includes(bob.address) && v.length === 2, "[Alice,Charlie]");
	if (!vals.includes(alice.address) || !vals.includes(charlie.address)) fail(`post-remove set != [Alice,Charlie]: ${vals}`);
	if ((await auraLen()) !== 2 || (await grandpaLen()) !== 2) fail("aura/grandpa != 2 after remove");
	const setId2 = await setId();
	if (setId2 <= setId1) fail(`GRANDPA set id did not advance on removal (${setId1} -> ${setId2})`);
	ok(`session.validators now [Alice, Charlie]; Aura==2 and GRANDPA==2; set id advanced ${setId1} -> ${setId2}`);
	await assertFinalityAdvances(api, 2);
	ok("finality STILL advances after the removal — no stall (the set never dropped below MinAuthorities=1)");

	log("\nTRACK 1 PASSED — mutable Aura+GRANDPA validators: new validator onboarded (setKeys+PoP→add, authored+finalized), Bob removed, finality survived every transition, Aura↔GRANDPA in lockstep.");
	await api.disconnect();
	process.exit(0);
}
main().catch(async (e) => { console.error("\n" + (e.stack || e)); process.exit(1); });
