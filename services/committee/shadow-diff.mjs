// Shadow-diff validator for the in-protocol-observation D4 weight rung (step 4b). Proves the
// inherent-derived weight AGREES with the trusted committee `set_stake` weight on real preprod data,
// BEFORE any cutover — the "run it in shadow and watch it converge" half of docs/IN-PROTOCOL-OBSERVATION.md
// §9. Reuses the prod-readiness Phase-2 observability layer (services/_shared/metrics.mjs).
//
// Two comparisons, deliberately distinct in strength:
//   • CONVERGENCE (committee-vs-inherent): on-chain `cardanoObserver.shadowStake` (what the verified
//     inherent WOULD/DOES apply) vs `talkStake.allowedStake` (what the committee actually wrote). The two
//     writers are ASYNCHRONOUS (the committee sync lags the every-block inherent; the unlock clamp lags
//     the full stability window), so a momentary disagreement is EXPECTED at every lock/unlock — this is
//     an eventual-consistency signal, NOT a correctness oracle. We alert only on PERSISTENT disagreement.
//   • CORRECTNESS (recompute-vs-inherent, when KUPO is set): re-derive the observation INDEPENDENTLY
//     off-chain (observeAsOf over this operator's own Kupo at the inherent's own reference slot) and
//     compare it to the on-chain projection. A disagreement here is a REAL inherent defect (the runtime
//     computed something the deterministic library does not), not a timing transient.
//
//   WS=ws://127.0.0.1:9944 node shadow-diff.mjs                       # one-shot JSON (committee leg)
//   WS=… KUPO=http://127.0.0.1:1442 node shadow-diff.mjs              # + the independent recompute leg
//   WS=… KUPO=… METRICS_PORT=9102 node shadow-diff.mjs --serve        # Prometheus /metrics + /healthz
//
// ⚠ HONESTY (§2): committee-vs-inherent AGREEMENT is a convergence signal, not proof the inherent is
// trustless — on a single producer there is no independent verifier (D4-SHAPED, not D4-TRUST).
import { isMain } from "../_shared/cli.mjs";
import { connect, fetchJson } from "./lib.mjs";
import { observeAsOf, lockToWeight } from "../_shared/observation.mjs";
import { renderPrometheus, startMetricsServer } from "../_shared/metrics.mjs";

const WS = process.env.WS || "ws://127.0.0.1:9944";
const KUPO = process.env.KUPO || null; // optional: enables the independent off-chain recompute leg
const METRICS_PORT = Number(process.env.METRICS_PORT || "9102");

// PURE: 3-way per-account diff. Inputs are Map<ss58, bigint>; `recompute` is null when KUPO is unset.
// Absent keys default to 0n (matches AllowedStake/ShadowStake ValueQuery semantics). The recompute leg is
// only meaningful for accounts the recompute could actually place (present in the recompute OR in the
// inherent) — a committee-only account (e.g. a dev `--account/--weight` grant with no on-chain vault) is
// NOT counted as a recompute miss. Returns deterministically-sorted rows + a summary of agree/disagree.
export function computeShadowDiff({ inherent, committee, recompute = null }) {
	const accounts = new Set([
		...inherent.keys(),
		...committee.keys(),
		...(recompute ? recompute.keys() : []),
	]);
	const rows = [];
	let agreeCommittee = 0;
	let disagreeCommittee = 0;
	let recomputeChecked = 0;
	let recomputeDisagree = 0;
	for (const account of accounts) {
		const inh = inherent.get(account) ?? 0n;
		const com = committee.get(account) ?? 0n;
		const okCommittee = inh === com;
		if (okCommittee) agreeCommittee++;
		else disagreeCommittee++;
		let rec = null;
		let okRecompute = null;
		if (recompute && (recompute.has(account) || inherent.has(account))) {
			rec = recompute.get(account) ?? 0n;
			okRecompute = inh === rec;
			recomputeChecked++;
			if (!okRecompute) recomputeDisagree++;
		}
		rows.push({ account, inherent: inh, committee: com, recompute: rec, agreeCommittee: okCommittee, agreeRecompute: okRecompute });
	}
	rows.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
	return { rows, summary: { accounts: accounts.size, agreeCommittee, disagreeCommittee, recomputeChecked, recomputeDisagree } };
}

// Read the inherent's per-account projection (cardanoObserver.ShadowStake) → Map<ss58, bigint>.
async function readInherentProjection(api) {
	const m = new Map();
	for (const [key, val] of await api.query.cardanoObserver.shadowStake.entries())
		m.set(key.args[0].toString(), val.toBigInt());
	return m;
}

// Read the committee-written weight (talkStake.AllowedStake) → Map<ss58, bigint>.
async function readCommitteeWeight(api) {
	const m = new Map();
	for (const [key, val] of await api.query.talkStake.allowedStake.entries())
		m.set(key.args[0].toString(), val.toBigInt());
	return m;
}

