// Unit tests for the trust-critical committee drivers (committee-3). No framework — plain node,
// matching the repo's *.mjs acceptance-script style:  node committee.test.mjs
//
// Covers the PURE logic that had zero coverage (only the live acceptance scripts exercised it):
//   • revive            — JSON decimal-string → BigInt coercion (op.mjs arg decoding)
//   • pickLargest       — the anti-Sybil largest-wins vault filter + reorg-burial gate (sync-weight)
//   • lockToWeight      — the MIN_LOCK gate
//   • viaCommittee      — propose → vote ×k → close → Approved+Executed (mock api), incl. failure
//   • send              — terminal non-inclusion status rejects (so finalize-mode can't hang)
import { revive } from "./op.mjs";
import { pickLargest, lockToWeight } from "./sync-weight.mjs";
import { viaCommittee, viaSudo, send, resolveCommittee, assertRealKeys, assertGenesis } from "./lib.mjs";

let PASS = 0, FAIL = 0;
const ok = (cond, msg) => { if (cond) { PASS++; console.log(`  ✓ ${msg}`); } else { FAIL++; console.log(`  ✗ FAIL: ${msg}`); } };
async function throws(fn, msg) {
	try { await fn(); ok(false, `${msg} (should have thrown)`); }
	catch (e) { ok(true, `${msg} → threw: ${String(e.message || e).slice(0, 60)}`); }
}

// ── revive ───────────────────────────────────────────────────────────────────────────────────
console.log("\n[revive] JSON arg → typed value");
ok(revive("123") === 123n, "decimal string → BigInt");
ok(revive("007") === 7n, "leading-zero decimal → BigInt");
ok(revive("") === "", "empty string passes through (not 0)");
ok(revive("0xabc123") === "0xabc123", "hex string passes through");
ok(revive("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY") === "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", "ss58 address passes through");
ok(revive(null) === null && revive(42) === 42, "null / number pass through");
// gap 11: a very large decimal string must convert losslessly (BigInt has no fixed width — no truncation).
const big = "9" + "0".repeat(100);
ok(revive(big) === BigInt(big) && revive(big).toString().length === 101, "very large decimal string → BigInt, no truncation");
// gap 15: scientific notation is NOT all-digits, so it passes through as a string (regex is intentional).
ok(revive("1e10") === "1e10", "scientific notation passes through as string (not coerced to BigInt)");
ok(revive("-5") === "-5", "negative number-string passes through (regex requires all digits)");

// ── pickLargest ──────────────────────────────────────────────────────────────────────────────
console.log("\n[pickLargest] anti-Sybil vault filter + burial gate");
const V = "ab".repeat(28);            // 56-hex policy id
const A = "11".repeat(32), B = "22".repeat(32); // 64-hex beacon names
let _utxoSeq = 0;
const mk = (coins, name, qty = 1, slot = 0, extra = {}) => ({
	transaction_id: (_utxoSeq++).toString(16).padStart(64, "0"), // unique per UTxO (realistic match shape)
	output_index: 0,
	value: { coins: String(coins), assets: { [`${V}.${name}`]: String(qty), ...extra } },
	created_at: { slot_no: slot },
});

let m = pickLargest([mk(100, A), mk(250, A), mk(180, A)], V);
ok(m.size === 1 && m.get(A) === 250n, "largest-wins per beacon (250, never the 530 sum)");

m = pickLargest([mk(100, A), mk(300, B)], V);
ok(m.size === 2 && m.get(A) === 100n && m.get(B) === 300n, "two distinct beacons tracked separately");

m = pickLargest([mk(500, A, 2)], V);
ok(m.size === 0, "beacon quantity != 1 rejected (no half-mint counts)");

m = pickLargest([{ value: { coins: "900", assets: { [`${V}.${A}`]: "1", [`${V}.${B}`]: "1" } }, created_at: { slot_no: 0 } }], V);
ok(m.size === 0, "two vault-policy assets in one UTxO rejected (must be exactly one beacon)");

