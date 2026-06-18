// M6 (DR-07 / DR-26) — reusable operator tooling: drive a privileged call through the 3-of-5
// FollowerCommittee (propose → vote ×k → close) OR through sudo (EnsureRoot, the v1 dev fallback).
//
// This is the committee-driven equivalent of the M2/M3 sudo drivers (grant / sync-weight /
// anchor_ack). It uses @polkadot/api dynamic metadata (no PAPI codegen), so it auto-exposes the
// `followerCommittee` / `validatorSet` pallets at spec 106 — the same dep + technique as the M5
// acceptance and the indexer's verify scripts.
//
// ⚠ HONESTY LABEL (DR-07): on the single-operator preprod/dev stack ONE operator holds all five
// committee keys, so the committee path here is **D2-SHAPED, not D2-TRUST** — it exercises the exact
// propose/vote/close mechanism and on-chain origin (`EnsureProportionAtLeast<3,5>`) that real D2
// uses, but the five "independent custody domains" of DR-07 are not yet real. See
// docs/D2-custody-runbook.md for what closing that gap requires.
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";

export const WS_DEFAULT = process.env.WS || "ws://127.0.0.1:9944";

// Hardened JSON fetch (committee-1) — shared with the relayer in services/_shared/net.mjs (themes 3/4).
export { fetchJson } from "../_shared/net.mjs";

/// The five well-known dev committee seats (DR-26 3-of-5), plus a couple of extras for targets.
export const COMMITTEE_URIS = ["//Alice", "//Bob", "//Charlie", "//Dave", "//Eve"];

export async function connect(ws = WS_DEFAULT) {
	await cryptoWaitReady();
	return ApiPromise.create({ provider: new WsProvider(ws) });
}

