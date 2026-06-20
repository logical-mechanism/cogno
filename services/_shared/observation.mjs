// The DETERMINISTIC Cardano-observation library (in-protocol-observation, step 2 / D4).
//
// This is the pure, dependency-free core of the locked-ADA → talk-stake WEIGHT path, factored out so
// the SAME logic runs in three places byte-identically: the off-chain follower/committee reader (today),
// and — once the inherent lands (docs/IN-PROTOCOL-OBSERVATION.md §9 steps 2-3) — every validator node's
// InherentDataProvider and the runtime's check_inherent. The whole consensus argument rests on this being
// a PURE FUNCTION: same Cardano state + same reference slot in ⇒ byte-identical observed state out, on
// every node. Any nondeterminism here = a chain fork.
//
// What changed vs the legacy sync-weight.mjs `pickLargest` (which this supersedes for the enforced path):
//   • Read AS-OF a FIXED reference slot, not the live tip. `?unspent` ("unspent NOW") and the
//     ogmiosTipSlot() burial gate are replaced by: query `?created_before={ref}` then apply, CLIENT-SIDE,
//     `created_at.slot ≤ ref AND (spent_at == null OR spent_at.slot > ref)`. A UTxO SPENT AFTER the
//     reference is still counted as locked-at-ref (the bug `?unspent` would introduce). See §5.4.
//   • The reference slot is a fail-closed, checked-arithmetic function of a stable point (§5.1/§5.2),
//     never wall-clock/tip. Release WASM has overflow-checks OFF, so the eventual Rust port must use the
//     same guard-then-checked_sub shape this module models (a u64 underflow would WRAP, not fail).
//   • A canonical, order-independent SCALE-compatible byte encoding (`canonicalBytes`) is the determinism
//     WITNESS: two independent reads of the same stable point produce identical bytes. The runtime will
//     reproduce these exact bytes via SCALE over the same logical (reference_slot, sorted [(beacon,
//     lovelace)]) structure, so the off-chain digest and the on-chain digest match (the shadow-mode diff).
//
// Largest-wins per beacon (NEVER sum) and the MIN_LOCK floor are unchanged (anti-Sybil; ECONOMICS §6.1).
// The floor (`lockToWeight`) is applied at WEIGHT-application, not here — `observeAsOf` returns the raw
// largest locked lovelace per beacon (the observed STATE); the curve/floor live downstream (§7 step 2).

export const MIN_LOCK = 100_000_000n; // L1 min_lock (lovelace); see contracts/vault.json

// ── the MIN_LOCK gate ────────────────────────────────────────────────────────────────────────────
// PURE: locked lovelace at/above the floor becomes weight, below it is zero. (Applied at weight-
// application, §7 step 2 — NOT a filter inside observeAsOf, so the observed set carries raw lovelace.)
export const lockToWeight = (lovelace, minLock = MIN_LOCK) => (lovelace >= minLock ? lovelace : 0n);