m = pickLargest([mk(700, A, 1, 0, { ["cc".repeat(28) + ".deadbeef"]: "5" })], V);
ok(m.size === 1 && m.get(A) === 700n, "an unrelated non-vault asset alongside the beacon is fine");

// burial gate
const buried = [mk(100, A, 1, 80), mk(400, A, 1, 95)]; // tip 100, depth 10 ⇒ slot95 (depth5) skipped
ok(pickLargest(buried, V, { tipSlot: 100, confirmDepth: 10 }).get(A) === 100n, "burial gate skips the un-buried larger UTxO, credits the buried one");
ok(pickLargest(buried, V, { tipSlot: 100, confirmDepth: 10000 }).size === 0, "nothing buried deep enough ⇒ nothing credited");
ok(pickLargest([mk(400, A, 1, 95)], V, { tipSlot: null, confirmDepth: 10 }).size === 0, "missing tip with depth>0 ⇒ skip (fail closed)");
ok(pickLargest([], V).size === 0, "no matches ⇒ empty");

// gap 1: a zero-lovelace beacon (a swept UTxO that still carries the NFT) must NOT be credited —
// otherwise `0n > -1n` would list the identity as observed with no value, and lockToWeight(0n)==0n
// would silently set zero weight for it. The floor must reject value-less beacons outright.
ok(pickLargest([mk(0, A)], V).size === 0, "zero-coin beacon is NOT credited (no value-less identity)");
ok(pickLargest([mk(0, A), mk(120, A)], V).get(A) === 120n, "a real (positive) UTxO still wins over a zero-coin one for the same beacon");
ok(pickLargest([mk(0, A), mk(0, B)], V).size === 0, "all-zero vault ⇒ nothing credited (not size 2)");

// gap 7/12: the optional `reasons` map records WHY each skipped UTxO was rejected (pure fn, caller logs).
let why = new Map();
pickLargest([mk(0, A), mk(500, B, 2)], V, { reasons: why });
ok(why.size === 2, "reasons map captures both rejected UTxOs (zero-coin + bad qty)");
ok([...why.values()].some((r) => /zero\/negative lovelace/.test(r)), "reasons explains the zero-lovelace skip");
ok([...why.values()].some((r) => /not exactly one beacon/.test(r)), "reasons explains the bad-quantity skip");
why = new Map();
pickLargest([mk(400, A, 1, 95)], V, { tipSlot: 100, confirmDepth: 10000, reasons: why });
ok([...why.values()].some((r) => /burial gate.*too fresh/.test(r)), "reasons explains the burial-gate (too-fresh) skip");

// gap 2/6/7/11: the `reasons` map is keyed per-UTxO and pruned of credited beacons, so (a) a beacon
// CREDITED via a buried UTxO is never ALSO reported as rejected, and (b) two rejected UTxOs for the
// SAME beacon do not overwrite each other.
why = new Map();
pickLargest([mk(100, A, 1, 80), mk(400, A, 1, 95)], V, { tipSlot: 100, confirmDepth: 10, reasons: why });
ok(why.size === 0, "a beacon credited via a buried UTxO is NOT also listed as rejected (no contradictory diagnostics)");
why = new Map();
pickLargest([mk(100, A, 1, 95), mk(200, A, 1, 96)], V, { tipSlot: 100, confirmDepth: 10, reasons: why });
ok(why.size === 2, "two too-fresh UTxOs for the same beacon are both reported (unique per-UTxO keys, no overwrite)");

// gap 9: a wrong/non-matching vaultHash yields an empty map (matching fails, no false credit).
ok(pickLargest([mk(100, A)], "ff".repeat(28)).size === 0, "non-matching vaultHash ⇒ nothing credited (wrong policy is silent-but-empty)");

