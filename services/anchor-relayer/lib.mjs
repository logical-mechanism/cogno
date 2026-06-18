// Pure, dependency-free helpers for the Anchor Relayer — extracted so the trust-critical arithmetic
// and ack parsing are unit-testable without the live PAPI/Cardano stack (relayer-9).

/// Parse the op.mjs / sudo output for the anchor_ack result tokens. Neither token present means the
/// inner dispatch didn't surface a result — the caller treats that as a hard failure (relayer-2).
export function parseAckTokens(out) {
	const s = String(out);
	return { acked: /AnchorAcked/.test(s), ignored: /AckIgnored/.test(s) };
}

/// How many anchoring opportunities were SKIPPED between the last recorded checkpoint and the
/// finalized head we are about to anchor (relayer-6). In continuous operation the relayer anchors
/// ~every `every` blocks; if it was down, several intervals elapse and only the latest head gets
/// anchored, leaving a tamper-evidence gap over the skipped range. `last`/`finalized`/`every` are
/// BigInt (`last` may be null for the first-ever anchor). Returns an integer estimate (>= 0).
///
/// BACKWARDS TIME (relayer-6, reorg guard): if `finalized < last` the finalized head has REGRESSED —
/// a GRANDPA finality reversion or a wiped/forked L3 chain, which violates the monotonicity the
/// relayer relies on (the caller only anchors heights strictly above `last`). BigInt floor division
/// of the negative difference would yield a non-positive value silently, so we return 0 explicitly
/// (no gap to record going backwards) and leave the "should never happen" detection to the caller's
/// `head.number <= last` guard, which logs the regression. Documented here so a reorg input is a
/// CONSCIOUS 0, not an accident of floor-division sign.
export function missedIntervals(last, finalized, every) {
	if (every <= 0n) return 0;
	if (last == null) {
		// first-ever anchor: full intervals below `finalized`, minus the one we anchor now.
		return finalized >= every ? Number(finalized / every) - 1 : 0;
	}
	if (finalized <= last) return 0; // no advance OR a backwards/reorg head ⇒ no forward gap to record
	const intervals = (finalized - last) / every; // BigInt floor division (finalized > last here)
	return intervals > 1n ? Number(intervals - 1n) : 0;
}

/// Pure pick of the oldest persisted anchor still needing an L3 ack (relayer-1/4) — extracted from the
/// relayer so the resume-ordering is unit-testable without the live stack. An entry is PENDING iff its
/// Cardano tx confirmed (`cardanoTx` set AND `slot != null`) but the ack never landed (`!acked`), and
/// it is not permanently `failed` (relayer-4 — skipping those prevents a wedged entry from blocking
/// all forward anchoring). Returns the lowest-`block` such entry, or null if none. Single O(n)
/// min-scan over the append-only `anchors` list — never sorts, never mutates `state`.
export function oldestPendingAnchor(state) {
	let best = null;
	for (const a of (state && state.anchors) || []) {
		if (!a.cardanoTx || a.slot == null || a.acked || a.failed) continue;
		if (best === null || a.block < best.block) best = a;
	}
	return best;
}

/// Pure regression/ordering decision for a pending ack vs the on-chain checkpoint (relayer-4), pulled
/// out of `recordAckWithRetry` so the trust-critical "can this anchor ever be acked?" logic is unit-
/// testable. Given a persisted `entry` ({block, postCount, ts}) and the current on-chain checkpoint
/// `cp` ({block, postCount, ts}) or null/undefined when none / unreadable, returns exactly one of:
///   • { covered: true }                  — cp.block >= entry.block: already recorded/superseded; a
///                                          submit would only AckIgnored ⇒ caller marks recorded.
///   • { failed: true, reason }           — the entry would REGRESS post_count or timestamp below the
///                                          checkpoint ⇒ the pallet rejects it (NonMonotonicAnchor),
///                                          so it can NEVER succeed ⇒ caller marks it failed & skips.
///   • { proceed: true }                  — strictly ahead and monotonic ⇒ caller attempts the ack.
/// A null/undefined `cp` (no checkpoint yet, or a transient read failure) is treated as transient:
/// `{ proceed: true }`, so the caller falls through to the normal bounded-retry path.
export function classifyPendingAck(entry, cp) {
	if (!cp) return { proceed: true };
	if (cp.block >= entry.block) return { covered: true };
	if (entry.postCount < cp.postCount || entry.ts < cp.ts) {
		return {
			failed: true,
			reason: `would regress vs on-chain LastCheckpoint #${cp.block} (post_count ${entry.postCount} < ${cp.postCount} or ts ${entry.ts} < ${cp.ts}) → NonMonotonicAnchor`,
		};
	}
	return { proceed: true };
}

/// Validate a hex string and decode to a byte length (relayer-6 logging gap). The relayer's
/// [u8;32] anchor fields (state_root, Cardano txhash) MUST be exactly 32 bytes; a corrupted/truncated
/// state-file hash (e.g. a 63-char hash) silently decodes to wrong bytes and is only rejected
/// cryptically deep in the ack dispatch. This pure validator lets `hexToBytes` (and tests) reject
/// bad input EARLY with a descriptive error. `expectedBytes` (default 32) = 0 disables the length
/// check (accept any even-length hex). Returns the cleaned, lower-cased, 0x-stripped hex on success;
/// THROWS a descriptive Error otherwise.
export function validateHex(h, expectedBytes = 32) {
	if (typeof h !== "string") throw new Error(`invalid hex: expected a string, got ${typeof h}`);
	const s = h.replace(/^0x/i, "").toLowerCase();
	if (s.length === 0) throw new Error("invalid hex: empty string");
	if (s.length % 2 !== 0) throw new Error(`invalid hex: odd length ${s.length} (truncated hash?): ${h.slice(0, 12)}…`);
	if (!/^[0-9a-f]+$/.test(s)) throw new Error(`invalid hex: non-hex characters in ${h.slice(0, 12)}…`);
	if (expectedBytes > 0 && s.length !== expectedBytes * 2)
		throw new Error(`invalid hex: expected ${expectedBytes} bytes (${expectedBytes * 2} hex chars) but got ${s.length / 2} bytes (${s.length} chars): ${h.slice(0, 12)}…`);
	return s;
}