// Independently re-derive the observation off-chain at the inherent's OWN reference slot, resolve beacons
// to accounts on-chain, and apply the MIN_LOCK floor — the correctness leg. Returns null if KUPO unset or
// there is no observation yet; throws on a Kupo read failure (the serve loop catches + degrades).
async function readIndependentRecompute(api, kupo) {
	if (!kupo) return null;
	const lastRef = await api.query.cardanoObserver.lastReference();
	if (lastRef.isNone) return new Map();
	const refSlot = lastRef.unwrap().slot.toBigInt();
	const vaultHex = api.consts.cardanoObserver.vaultPolicyId.toHex().replace(/^0x/, "");
	const url = `${kupo}/matches/${vaultHex}.*?created_before=${refSlot + 1n}`;
	const matches = await fetchJson(url);
	if (!Array.isArray(matches)) throw new Error(`Kupo /matches did not return an array for ${vaultHex}`);
	const largest = observeAsOf(matches, { vaultHash: vaultHex, referenceSlot: refSlot });
	const m = new Map();
	for (const [beacon, lovelace] of largest) {
		const acc = await api.query.cognoGate.accountOf("0x" + beacon);
		if (acc.isNone) continue; // unbound ⇒ the inherent skips it too
		m.set(acc.unwrap().toString(), lockToWeight(lovelace));
	}
	return m;
}

// Read everything once and produce the diff + the chain context (mode + reference slot).
async function snapshot(api, kupo) {
	const [inherent, committee, enforced, lastRef] = await Promise.all([
		readInherentProjection(api),
		readCommitteeWeight(api),
		api.query.cardanoObserver.enforceWeight(),
		api.query.cardanoObserver.lastReference(),
	]);
	let recompute = null;
	let recomputeError = null;
	try {
		recompute = await readIndependentRecompute(api, kupo);
	} catch (e) {
		recomputeError = String(e?.message || e); // degrade: keep the committee leg, drop the recompute leg
	}
	const diff = computeShadowDiff({ inherent, committee, recompute });
	return {
		enforced: enforced.isTrue ?? enforced.valueOf(),
		referenceSlot: lastRef.isNone ? null : Number(lastRef.unwrap().slot.toBigInt()),
		recomputeError,
		...diff,
	};
}

// JSON-safe (BigInt → string).
const jsonReplacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

async function oneShot(api) {
	const s = await snapshot(api, KUPO);
	const { accounts, agreeCommittee, disagreeCommittee, recomputeChecked, recomputeDisagree } = s.summary;
	console.log(`mode=${s.enforced ? "ENFORCE" : "shadow"} ref_slot=${s.referenceSlot ?? "—"} | committee: ${agreeCommittee}/${accounts} agree, ${disagreeCommittee} disagree` +
		(KUPO ? ` | recompute: ${recomputeChecked - recomputeDisagree}/${recomputeChecked} agree, ${recomputeDisagree} disagree` : " | recompute: (KUPO unset)") +
		(s.recomputeError ? `\n  ⚠ recompute leg skipped: ${s.recomputeError}` : ""));
	console.log(JSON.stringify(s, jsonReplacer, 2));
	// Exit 3 ONLY on a recompute disagreement (a real inherent defect). Committee disagreement is an
	// expected transient (async writers) and must NOT fail a scripted check.
	return recomputeDisagree > 0 ? 3 : 0;
}