/// A keyring with the committee seats + common extras, keyed by `//Name`.
export function operators(extra = ["//Ferdie", "//Grace"]) {
	const kr = new Keyring({ type: "sr25519", ss58Format: 42 });
	const map = {};
	for (const uri of [...COMMITTEE_URIS, ...extra]) {
		map[uri.replace(/^\/\//, "")] = kr.addFromUri(uri);
	}
	return { kr, map, committee: COMMITTEE_URIS.map((u) => map[u.replace(/^\/\//, "")]) };
}

/// Send a tx; resolve with the decoded events at inBlock (or at finalization with `{finalize:true}`,
/// for a privileged write whose effect must survive a re-org — committee-2). Rejects on
/// dispatchError, a terminal non-inclusion status (dropped/invalid/usurped/finality-timeout — else
/// finalize-mode would hang), OR a pool reject. The events returned with `finalize:true` are read
/// FROM the finalized block, so the caller's event assertions re-verify against finalized state.
export function send(api, tx, signer, label, { finalize = false, log = () => {} } = {}) {
	return new Promise((resolve, reject) => {
		let unsub;
		const stop = () => { if (typeof unsub === "function") unsub(); };
		tx.signAndSend(signer, ({ status, events = [], dispatchError }) => {
			// Trace the status machine (gap 5): an operator watching a live committee write needs to
			// see progress (inBlock → finalized) and the on-chain reason BEFORE a reject, otherwise a
			// stalled or reverted tx looks like a hang with no context. Off by default (no-op log).
			if (dispatchError) {
				let msg = dispatchError.toString();
				if (dispatchError.isModule) {
					try {
						const d = api.registry.findMetaError(dispatchError.asModule);
						msg = `${d.section}.${d.name}`;
					} catch (ex) {
						// findMetaError can throw on malformed metadata / a mock registry — surface the
						// decode failure (with the raw module index) and still reject cleanly, never let an
						// uncaught exception escape the callback and leave the promise unsettled (gap 3).
						msg = `module error (undecodable: ${ex?.message || ex})`;
					}
				}
				log(`${label}: dispatchError ${msg} — rejecting`);
				stop();
				return reject(new Error(`${label}: dispatchError ${msg}`));
			}
			if (status.isDropped || status.isInvalid || status.isUsurped || status.isFinalityTimeout) {
				log(`${label}: terminal status ${status.type} (never included/finalized) — rejecting`);
				stop();
				return reject(new Error(`${label}: tx ${status.type} (never included/finalized)`));
			}
			if (status.isInBlock) log(`${label}: inBlock`);
			if (status.isFinalized) log(`${label}: finalized`);
			if (finalize ? status.isFinalized : status.isInBlock) {
				stop();
				try {
					// Defend the event destructure (gap 4): a malformed events array (a null entry or an
					// entry without `.event`) must reject with context, not throw an uncaught TypeError
					// out of the subscription callback (which would leave the promise hanging forever).
					return resolve(events.map((e) => e.event));
				} catch (ex) {
					log(`${label}: malformed events array (${ex?.message || ex}) — rejecting`);
					return reject(new Error(`${label}: malformed events array (${ex?.message || ex})`));
				}
			}
		}).then((u) => { unsub = u; }).catch(reject);
	});
}

export const has = (events, section, method) =>
	events.some((e) => e.section === section && e.method === method);
export const find = (events, section, method) =>
	events.find((e) => e.section === section && e.method === method);

/// Throw if a wrapped privileged inner call reported an `Err` DispatchResult. The collective
/// `Executed` and sudo `Sudid` events carry the inner dispatch result as a codec at `resultIdx`
/// (Executed: [proposal_hash, result] ⇒ idx 1; Sudid: [sudo_result] ⇒ idx 0). Without this check a
/// REVERTED inner call (Duplicate / WeightTooHigh / TooManyValidators / NonMonotonicAnchor / …) would
/// be reported as success merely because the outer tx and the motion succeeded (committee-3). Tolerant
/// of a missing result field (older metadata, or a mock with no data) — only an explicit `isErr` throws.
export function ensureExecuted(api, events, section, method, resultIdx, label) {
	const e = find(events, section, method);
	const res = e && e.data && e.data[resultIdx];
	if (res && res.isErr) {
		let msg;
		try {
			const err = res.asErr;
			if (err && err.isModule) {
				const d = api.registry.findMetaError(err.asModule);
				msg = `${d.section}.${d.name}`;
			} else {
				msg = err ? err.toString() : "Err";
			}
		} catch (ex) {
			// Surface the actual decode failure (gap 14) — "inner dispatch error" alone gives an
			// operator nothing to troubleshoot a metadata/codec mismatch with.
			msg = `inner dispatch error (${ex?.message || ex})`;
		}
		throw new Error(`${label}: inner call REVERTED (${msg}) — the motion executed but the wrapped call failed`);
	}
}

/// Drive a privileged inner call via SUDO (EnsureRoot — the retained v1 dev escape hatch).
export async function viaSudo(api, innerCall, opts = {}) {
	const ops = opts.operators || operators();
	const sudo = opts.sudo || ops.map.Alice; // dev sudo key = //Alice
	const log = opts.log || (() => {});
	const finalize = opts.finalize ?? true; // privileged write resolves on finalization (committee-2)
	log(`via SUDO (EnsureRoot dev fallback) as ${sudo.address}`);
	const evs = await send(api, api.tx.sudo.sudo(innerCall), sudo, `sudo:${opts.label || "call"}`, { finalize, log });
	if (!has(evs, "sudo", "Sudid")) throw new Error("no sudo.Sudid event");
	ensureExecuted(api, evs, "sudo", "Sudid", 0, "sudo"); // committee-3: surface a reverted inner call
	return { evs, via: "sudo" };
}

/// Drive a privileged inner call through the 3-of-5 FollowerCommittee: propose → vote ×k → close.
/// Returns { proposalIndex, proposalHash, closeEvs, evs (the executed inner events) }.
export async function viaCommittee(api, innerCall, opts = {}) {
	const ops = opts.operators || operators();
	const members = opts.members || ops.committee;
	const threshold = opts.threshold || 3;
	const proposer = opts.proposer || members[0];
	// The first `threshold` members each cast an aye (the proposer votes explicitly too — pallet
	// collective does NOT auto-vote the proposer, mirroring the proven M5 flow).
	const voters = opts.voters || members.slice(0, threshold);
	const closer = opts.closer || members[members.length - 1];
	const log = opts.log || (() => {});
	// Fail loudly when the threshold can never be met (gap 2): with the default voters =
	// members.slice(0, threshold), a threshold above the member count silently produces only
	// `members.length` ayes, and the motion later closes as "NOT Approved" with a misleading message.
	// Detect it up front so the operator sees the real cause (mis-sized committee), not a vote count
	// they can't reconcile. An explicit short `voters` list is also rejected here.
	if (voters.length < threshold)
		throw new Error(`viaCommittee: only ${voters.length} voter(s) for a ${threshold}-of-${members.length} threshold — the motion can never reach Approved (committee too small / threshold too high)`);
	// The privileged write resolves on finalization (committee-2). With threshold==1 the inner call
	// executes on `propose` (no motion), so that is the step to finalize; otherwise it is `close`.
	const finalize = opts.finalize ?? true;

	const lengthBound = innerCall.method.toU8a().length + 8;
	const proposeEvs = await send(
		api,
		api.tx.followerCommittee.propose(threshold, innerCall, lengthBound),
		proposer,
		"propose",
		{ finalize: finalize && threshold === 1, log },
	);
	const proposed = find(proposeEvs, "followerCommittee", "Proposed");
	if (!proposed) {
		// threshold==1 executes immediately on propose (no motion). Surface that cleanly.
		if (has(proposeEvs, "followerCommittee", "Executed")) {
			ensureExecuted(api, proposeEvs, "followerCommittee", "Executed", 1, "propose"); // committee-3
			return { proposalIndex: null, proposalHash: null, closeEvs: proposeEvs, evs: proposeEvs };
		}
		throw new Error("no FollowerCommittee.Proposed event (is the proposer a committee member?)");
	}
	const proposalIndex = proposed.data[1].toNumber();
	const proposalHash = proposed.data[2].toHex();
	log(`proposed motion #${proposalIndex} (${proposalHash.slice(0, 10)}…), threshold ${threshold}-of-${members.length}`);

	for (let i = 0; i < voters.length; i++) {
		const v = voters[i];
		// Per-vote trace (gap 6): if vote k of n rejects (a bad seat, a duplicate vote, a stalled tx),
		// the operator must see WHICH voter on WHICH proposal failed — the bare "vote" label otherwise
		// gives no way to tell aye #2 from aye #3.
		log(`  vote ${i + 1}/${voters.length} on motion #${proposalIndex} by ${String(v.address).slice(0, 8)}…`);
		await send(api, api.tx.followerCommittee.vote(proposalHash, proposalIndex, true), v, `vote ${i + 1}/${voters.length} (${String(v.address).slice(0, 8)}…)`, { log });
	}
	log(`${voters.length} ayes cast (${voters.map((v) => v.address.slice(0, 8)).join(", ")}…) — supermajority`);

	const weightBound = opts.weightBound || { refTime: 10_000_000_000n, proofSize: 1_000_000n };
	const closeEvs = await send(
		api,
		api.tx.followerCommittee.close(proposalHash, proposalIndex, weightBound, lengthBound),
		closer,
		"close",
		{ finalize, log },
	);
	if (!has(closeEvs, "followerCommittee", "Approved"))
		throw new Error("motion was NOT Approved (threshold not reached?)");
	if (!has(closeEvs, "followerCommittee", "Executed"))
		throw new Error("motion Approved but inner call did NOT execute (Executed missing)");
	ensureExecuted(api, closeEvs, "followerCommittee", "Executed", 1, "close"); // committee-3: reverted inner call
	log(`close → Approved + Executed (the proposal lifecycle IS the per-action audit log)`);
	return { proposalIndex, proposalHash, closeEvs, evs: closeEvs };
}

/// Dispatch a privileged inner call by `via` ∈ {committee, sudo}. Default: committee (the D2 path).
/// Prints the honesty label when going through the committee on a single-operator stack.
export async function drive(api, innerCall, opts = {}) {
	const via = opts.via || "committee";
	const log = opts.log || console.log;
	if (via === "sudo") return viaSudo(api, innerCall, { ...opts, log });
	if (via === "committee") {
		log(
			"⚠ committee path on a single-operator stack = D2-SHAPED, not D2-TRUST " +
				"(one operator holds all 5 keys; see docs/D2-custody-runbook.md)",
		);
		return viaCommittee(api, innerCall, { ...opts, log });
	}
	throw new Error(`unknown --via "${via}" (expected committee | sudo)`);
}