// ── lockToWeight ─────────────────────────────────────────────────────────────────────────────
console.log("\n[lockToWeight] MIN_LOCK gate");
ok(lockToWeight(100_000_000n) === 100_000_000n, "exactly MIN_LOCK passes");
ok(lockToWeight(250_000_000n) === 250_000_000n, "above MIN_LOCK passes");
ok(lockToWeight(99_999_999n) === 0n, "below MIN_LOCK ⇒ 0");
ok(lockToWeight(0n) === 0n, "zero ⇒ 0");
// gap 10: the minLock parameter is honored, not just the default.
ok(lockToWeight(150n, 200n) === 0n, "custom minLock: below the custom floor ⇒ 0");
ok(lockToWeight(200n, 200n) === 200n, "custom minLock: exactly the custom floor passes");
ok(lockToWeight(250n, 200n) === 250n, "custom minLock: above the custom floor passes verbatim");

// ── viaCommittee (mock api) ──────────────────────────────────────────────────────────────────
console.log("\n[viaCommittee] propose → vote ×k → close (mock api)");
const ev = (section, method, data = []) => ({ event: { section, method, data } });
// a mock tx whose signAndSend drives the REAL send(): emits inBlock then finalized with `events`.
const mockTx = (events) => ({
	method: { toU8a: () => new Uint8Array(8) },
	signAndSend(_signer, cb) {
		queueMicrotask(() => {
			const base = { isInBlock: false, isFinalized: false, isDropped: false, isInvalid: false, isUsurped: false, isFinalityTimeout: false };
			cb({ status: { ...base, isInBlock: true, type: "InBlock" }, events, dispatchError: undefined });
			cb({ status: { ...base, isFinalized: true, type: "Finalized" }, events, dispatchError: undefined });
		});
		return Promise.resolve(() => {});
	},
});
const PROPOSED = ev("followerCommittee", "Proposed", [{}, { toNumber: () => 7 }, { toHex: () => "0xfeedface00" }]);
const mockApi = (closeEvents, { proposeEvents = [PROPOSED] } = {}) => ({
	registry: { findMetaError: () => ({ section: "x", name: "y" }) },
	tx: { followerCommittee: {
		propose: () => mockTx(proposeEvents),
		vote: () => mockTx([]),
		close: () => mockTx(closeEvents),
	} },
});
const inner = { method: { toU8a: () => new Uint8Array(8) } };
const members = [{ address: "a" }, { address: "b" }, { address: "c" }, { address: "d" }, { address: "e" }];
const baseOpts = { members, operators: { committee: members }, threshold: 3 };

const happy = await viaCommittee(mockApi([ev("followerCommittee", "Approved"), ev("followerCommittee", "Executed")]), inner, baseOpts);
ok(happy.proposalIndex === 7 && happy.proposalHash === "0xfeedface00", "3-of-5 motion proposed/closed → index+hash surfaced");

await throws(() => viaCommittee(mockApi([ev("followerCommittee", "Disapproved")]), inner, baseOpts), "close without Approved is rejected");
await throws(() => viaCommittee(mockApi([ev("followerCommittee", "Approved") /* no Executed */]), inner, baseOpts), "Approved but inner not Executed is rejected");

// committee-3: Approved + Executed but the INNER call reverted (Executed carries result=Err at data[1])
// must be rejected — not reported as success. Both a plain Err and a module Err (→ findMetaError) throw.
const errResult = { isErr: true, asErr: { isModule: false, toString: () => "Anchor.NonMonotonicAnchor" } };
await throws(() => viaCommittee(mockApi([ev("followerCommittee", "Approved"), ev("followerCommittee", "Executed", [{}, errResult])]), inner, baseOpts), "Approved+Executed with a reverted inner call (Err result) is rejected");
const moduleErr = { isErr: true, asErr: { isModule: true, asModule: {} } };
await throws(() => viaCommittee(mockApi([ev("followerCommittee", "Approved"), ev("followerCommittee", "Executed", [{}, moduleErr])]), inner, baseOpts), "Approved+Executed with a module Err inner result is rejected (findMetaError path)");
// threshold==1 immediate-execute path also surfaces a reverted inner call.
await throws(() => viaCommittee(mockApi([], { proposeEvents: [ev("followerCommittee", "Executed", [{}, errResult])] }), inner, { ...baseOpts, threshold: 1 }), "threshold==1 reverted inner call (on propose) is rejected");

