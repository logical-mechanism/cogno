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
import { viaCommittee, send } from "./lib.mjs";

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

// ── pickLargest ──────────────────────────────────────────────────────────────────────────────
console.log("\n[pickLargest] anti-Sybil vault filter + burial gate");
const V = "ab".repeat(28);            // 56-hex policy id
const A = "11".repeat(32), B = "22".repeat(32); // 64-hex beacon names
const mk = (coins, name, qty = 1, slot = 0, extra = {}) => ({
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

// ── lockToWeight ─────────────────────────────────────────────────────────────────────────────
console.log("\n[lockToWeight] MIN_LOCK gate");
ok(lockToWeight(100_000_000n) === 100_000_000n, "exactly MIN_LOCK passes");
ok(lockToWeight(250_000_000n) === 250_000_000n, "above MIN_LOCK passes");
ok(lockToWeight(99_999_999n) === 0n, "below MIN_LOCK ⇒ 0");
ok(lockToWeight(0n) === 0n, "zero ⇒ 0");

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

// ── send terminal-state rejection ─────────────────────────────────────────────────────────────
console.log("\n[send] terminal non-inclusion status rejects (so finalize-mode can't hang)");
const droppedTx = { signAndSend(_s, cb) { queueMicrotask(() => cb({ status: { isDropped: true, type: "Dropped" }, events: [], dispatchError: undefined })); return Promise.resolve(() => {}); } };
await throws(() => send(mockApi([]), droppedTx, members[0], "drop-test", { finalize: true }), "a Dropped tx rejects instead of hanging");

console.log(`\n== committee drivers: ${PASS} passed, ${FAIL} failed ==\n`);
process.exit(FAIL === 0 ? 0 : 1);