// Long-running mode: recompute on each finalized head, track per-account committee-divergence STREAKS
// (so the alert fires only on PERSISTENT disagreement, not lock/unlock transients), serve /metrics.
async function serve(api) {
	const metrics = { enforced: null, referenceSlot: null, accounts: 0, agree: 0, disagree: 0, maxDisagreeBlocks: 0, recomputeChecked: 0, recomputeDisagree: 0, recomputeError: null, lastUpdateAt: 0, rows: [] };
	const divergedSince = new Map(); // account → finalized-block height where committee divergence began

	const metricsText = () => renderPrometheus([
		{ name: "cogno_shadow_up", help: "1 while the shadow-diff is running", value: 1 },
		{ name: "cogno_shadow_enforced", help: "1 if the observer applies weight (enforce/cutover), 0 if shadow", value: metrics.enforced == null ? null : metrics.enforced ? 1 : 0 },
		{ name: "cogno_shadow_reference_slot", help: "Cardano reference slot of the last on-chain observation", value: metrics.referenceSlot },
		{ name: "cogno_shadow_accounts_total", help: "Distinct accounts across the inherent projection + committee weight", value: metrics.accounts },
		{ name: "cogno_shadow_accounts_agree", help: "Accounts where the inherent projection == committee weight", value: metrics.agree },
		{ name: "cogno_shadow_accounts_disagree", help: "Accounts where inherent != committee (convergence signal; transient at lock/unlock)", value: metrics.disagree },
		{ name: "cogno_shadow_max_disagree_blocks", help: "Longest current committee-vs-inherent divergence streak in finalized blocks — powers the PERSISTENT-disagreement alert (transients clear quickly)", value: metrics.maxDisagreeBlocks },
		{ name: "cogno_shadow_recompute_checked", help: "Accounts cross-checked against an independent off-chain Kupo recompute (0 if KUPO unset)", value: metrics.recomputeChecked },
		{ name: "cogno_shadow_recompute_disagree", help: "Accounts where the on-chain inherent projection != an INDEPENDENT Kupo recompute at the same reference — a REAL inherent-correctness defect, not a timing transient", value: metrics.recomputeDisagree },
		{ name: "cogno_shadow_recompute_ok", help: "1 if the independent recompute leg ran cleanly this cycle, 0 if it errored (e.g. Kupo blip), absent if KUPO unset", value: KUPO ? (metrics.recomputeError ? 0 : 1) : null },
		{ name: "cogno_shadow_last_update_seconds", help: "Seconds since the diff was last recomputed (liveness)", value: metrics.lastUpdateAt ? (Date.now() - metrics.lastUpdateAt) / 1000 : -1 },
		...metrics.rows.flatMap((r) => [
			{ name: "cogno_shadow_inherent_weight", help: "Inherent-projected weight per account (lovelace)", labels: { account: r.account }, value: r.inherent },
			{ name: "cogno_shadow_committee_weight", help: "Committee-written weight per account (lovelace)", labels: { account: r.account }, value: r.committee },
		]),
	]);
	const healthz = () => ({ code: 200, contentType: "application/json", body: JSON.stringify({ ok: true, mode: metrics.enforced ? "enforce" : "shadow", referenceSlot: metrics.referenceSlot, accounts: metrics.accounts, disagree: metrics.disagree, maxDisagreeBlocks: metrics.maxDisagreeBlocks, recomputeDisagree: metrics.recomputeDisagree }) + "\n" });

	if (METRICS_PORT > 0) startMetricsServer({ port: METRICS_PORT, routes: { "/metrics": () => ({ contentType: "text/plain; version=0.0.4", body: metricsText() }), "/healthz": healthz } });

	const update = async (height) => {
		const s = await snapshot(api, KUPO);
		Object.assign(metrics, { enforced: s.enforced, referenceSlot: s.referenceSlot, accounts: s.summary.accounts, agree: s.summary.agreeCommittee, disagree: s.summary.disagreeCommittee, recomputeChecked: s.summary.recomputeChecked, recomputeDisagree: s.summary.recomputeDisagree, recomputeError: s.recomputeError, lastUpdateAt: Date.now(), rows: s.rows });
		// Streak tracking: a row that disagrees on the committee leg starts/continues a streak; agreement clears it.
		const disagreeing = new Set(s.rows.filter((r) => !r.agreeCommittee).map((r) => r.account));
		for (const acc of disagreeing) if (!divergedSince.has(acc)) divergedSince.set(acc, height);
		for (const acc of [...divergedSince.keys()]) if (!disagreeing.has(acc)) divergedSince.delete(acc);
		metrics.maxDisagreeBlocks = divergedSince.size ? Math.max(...[...divergedSince.values()].map((h) => height - h)) : 0;
		const recPart = KUPO ? (s.recomputeError ? ` recompute=ERR(${s.recomputeError})` : ` recompute_disagree=${s.summary.recomputeDisagree}`) : "";
		console.log(`#${height} mode=${s.enforced ? "ENFORCE" : "shadow"} ref=${s.referenceSlot ?? "—"} committee_disagree=${s.summary.disagreeCommittee} max_streak=${metrics.maxDisagreeBlocks}b${recPart}`);
	};

	let stopping = false;
	const stop = (sig) => { if (!stopping) { stopping = true; console.log(`\n${sig} — stopping shadow-diff.`); api.disconnect().finally(() => process.exit(0)); } };
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));

	const unsub = await api.rpc.chain.subscribeFinalizedHeads(async (header) => {
		try { await update(header.number.toNumber()); }
		catch (e) { console.error(`  ⚠ shadow-diff update failed: ${e?.message || e}`); }
	});
	console.log(`shadow-diff serving on :${METRICS_PORT} (committee${KUPO ? " + recompute" : ""} leg) — watching finalized heads`);
	void unsub;
}

async function main() {
	const isServe = process.argv.slice(2).includes("--serve");
	const api = await connect(WS);
	const spec = api.runtimeVersion.specVersion.toNumber();
	if (!api.query.cardanoObserver?.shadowStake)
		throw new Error(`this chain (spec ${spec}) has no cardanoObserver.shadowStake — needs spec >= 108 (the shadow flag)`);
	if (isServe) return serve(api); // long-running; never disconnects until a signal
	const code = await oneShot(api);
	await api.disconnect();
	process.exit(code);
}

if (isMain(import.meta.url)) main().catch((e) => { console.error("SHADOW-DIFF FAILED:", e?.message || e); process.exit(1); });
