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
export function missedIntervals(last, finalized, every) {
	if (every <= 0n) return 0;
	if (last == null) {
		// first-ever anchor: full intervals below `finalized`, minus the one we anchor now.
		return finalized >= every ? Number(finalized / every) - 1 : 0;
	}
	const intervals = (finalized - last) / every; // BigInt floor division
	return intervals > 1n ? Number(intervals - 1n) : 0;
}