const imm = await viaCommittee(mockApi([], { proposeEvents: [ev("followerCommittee", "Executed")] }), inner, { ...baseOpts, threshold: 1 });
ok(imm.proposalIndex === null, "threshold==1 executes on propose (no motion)");

// gap 2: a threshold larger than the available members can NEVER reach Approved. With the default
// voters = members.slice(0, threshold), this silently under-votes; the guard must reject up front so
// the operator sees the real cause (committee too small) instead of an unreconcilable "not Approved".
await throws(() => viaCommittee(mockApi([ev("followerCommittee", "Approved"), ev("followerCommittee", "Executed")]), inner, { members, operators: { committee: members }, threshold: 7 }), "threshold > member count is rejected up front (motion can never pass)");
// An explicitly short voters list (fewer ayes than threshold) is rejected the same way.
await throws(() => viaCommittee(mockApi([ev("followerCommittee", "Approved"), ev("followerCommittee", "Executed")]), inner, { ...baseOpts, threshold: 3, voters: members.slice(0, 2) }), "explicit voters list shorter than threshold is rejected");

// gap 8: a malformed Proposed event (empty data) — proposed.data[1].toNumber() must surface a clear
// throw, not be swallowed as a success. (Documents that the driver assumes the runtime event shape.)
await throws(() => viaCommittee(mockApi([ev("followerCommittee", "Approved"), ev("followerCommittee", "Executed")], { proposeEvents: [ev("followerCommittee", "Proposed", [])] }), inner, baseOpts), "malformed Proposed event (empty data) throws, not silently mis-parsed");

// ── send resilience (malformed chain feedback) ──────────────────────────────────────────────────
console.log("\n[send] resilience to malformed registry / events");
// gap 3: a module dispatchError whose findMetaError throws (malformed metadata / bad registry) must
// reject CLEANLY — not let an uncaught exception escape the subscription callback and hang the promise.
const badRegistryApi = { registry: { findMetaError: () => { throw new Error("bad registry"); } } };
const moduleErrTx = { signAndSend(_s, cb) { queueMicrotask(() => cb({ status: { isInBlock: false, isFinalized: false }, events: [], dispatchError: { isModule: true, asModule: {}, toString: () => "Module(…)" } })); return Promise.resolve(() => {}); } };
await throws(() => send(badRegistryApi, moduleErrTx, members[0], "bad-registry", {}), "send rejects cleanly when registry.findMetaError throws (no uncaught/hang)");

// gap 4: a malformed events array (an entry with no `.event` field) must reject with context at
// resolve time — not throw an uncaught destructure error out of the callback (leaving the promise hung).
const malformedEventsTx = { signAndSend(_s, cb) { queueMicrotask(() => cb({ status: { isInBlock: true, type: "InBlock", isFinalized: false, isDropped: false, isInvalid: false, isUsurped: false, isFinalityTimeout: false }, events: [null], dispatchError: undefined })); return Promise.resolve(() => {}); } };
await throws(() => send(mockApi([]), malformedEventsTx, members[0], "malformed-events", {}), "send rejects (not throws) on a malformed events array (null entry)");

// send happy path still resolves the mapped events (guards the gap-4 try/catch didn't break success).
const goodEventsTx = mockTx([ev("x", "Y", [1])]);
const sentEvs = await send(mockApi([]), goodEventsTx, members[0], "good", { finalize: true });
ok(sentEvs.length === 1 && sentEvs[0].section === "x" && sentEvs[0].method === "Y", "send still maps events on the happy path (try/catch wrap is transparent)");

// gap 5: the optional debug log fires on status transitions (inBlock / finalized) and is off by default.
const logs = [];
await send(mockApi([]), mockTx([]), members[0], "logged", { finalize: true, log: (m) => logs.push(m) });
ok(logs.some((l) => /inBlock/.test(l)) && logs.some((l) => /finalized/.test(l)), "send logs inBlock + finalized transitions when a log is injected");

