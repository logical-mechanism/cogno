// M6 Track 2 live acceptance — drive the off-chain services' privileged calls through the 3-of-5
// FollowerCommittee instead of sudo (DR-07 D2-shaped). Run against a fresh `--dev` node (spec 106).
//
// Proves, with NO sudo call on the privileged path:
//   (A) the FOLLOWER's write — `talk_stake::set_stake` — executed by a 3-of-5 committee motion
//       (propose → 3 votes → close → StakeSet), authorized by EnsureProportionAtLeast<3,5>.
//   (B) the RELAYER's write — `anchor::anchor_ack` — executed the same way (AnchorAcked).
//   (C) committee-gated VALIDATOR management — `validator_set::add_validator` / `remove_validator`
//       (the M6 AddRemoveOrigin == the same committee), proving the consensus-membership crown
//       jewel is also off single-key sudo.
//
// ⚠ HONESTY LABEL (DR-07): on this single-operator stack one operator holds all 5 keys, so this is
// D2-SHAPED, not D2-TRUST — it exercises the exact mechanism + on-chain origin of real D2, but the
// five independent custody domains are not yet real. See docs/D2-custody-runbook.md.
//
// Usage:  WS=ws://127.0.0.1:9944 node m6-track2.mjs
import { connect, viaCommittee, viaSudo, has, find, operators } from "./lib.mjs";

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { throw new Error(`TRACK-2 FAIL: ${m}`); };

async function main() {
	const api = await connect();
	const ops = operators();
	const grace = ops.map.Grace;
	const dave = ops.map.Dave;

	const spec = api.runtimeVersion.specVersion.toNumber();
	console.log(`genesis: ${api.genesisHash.toHex()} | spec: ${spec}`);
	if (spec !== 106) fail(`spec_version ${spec} != 106`);
	const members = await api.query.followerCommittee.members();
	if (members.length !== 5) fail(`FollowerCommittee seated ${members.length} != 5`);
	ok(`spec 106 · FollowerCommittee seated 5 members (3-of-5 k-of-t live)`);
	console.log("  ⚠ single-operator stack: D2-SHAPED, not D2-TRUST (one operator holds all 5 keys)\n");

	// ── (A) the follower's set_stake via the committee (no sudo) ─────────────────────────────────
	const W = 42_000_000n;
	const before = (await api.query.talkStake.allowedStake(grace.address)).toBigInt();
	if (before !== 0n) fail(`//Grace pre-state weight ${before} != 0 (must be untouched)`);
	console.log("[A] FOLLOWER action: talk_stake.set_stake(//Grace, 42M) via 3-of-5 committee");
	const a = await viaCommittee(api, api.tx.talkStake.setStake(grace.address, W), { operators: ops, log: (m) => console.log("    " + m) });
	if (!has(a.evs, "talkStake", "StakeSet")) fail("set_stake did NOT execute via the committee origin");
	const after = (await api.query.talkStake.allowedStake(grace.address)).toBigInt();
	if (after !== W) fail(`committee set_stake failed: AllowedStake(//Grace)=${after} != ${W}`);
	ok(`StakeSet via EnsureProportionAtLeast<3,5> — AllowedStake(//Grace) == ${W} set by the COMMITTEE, not sudo`);

	// ── (B) the relayer's anchor_ack via the committee (no sudo) ─────────────────────────────────
	console.log("\n[B] RELAYER action: anchor.anchor_ack(block=1, root, txhash, count, ts) via 3-of-5 committee");
	const root = "0x" + "ab".repeat(32);
	const txh = "0x" + "cd".repeat(32);
	const b = await viaCommittee(
		api,
		api.tx.anchor.anchorAck(1, root, txh, 7, 0),
		{ operators: ops, log: (m) => console.log("    " + m) },
	);
	if (!has(b.evs, "anchor", "AnchorAcked")) fail("anchor_ack did NOT execute via the committee origin");
	const cp = await api.query.anchor.lastCheckpoint();
	if (cp.isNone || cp.unwrap().blockNumber.toNumber() !== 1) fail("LastCheckpoint not recorded by the committee");
	ok(`AnchorAcked via the committee — LastCheckpoint recorded at block #1 (relayer path, no sudo)`);

	// ── (C) committee-gated validator management (the M6 consensus-membership crown jewel) ───────
	console.log("\n[C] VALIDATOR mgmt: validator_set.add_validator(//Dave) then remove_validator via committee");
	const c1 = await viaCommittee(api, api.tx.validatorSet.addValidator(dave.address), { operators: ops, log: (m) => console.log("    " + m) });
	if (!has(c1.evs, "validatorSet", "ValidatorAdditionInitiated")) fail("add_validator did NOT execute via the committee");
	let vals = (await api.query.validatorSet.validators()).map((v) => v.toString());
	if (!vals.includes(dave.address)) fail("Dave not in the pending validator set after committee add");
	ok(`add_validator(//Dave) via committee → ValidatorAdditionInitiated; pending set now includes //Dave`);
	const c2 = await viaCommittee(api, api.tx.validatorSet.removeValidator(dave.address), { operators: ops, log: (m) => console.log("    " + m) });
	if (!has(c2.evs, "validatorSet", "ValidatorRemovalInitiated")) fail("remove_validator did NOT execute via the committee");
	vals = (await api.query.validatorSet.validators()).map((v) => v.toString());
	if (vals.includes(dave.address)) fail("Dave still in the pending set after committee remove");
	ok(`remove_validator(//Dave) via committee → ValidatorRemovalInitiated; pending set restored`);

	console.log("\nTRACK 2 PASSED — the follower (set_stake), the relayer (anchor_ack), AND validator management all driven end-to-end through the 3-of-5 FollowerCommittee. Sudo was NOT used on any privileged path (D2-shaped, single-operator).");
	await api.disconnect();
	process.exit(0);
}
main().catch((e) => { console.error("\n" + (e.stack || e)); process.exit(1); });