// ── the deterministic reference slot (§5.1/§5.2) ──────────────────────────────────────────────────
// PURE + FAIL-CLOSED: map a stable wall-clock time (unix seconds) to the Cardano slot to observe
// AS-OF, = (Shelley-anchored slot at that time) − the stability window. Returns a BigInt slot, or
// `null` when the inputs are degenerate (pre-Shelley / wrong-network / underflow) ⇒ the caller emits
// the EMPTY observation (never guesses, never throws). All arithmetic is BigInt + guarded BEFORE any
// subtraction: a naive `unix − shelleyStartUnix` on a pre-Shelley input would WRAP under wasm
// overflow-checks-off (the eventual Rust port MUST do the same; test it with overflow-checks=false).
//
// Only 1-slot/sec (Shelley+) is supported: the anchor MUST be the Shelley start, NOT Byron `systemStart`
// (preprod systemStart 1654041600 is Byron; the Shelley anchor is slot 86400 / unix 1655769600). Every
// honest reference (≥ the ~36 h window old, post-Shelley) is deep in the 1 s era, so a Byron converter
// is unnecessary; we assert the 1 s slot length and refuse anything else (a future HF is a code change).
export function cardanoReferenceSlot({
	unixSeconds,
	shelleyStartUnix,
	shelleyStartSlot,
	stabilitySlots,
	slotLengthMs = 1000,
}) {
	if (BigInt(slotLengthMs) !== 1000n) {
		throw new Error(`cardanoReferenceSlot supports only 1 s Shelley slots (got slotLengthMs=${slotLengthMs})`);
	}
	const t = BigInt(unixSeconds);
	const t0 = BigInt(shelleyStartUnix);
	const s0 = BigInt(shelleyStartSlot);
	const window = BigInt(stabilitySlots);
	if (window < 0n) throw new Error("stabilitySlots must be >= 0");
	// Guard BEFORE subtracting (wrap-safe): a time before the Shelley anchor ⇒ no valid slot.
	if (t < t0) return null;
	const cardanoSlot = s0 + (t - t0); // 1 slot / s
	const reference = cardanoSlot - window;
	// The reference must still be at/after the Shelley anchor (a too-large window on a young chain
	// underflows the era floor) ⇒ fail closed.
	if (reference < s0) return null;
	return reference;
}

// PURE convenience for the in-node path (§5.1): derive the reference from the PARENT block's Aura slot.
// An Aura slot is absolute (unix_ms / slotDuration), so `auraSlot * slotDurationMs` is the canonical
// slot-start unix time — deterministic and identical on author + importer (both hold the parent header).
export function referenceFromAuraSlot({
	auraSlot,
	slotDurationMs,
	shelleyStartUnix,
	shelleyStartSlot,
	stabilitySlots,
	slotLengthMs = 1000,
}) {
	const unixSeconds = (BigInt(auraSlot) * BigInt(slotDurationMs)) / 1000n;
	return cardanoReferenceSlot({ unixSeconds, shelleyStartUnix, shelleyStartSlot, stabilitySlots, slotLengthMs });
}