// gap 6: viaCommittee logs a per-vote line (which voter i/n) so a failed vote is attributable.
const vlogs = [];
await viaCommittee(mockApi([ev("followerCommittee", "Approved"), ev("followerCommittee", "Executed")]), inner, { ...baseOpts, log: (m) => vlogs.push(m) });
ok(vlogs.filter((l) => /vote \d\/\d on motion #7/.test(l)).length === 3, "viaCommittee logs each of the 3 votes with voter index + motion #");

// ── viaSudo (the EnsureRoot dev fallback) ───────────────────────────────────────────────────────
console.log("\n[viaSudo] EnsureRoot dev fallback surfaces Sudid + reverted inner");
const sudoApi = (sudidEvents) => ({
	registry: { findMetaError: () => ({ section: "x", name: "y" }) },
	tx: { sudo: { sudo: () => mockTx(sudidEvents) } },
});
const sudoKey = { address: "Alice" };
const sudoRes = await viaSudo(sudoApi([ev("sudo", "Sudid", [{ isErr: false }])]), inner, { sudo: sudoKey, operators: { committee: members } });
ok(sudoRes.via === "sudo" && sudoRes.evs.some((e) => e.section === "sudo" && e.method === "Sudid"), "viaSudo returns the Sudid events with via=sudo");
// a missing Sudid event is rejected (the privileged call did not dispatch as expected).
await throws(() => viaSudo(sudoApi([ev("system", "ExtrinsicSuccess")]), inner, { sudo: sudoKey, operators: { committee: members } }), "viaSudo with no Sudid event is rejected");
// committee-3: a reverted inner call under sudo (Sudid result=Err at data[0]) is surfaced, not success.
await throws(() => viaSudo(sudoApi([ev("sudo", "Sudid", [errResult])]), inner, { sudo: sudoKey, operators: { committee: members } }), "viaSudo with a reverted inner call (Err result) is rejected");

// ── send terminal-state rejection ─────────────────────────────────────────────────────────────
console.log("\n[send] terminal non-inclusion status rejects (so finalize-mode can't hang)");
const droppedTx = { signAndSend(_s, cb) { queueMicrotask(() => cb({ status: { isDropped: true, type: "Dropped" }, events: [], dispatchError: undefined })); return Promise.resolve(() => {}); } };
await throws(() => send(mockApi([]), droppedTx, members[0], "drop-test", { finalize: true }), "a Dropped tx rejects instead of hanging");

// ── resolveCommittee (Phase 3: threshold from on-chain membership + seed reconciliation) ──────────
console.log("\n[resolveCommittee] threshold = ceil(n*3/5) from on-chain members + reconciliation");
const qApi = (memberAddrs) => ({ query: { followerCommittee: { members: async () => memberAddrs.map((a) => ({ toString: () => a })) } } });
const opsOf = (addrs) => ({ committee: addrs.map((a) => ({ address: a })) });
{
	const r5 = await resolveCommittee(qApi(["a", "b", "c", "d", "e"]), opsOf(["a", "b", "c", "d", "e"]));
	ok(r5.threshold === 3 && r5.onchainCount === 5 && r5.members.length === 5, "5 on-chain members → threshold 3 (ceil(15/5))");
	const r7 = await resolveCommittee(qApi(["a", "b", "c", "d", "e", "f", "g"]), opsOf(["a", "b", "c", "d", "e", "f", "g"]));
	ok(r7.threshold === 5, "7 members → threshold 5 (ceil(21/5)=5) — the hardcoded-3 bug case");
	const r6 = await resolveCommittee(qApi(["a", "b", "c", "d", "e", "f"]), opsOf(["a", "b", "c", "d", "e", "f"]));
	ok(r6.threshold === 4, "6 members → threshold 4 (ceil(18/5)=4)");
	const rExp = await resolveCommittee(qApi(["a", "b", "c", "d", "e"]), opsOf(["a", "b", "c", "d", "e"]), { explicitThreshold: 4 });
	ok(rExp.threshold === 4, "explicitThreshold overrides the computed value");
	// only the eligible (on-chain) local seats are returned
	const rPartial = await resolveCommittee(qApi(["a", "b", "c", "d", "e"]), opsOf(["a", "b", "c", "x", "y"]));
	ok(rPartial.members.length === 3 && rPartial.members.every((m) => ["a", "b", "c"].includes(m.address)), "only local seats that are on-chain members are eligible");
	// drift: too few local seats are on-chain members to reach the threshold → fail loudly
	await throws(() => resolveCommittee(qApi(["x", "y", "z", "p", "q"]), opsOf(["a", "b", "c", "d", "e"])), "local seeds not matching on-chain members → throws (mismatch)");
	await throws(() => resolveCommittee(qApi([]), opsOf(["a", "b", "c"])), "no on-chain members → throws");
	// explicit --threshold BELOW the 3/5 minimum would close Approved then BadOrigin — reject up front
	await throws(() => resolveCommittee(qApi(["a", "b", "c", "d", "e", "f", "g"]), opsOf(["a", "b", "c", "d", "e", "f", "g"]), { explicitThreshold: 3 }), "explicit --threshold 3 below the 3/5 min (7 seats → 5) → throws");
	await throws(() => resolveCommittee(qApi(["a", "b", "c", "d", "e"]), opsOf(["a", "b", "c", "d", "e"]), { explicitThreshold: 0 }), "--threshold 0 → throws (not silently dropped to the auto value)");
}

// (Removed the `link-identity.mjs parseArgs` test: the trusted committee-routed identity-bind driver was
// deleted for D1 — identity binding is now the permissionless on-chain `cognoGate.link_identity_signed`
// self-proof, not a committee/sudo op. The committee still routes set_stake / anchor_ack / validators.)

// ── assertRealKeys / assertGenesis (Phase 3: fail-closed config + chain pin) ──────────────────────
console.log("\n[assertRealKeys] refuses public dev keys under COGNO_PROFILE=prod");
{
	const savedProfile = process.env.COGNO_PROFILE;
	delete process.env.COGNO_PROFILE;
	let threw = false; try { assertRealKeys("committee"); } catch { threw = true; }
	ok(!threw, "no COGNO_PROFILE → no-op (dev/default is allowed)");
	process.env.COGNO_PROFILE = "prod";
	// In this test process COMMITTEE_SEEDS/SUDO_SEED are unset, so the module defaults are the dev keys.
	let threwC = false; try { assertRealKeys("committee"); } catch { threwC = true; }
	ok(threwC, "COGNO_PROFILE=prod + default dev COMMITTEE_SEEDS → throws");
	let threwS = false; try { assertRealKeys("sudo"); } catch { threwS = true; }
	ok(threwS, "COGNO_PROFILE=prod + default dev SUDO_SEED (//Alice) → throws");
	if (savedProfile === undefined) delete process.env.COGNO_PROFILE; else process.env.COGNO_PROFILE = savedProfile;
}

console.log("\n[assertGenesis] pins the chain when GENESIS is set");
{
	const savedGenesis = process.env.GENESIS;
	const api = { genesisHash: { toHex: () => "0xABCD1234ef" } };
	delete process.env.GENESIS;
	let threw = false; try { assertGenesis(api); } catch { threw = true; }
	ok(!threw, "GENESIS unset → no-op");
	process.env.GENESIS = "0xabcd1234ef"; // case-insensitive match
	threw = false; try { assertGenesis(api); } catch { threw = true; }
	ok(!threw, "GENESIS matches (case-insensitive, 0x-tolerant) → no-op");
	process.env.GENESIS = "deadbeef00";
	threw = false; try { assertGenesis(api); } catch { threw = true; }
	ok(threw, "GENESIS mismatch → throws (wrong chain refused)");
	if (savedGenesis === undefined) delete process.env.GENESIS; else process.env.GENESIS = savedGenesis;
}

console.log(`\n== committee drivers: ${PASS} passed, ${FAIL} failed ==\n`);
process.exit(FAIL === 0 ? 0 : 1);
