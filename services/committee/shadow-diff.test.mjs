// Unit tests for the shadow-diff pure logic (shadow-diff.mjs computeShadowDiff).
// No framework, no live stack:  node services/committee/shadow-diff.test.mjs
// Style mirrors observation.test.mjs / committee.test.mjs: ok(), final "== N passed, M failed ==".
import { computeShadowDiff } from "./shadow-diff.mjs";
import { isMain } from "../_shared/cli.mjs";

let PASS = 0, FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log(`  ✓ ${m}`); } else { FAIL++; console.log(`  ✗ FAIL: ${m}`); } };
const m = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, BigInt(v)]));

const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

// 1. Perfect agreement — inherent == committee for every account.
{
	const d = computeShadowDiff({ inherent: m({ [ALICE]: 100_000_000 }), committee: m({ [ALICE]: 100_000_000 }) });
	ok(d.summary.accounts === 1 && d.summary.agreeCommittee === 1 && d.summary.disagreeCommittee === 0, "agreeing weights ⇒ 0 disagreements");
	ok(d.rows[0].agreeCommittee === true && d.rows[0].recompute === null, "row marks committee-agree; no recompute leg when absent");
}

// 2. Disagreement — committee wrote a weight the inherent has not (yet) projected (lock not synced).
{
	const d = computeShadowDiff({ inherent: m({}), committee: m({ [ALICE]: 100_000_000 }) });
	ok(d.summary.disagreeCommittee === 1 && d.rows[0].inherent === 0n && d.rows[0].committee === 100_000_000n, "committee-only account (default inherent 0) ⇒ disagreement");
}

// 3. Unlock-clamp transient — inherent zeroed an account (unlock) the committee has not synced yet.
{
	const d = computeShadowDiff({ inherent: m({ [ALICE]: 0 }), committee: m({ [ALICE]: 100_000_000 }) });
	ok(d.summary.disagreeCommittee === 1, "inherent=0 vs committee=100M (unlock not synced) ⇒ disagreement (expected transient)");
}

// 4. Absent on both sides defaults to 0n and agrees (no phantom accounts).
{
	const d = computeShadowDiff({ inherent: m({ [ALICE]: 100_000_000 }), committee: m({ [ALICE]: 100_000_000, [BOB]: 0 }) });
	// BOB: inherent absent (0) vs committee 0 ⇒ agree.
	const bob = d.rows.find((r) => r.account === BOB);
	ok(bob && bob.agreeCommittee === true && bob.inherent === 0n, "0-vs-absent agrees (ValueQuery default semantics)");
}

// 5. Recompute leg — the CORRECTNESS oracle. Inherent matches the independent recompute ⇒ checked, agree.
{
	const d = computeShadowDiff({
		inherent: m({ [ALICE]: 100_000_000 }),
		committee: m({ [ALICE]: 100_000_000 }),
		recompute: m({ [ALICE]: 100_000_000 }),
	});
	ok(d.summary.recomputeChecked === 1 && d.summary.recomputeDisagree === 0, "inherent == independent recompute ⇒ checked, 0 disagree");
	ok(d.rows[0].agreeRecompute === true, "row records recompute agreement");
}

// 6. Recompute disagreement — a REAL inherent defect (runtime computed != deterministic library).
{
	const d = computeShadowDiff({
		inherent: m({ [ALICE]: 250_000_000 }),
		committee: m({ [ALICE]: 250_000_000 }),
		recompute: m({ [ALICE]: 100_000_000 }),
	});
	ok(d.summary.recomputeDisagree === 1, "inherent != recompute ⇒ a recompute disagreement (correctness defect)");
	ok(d.rows[0].agreeCommittee === true && d.rows[0].agreeRecompute === false, "can agree with committee yet DISAGREE with the recompute oracle");
}

// 7. Committee-only account is NOT counted as a recompute miss (a dev grant with no on-chain vault).
{
	const d = computeShadowDiff({
		inherent: m({}),
		committee: m({ [BOB]: 42_000_000 }), // dev --account/--weight grant, no vault
		recompute: m({}),
	});
	ok(d.summary.recomputeChecked === 0 && d.summary.recomputeDisagree === 0, "committee-only account is not a recompute miss");
	ok(d.rows[0].agreeRecompute === null, "its recompute verdict is null (not applicable)");
}

// 8. Deterministic row ordering (sorted by account) regardless of insertion order.
{
	const d = computeShadowDiff({ inherent: m({ [BOB]: 1, [ALICE]: 1 }), committee: m({ [ALICE]: 1, [BOB]: 1 }) });
	ok(d.rows[0].account < d.rows[1].account, "rows sorted ascending by account (stable output)");
}

console.log(`\n== shadow-diff: ${PASS} passed, ${FAIL} failed ==`);
if (isMain(import.meta.url) && FAIL > 0) process.exit(1);