// ── strict integer parsers (EXACT mirrors of the Rust node's as_u64 / as_u128, §5.3/§5.4) ───────────
// The consensus inherent is built in Rust; observation.mjs is the determinism witness that must match it
// BYTE-FOR-BYTE. JS's coercions (`Number("1.0")===1`, `BigInt(" 1")===1n`) are LOOSER than Rust's
// `serde_json::Value::as_u64()/as_str().parse()`, so a beacon qty / coins / slot that one accepts and the
// other drops would fork the read. These helpers reproduce Rust's parse exactly:
//   • a JSON NUMBER counts only if it is a non-negative integer within range (Rust `as_u64()` returns None
//     for floats / out-of-range; JS `Number.isInteger` matches, modulo the one case JS cannot see — a JSON
//     number written `1.0`, which `JSON.parse` collapses to `1`; Kupo never emits fractional integers, so
//     this residual is unreachable with real data and is the documented precondition).
//   • a STRING counts only if it is pure ASCII digits within range. The Rust port's `as_u64`/`as_u128`
//     apply an explicit `all(is_ascii_digit)` guard BEFORE `from_str` — Rust's bare `u64::from_str` would
//     ACCEPT a leading `+` ("+1") that this `/^[0-9]+$/` rejects — so "1.0" / " 1" / "0x1" / "+1" are
//     dropped IDENTICALLY on both sides (a beacon qty / coins / slot one side dropped and the other kept
//     would fork the read). db-sync now returns clean numeric `::text`, so the loose case is unreachable
//     with real data, but the shared parser must not silently diverge (the equivalence fixture pins it).
const MAX_U64 = (1n << 64n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;
const asUintStrict = (v, max) => {
	if (typeof v === "number") return Number.isInteger(v) && v >= 0 && BigInt(v) <= max ? BigInt(v) : null;
	if (typeof v === "bigint") return v >= 0n && v <= max ? v : null;
	if (typeof v === "string") return /^[0-9]+$/.test(v) && BigInt(v) <= max ? BigInt(v) : null;
	return null;
};
const asU64 = (v) => asUintStrict(v, MAX_U64);
const asU128 = (v) => asUintStrict(v, MAX_U128);
// A vault beacon name is the 32-byte (64 lowercase-hex) L1 `token_name`. The Rust port resolves it via
// hex32 (which returns None for any other length), so JS must skip a non-32-byte name too — otherwise it
// would credit a name Rust drops (and `canonicalBytes` would then throw). Always lowercase-normalised.
const isBeacon32 = (hex) => typeof hex === "string" && hex.length === 64 && /^[0-9a-f]+$/.test(hex);

// ── the sealed stable-block anchor (§15.3 / Midnight delta A.1) ──────────────────────────────────────
// The anchor is no longer reduced in JS: with the pivot from Kupo to db-sync it is a SINGLE SQL row — the
// `block` row at `max(slot_no) <= reference` (see `services/committee/dbsync.mjs` / `node/src/dbsync.rs`).
// `block` holds EVERY block, so "latest block at/under S" is exact (≤1 block/slot on settled history ⇒
// unique across every fully-synced db-sync), unlike Kupo's sparse, tip-relative `/checkpoints` ladder which
// resolved different anchors on two honest nodes (the false-`Mismatch` blocker). The retired `latestStableBlock`/
// `latestStableBlockHash` Kupo `/checkpoints` mirror (and `parse_checkpoint_anchor` in the node) are gone; the
// sealed `CardanoRef.block_hash` now derives deterministically from SQL, not a JS reduction over a checkpoint array.

// ── the deterministic observation (§5.3) ──────────────────────────────────────────────────────────
// PURE: from Kupo `/matches/{vaultHash}.*` JSON, reduce to the largest-wins locked lovelace per beacon
// AS-OF `referenceSlot`. A match counts only if it carries EXACTLY ONE asset of the vault policy at
// quantity 1, positive lovelace, was created at/before the reference, and is unspent as-of the reference
// (`spent_at == null OR spent_at.slot_no > referenceSlot`). Largest-wins per beacon (never sum).
//
// Returns Map<beaconHex (lowercased), lovelace:BigInt>. Pass `{ reasons }` (a Map) to capture WHY each
// skipped UTxO was rejected (keyed per-UTxO `tx#ix`, only surfaced if that beacon wasn't credited by
// another UTxO) — mirrors the legacy pickLargest reason-surfacing so the operator can tell "too fresh /
// spent / swept / malformed" apart. This function CANNOT log (it must stay pure); the caller surfaces it.
export function observeAsOf(matches, { vaultHash, referenceSlot, reasons = null } = {}) {
	if (referenceSlot == null) {
		// Fail-closed: no valid reference ⇒ the empty observation (caller decided to abstain, §5.1).
		return new Map();
	}
	const ref = BigInt(referenceSlot);
	const vh = String(vaultHash).toLowerCase();
	const largest = new Map();
	const rejected = []; // { utxo, beacon|null, why } — surfaced into `reasons` after credits are known
	const utxoId = (m, fallback) => `${m.transaction_id ?? fallback}#${m.output_index ?? 0}`;

	for (const m of matches) {
		const assets = m.value?.assets ?? {};
		const beacons = Object.entries(assets).filter(([k]) => k.split(".")[0].toLowerCase() === vh);
		// Exactly one vault asset at qty 1 — qty parsed the SAME strict way the Rust port does (asU64 == 1),
		// so a Number-coercible-but-not-integer qty like "1.0"/" 1" is dropped on BOTH sides, not just Rust.
		if (beacons.length !== 1 || asU64(beacons[0][1]) !== 1n) {
			rejected.push({ utxo: utxoId(m, JSON.stringify(assets)), beacon: null, why: `not exactly one beacon at qty 1 (${beacons.length} vault asset(s))` });
			continue;
		}
		const beacon = beacons[0][0].split(".")[1]?.toLowerCase() ?? "";
		// A 32-byte (64-hex) beacon only — matches the Rust port's hex32 (which drops any other length).
		// Without this, JS would credit a short name then `canonicalBytes` would throw while Rust silently
		// drops it — a hard cross-node divergence (the on-chain beacon is always 32 bytes, so this is the
		// fail-closed guard, not a reachable on-chain case).
		if (!isBeacon32(beacon)) {
			rejected.push({ utxo: utxoId(m, beacon), beacon: null, why: `beacon name is not 32 bytes ("${beacon}")` });
			continue;
		}

		// AS-OF-ref window: created at/before ref, and unspent as-of ref. A missing/unparseable created
		// slot fails closed (skip) — we must never credit a UTxO we can't place in time. Parsed via the
		// strict asU64 mirror (Rust drops a non-integer slot too).
		const createdSlot = asU64(m.created_at?.slot_no);
		if (createdSlot == null) {
			rejected.push({ utxo: utxoId(m, beacon), beacon, why: "no/invalid created_at.slot_no (fail closed)" });
			continue;
		}
		if (createdSlot > ref) {
			rejected.push({ utxo: utxoId(m, beacon), beacon, why: `created at slot ${createdSlot} > reference ${ref} (too fresh)` });
			continue;
		}
		// Spent strictly AT/BEFORE the reference ⇒ not locked as-of ref. A null/unparseable spent_at slot ⇒
		// treated as still-locked (Rust: `if let Some(spent) = …as_u64 { if spent <= ref … }` — an
		// unparseable spend does not exclude). spent slot AFTER ref ⇒ still locked (the `?unspent` trap).
		const spentSlot = asU64(m.spent_at?.slot_no);
		if (spentSlot != null && spentSlot <= ref) {
			rejected.push({ utxo: utxoId(m, beacon), beacon, why: `spent at slot ${spentSlot} <= reference ${ref} (not locked as-of ref)` });
			continue;
		}

		// Lovelace parsed via the strict asU128 mirror (Rust as_u128); null/non-positive ⇒ not credited.
		const coins = asU128(m.value?.coins);
		if (coins == null || coins <= 0n) {
			rejected.push({ utxo: utxoId(m, beacon), beacon, why: "zero/negative/invalid lovelace (not credited)" });
			continue;
		}
		// LARGEST-WINS: strict `>` so equal-lovelace duplicates collapse to one (value-identical) entry —
		// no tiebreak needed because only the VALUE is carried, not a chosen UTxO reference (§5.3 rule 3).
		if (coins > (largest.get(beacon) ?? 0n)) largest.set(beacon, coins);
	}

	if (reasons) {
		for (const r of rejected) {
			if (r.beacon && largest.has(r.beacon)) continue; // credited by another UTxO ⇒ not a real rejection
			reasons.set(r.utxo, r.beacon ? `${r.beacon.slice(0, 16)}…: ${r.why}` : r.why);
		}
	}
	return largest;
}

// ── canonical encoding (§5.3) — the determinism WITNESS ────────────────────────────────────────────
// PURE: the byte layout two independent reads must agree on, and that the runtime reproduces via SCALE.
// Logical structure: ObservedVault { reference_slot: u64, entries: Vec<([u8;32] beacon, u128 lovelace)> }.
// Rules: entries sorted strictly ASCENDING by the 32 raw beacon bytes (≡ lowercased-hex order); beacon is
// the raw 32 bytes (never hex in the bytes); lovelace u128; SCALE encoding (u64 LE, compact-length Vec,
// per-entry 32 bytes ++ u128 LE). NOTHING else enters (no datum/script/address/output_index) — §5.3 rule 5.
//
// Takes either a Map<beaconHex,lovelace> (observeAsOf's output) or an array of [beaconHex, lovelace].
export function canonicalBytes({ referenceSlot, observed }) {
	const entries = (observed instanceof Map ? [...observed.entries()] : [...observed])
		.map(([hex, lovelace]) => [String(hex).toLowerCase(), BigInt(lovelace)])
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // total order: keys are unique post-largest-wins

	const out = [];
	pushU64LE(out, BigInt(referenceSlot)); // reference_slot: u64
	pushCompact(out, entries.length); // Vec length (SCALE compact)
	for (const [hex, lovelace] of entries) {
		const bytes = hexToBytes(hex);
		if (bytes.length !== 32) throw new Error(`beacon must be 32 bytes (got ${bytes.length} from "${hex}")`);
		for (const b of bytes) out.push(b);
		pushU128LE(out, lovelace); // lovelace: u128
	}
	return Uint8Array.from(out);
}

// Hex of the canonical bytes — the convenient determinism witness for tests/cross-checks.
export const canonicalHex = (args) => bytesToHex(canonicalBytes(args));

// ── the input-commitment (the partner-chains `selection_inputs_hash` analog) ────────────────────────
// PURE: the PRE-REDUCTION structural candidate set — every vault UTxO the as-of reduction CONSUMES
// before the time-filter / largest-wins fold. This is the "raw observed Cardano data" the inherent
// commits to: `inputs_commitment = blake2_256(candidateBytes(candidates(matches)))`. It lets the
// runtime's check_inherent distinguish "the importer saw DIFFERENT Cardano data" (the candidate
// commitments differ ⇒ Mismatch) from "the importer COMPUTED a different reduced output from the SAME
// data" (commitments agree but entries differ ⇒ ComputeDiverged — a determinism bug / version skew),
// where today both collapse to one Mismatch. The commitment is only consulted when the reduced outputs
// already disagree (a fatal condition either way); it never causes a rejection on its own, so two honest
// nodes with slightly different candidate sets that reduce to the SAME entries are still accepted.
//
// A candidate is included iff the match carries EXACTLY ONE vault beacon at qty 1, a 32-byte beacon
// name, a present `created_at.slot_no`, and a parseable non-negative `coins` — the same structural gate
// observeAsOf applies BEFORE its time/coins/largest-wins reduction (mirrored byte-for-byte by
// `candidate_tuples` in node/src/cardano_observer.rs). Carries RAW (beacon, created, spent, coins) — no
// time filter, no largest-wins (those are the reduction, not the input). NOT a consensus filter itself:
// the determinism it rests on is that every node runs this identical parse over identical stable data.
export function candidates(matches, { vaultHash } = {}) {
	const vh = String(vaultHash).toLowerCase();
	const out = [];
	for (const m of matches) {
		const assets = m.value?.assets ?? {};
		const beacons = Object.entries(assets).filter(([k]) => k.split(".")[0].toLowerCase() === vh);
		// SAME structural gate as observe_as_of / candidate_tuples (strict asU64 qty == 1, 32-byte beacon,
		// strict integer created/coins) so the candidate pre-image is byte-identical to the Rust port.
		if (beacons.length !== 1 || asU64(beacons[0][1]) !== 1n) continue;
		const beacon = beacons[0][0].split(".")[1]?.toLowerCase() ?? "";
		if (!isBeacon32(beacon)) continue;
		const created = asU64(m.created_at?.slot_no);
		if (created == null) continue; // fail closed: a UTxO we can't place in time is not an input
		const coins = asU128(m.value?.coins);
		if (coins == null) continue;
		const spent = asU64(m.spent_at?.slot_no);
		out.push({ beacon, created, spent, coins });
	}
	// Total order matching Rust's DERIVED Ord on ([u8;32], u64, Option<u64>, u128): beacon bytes (≡
	// lowercased-hex order), then created, then spent (Rust Option: None < Some), then coins.
	out.sort((a, b) => {
		if (a.beacon !== b.beacon) return a.beacon < b.beacon ? -1 : 1;
		if (a.created !== b.created) return a.created < b.created ? -1 : 1;
		const an = a.spent == null, bn = b.spent == null;
		if (an !== bn) return an ? -1 : 1; // None sorts before Some
		if (!an && a.spent !== b.spent) return a.spent < b.spent ? -1 : 1;
		if (a.coins !== b.coins) return a.coins < b.coins ? -1 : 1;
		return 0;
	});
	return out;
}

// PURE: canonical SCALE encoding of the sorted candidate set — the commitment PRE-IMAGE the runtime
// hashes. Byte-identical to `Vec<([u8;32], u64, Option<u64>, u128)>::encode()` in Rust: a SCALE-compact
// length, then per candidate 32 beacon bytes ++ u64 LE created ++ Option<u64> spent (0x00 None | 0x01 ++
// u64 LE Some) ++ u128 LE coins. The inputs_commitment is `blake2_256` of these bytes (computed in the
// node — observation.mjs stays dependency-free, so it produces the deterministic PRE-IMAGE only; the
// Rust↔JS equivalence fixture pins the pre-image, and blake2_256 of byte-identical input is identical).
export function candidateBytes({ candidates: cands }) {
	const out = [];
	pushCompact(out, cands.length);
	for (const c of cands) {
		const bytes = hexToBytes(c.beacon);
		if (bytes.length !== 32) throw new Error(`candidate beacon must be 32 bytes (got ${bytes.length} from "${c.beacon}")`);
		for (const b of bytes) out.push(b);
		pushU64LE(out, c.created);
		if (c.spent == null) { out.push(0x00); } else { out.push(0x01); pushU64LE(out, c.spent); }
		pushU128LE(out, c.coins);
	}
	return Uint8Array.from(out);
}

// Convenience: the candidate-commitment pre-image bytes straight from Kupo matches.
export const candidateBytesFor = (matches, { vaultHash } = {}) => candidateBytes({ candidates: candidates(matches, { vaultHash }) });
// Hex of the candidate pre-image — the determinism witness the Rust↔JS equivalence fixture pins.
export const candidateHex = (matches, opts) => bytesToHex(candidateBytesFor(matches, opts));

// ── SCALE-compatible primitives (dependency-free) ───────────────────────────────────────────────────
function pushU64LE(out, v) {
	let x = BigInt.asUintN(64, v);
	for (let i = 0; i < 8; i++) { out.push(Number(x & 0xffn)); x >>= 8n; }
}
function pushU128LE(out, v) {
	let x = BigInt.asUintN(128, v);
	for (let i = 0; i < 16; i++) { out.push(Number(x & 0xffn)); x >>= 8n; }
}
// SCALE compact integer (sufficient for our small Vec lengths: single / two-byte / four-byte modes).
function pushCompact(out, n) {
	const v = BigInt(n);
	if (v < 0n) throw new Error("compact length must be >= 0");
	if (v < 64n) { out.push(Number(v) << 2); return; }
	if (v < 16384n) { const x = (v << 2n) | 0b01n; out.push(Number(x & 0xffn), Number((x >> 8n) & 0xffn)); return; }
	if (v < 1073741824n) {
		const x = (v << 2n) | 0b10n;
		out.push(Number(x & 0xffn), Number((x >> 8n) & 0xffn), Number((x >> 16n) & 0xffn), Number((x >> 24n) & 0xffn));
		return;
	}
	throw new Error("compact length too large for this encoder"); // unreachable for any real vault set
}
function hexToBytes(hex) {
	const h = String(hex).toLowerCase().replace(/^0x/, "");
	if (h.length % 2 !== 0 || /[^0-9a-f]/.test(h)) throw new Error(`invalid hex: "${hex}"`);
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
	return out;
}
function bytesToHex(bytes) {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}
