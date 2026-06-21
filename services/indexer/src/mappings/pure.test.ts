// Unit tests for the PURE mapping logic (src/mappings/pure.ts) — the decode/normalization branches
// extracted from mappingHandlers so they run with NO @subql/@polkadot runtime. These cover the
// ERROR/EDGE paths that the acceptance tests (verify-m4c.mjs, m5-acceptance.mjs) cannot reach:
// malformed/truncated UTF-8, missing codecs, the timestamp-0/negative/missing fallback decision,
// oversized text, and hex/parentId normalization edge cases.
//
// Run: node --experimental-strip-types src/mappings/pure.test.ts   (Node 22.12+, exits 1 on failure)
//
// Style matches the repo's acceptance scripts: ✓ on pass, ✗ + exit(1) on the first failure.

import {
  applyOption,
  applyVote,
  decCount,
  foldVote,
  isWellFormedIdentityHash,
  normalizeIdentityHash,
  normalizeParentId,
  normalizeVoteDir,
  reverseOption,
  reverseVote,
  satDec,
  satSubU128,
  tallyScore,
  timestampDecision,
  utf8FromBytes,
  zeroTally,
  type OptionState,
  type TallyState,
  type VoteSnapshot,
} from "./pure.ts";

let failed = 0;
let passed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

// BigInt-aware stringify (JSON.stringify throws on bigint) — tags bigints so 1n != "1".
const ser = (v: unknown) => JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? `${val}n` : val));

function eq(name: string, actual: unknown, expected: unknown): void {
  const same = ser(actual) === ser(expected);
  if (!same) console.log(`      actual  =${ser(actual)}\n      expected=${ser(expected)}`);
  check(name, same);
}

// ── utf8FromBytes ─────────────────────────────────────────────────────────────
console.log("\nutf8FromBytes:");

eq("null bytes -> ''", utf8FromBytes(null), "");
eq("undefined bytes -> ''", utf8FromBytes(undefined), "");
eq("empty array -> ''", utf8FromBytes(new Uint8Array([])), "");
eq(
  "ascii 'hello' round-trips",
  utf8FromBytes(new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f])),
  "hello",
);
// multi-byte: € is E2 82 AC in UTF-8
eq("multi-byte € decodes", utf8FromBytes(new Uint8Array([0xe2, 0x82, 0xac])), "€");
// emoji 😀 = F0 9F 98 80 (4 bytes)
eq("4-byte emoji 😀 decodes", utf8FromBytes(new Uint8Array([0xf0, 0x9f, 0x98, 0x80])), "😀");

// Truncated multi-byte (€ with its last byte chopped) must NOT throw — it substitutes U+FFFD.
{
  let threw = false;
  let out = "";
  try {
    out = utf8FromBytes(new Uint8Array([0xe2, 0x82]));
  } catch {
    threw = true;
  }
  check("truncated UTF-8 does not throw", !threw);
  check("truncated UTF-8 yields replacement char (no crash, no halt)", out.includes("�"));
}

// Lone invalid continuation byte (0xff is never valid in UTF-8) -> replacement, no throw.
{
  let threw = false;
  let out = "";
  try {
    out = utf8FromBytes(new Uint8Array([0xff, 0xfe, 0x68, 0x69]));
  } catch {
    threw = true;
  }
  check("invalid UTF-8 bytes do not throw", !threw);
  // valid tail "hi" survives even though the leading bytes are garbage
  check("invalid UTF-8 preserves the valid tail", out.endsWith("hi"));
}

// Oversized text (well beyond any BoundedVec bound) decodes fully — pure layer does not clamp;
// length bounds are enforced on-chain, the indexer faithfully stores whatever the chain emitted.
{
  const big = new Uint8Array(50_000).fill(0x61); // 50k 'a'
  const out = utf8FromBytes(big);
  eq("oversized text length preserved", out.length, 50_000);
  check("oversized text content is all 'a'", out === "a".repeat(50_000));
}

// Embedded NUL bytes are kept verbatim (NUL is valid UTF-8) — not silently truncated C-string style.
eq(
  "embedded NUL is preserved",
  utf8FromBytes(new Uint8Array([0x61, 0x00, 0x62])),
  "a\u0000b",
);

// ── timestampDecision ─────────────────────────────────────────────────────────
console.log("\ntimestampDecision:");

{
  const r = timestampDecision(1_700_000_000_000);
  check("valid ms -> no fallback", r.didFallback === false);
  eq("valid ms -> correct Date", r.date.getTime(), 1_700_000_000_000);
}
{
  const r = timestampDecision(0);
  check("zero ms -> fallback flagged", r.didFallback === true);
  eq("zero ms -> epoch 0", r.date.getTime(), 0);
}
{
  const r = timestampDecision(-5);
  check("negative ms -> fallback flagged", r.didFallback === true);
  eq("negative ms -> epoch 0", r.date.getTime(), 0);
}
{
  const r = timestampDecision(undefined);
  check("undefined (unreadable) -> fallback flagged", r.didFallback === true);
  eq("undefined -> epoch 0", r.date.getTime(), 0);
}
{
  const r = timestampDecision(null);
  check("null -> fallback flagged", r.didFallback === true);
}
{
  const r = timestampDecision(NaN);
  check("NaN -> fallback flagged (not a usable wall-clock)", r.didFallback === true);
  eq("NaN -> epoch 0", r.date.getTime(), 0);
}
{
  const r = timestampDecision(Infinity);
  check("Infinity -> fallback flagged", r.didFallback === true);
  eq("Infinity -> epoch 0", r.date.getTime(), 0);
}
{
  // boundary: 1ms is the smallest positive value -> valid, NOT fallback
  const r = timestampDecision(1);
  check("1ms (boundary positive) -> no fallback", r.didFallback === false);
  eq("1ms -> Date(1)", r.date.getTime(), 1);
}

// ── normalizeParentId ─────────────────────────────────────────────────────────
console.log("\nnormalizeParentId:");

eq("undefined parent -> undefined (top-level)", normalizeParentId(undefined), undefined);
eq("null parent -> undefined", normalizeParentId(null), undefined);
eq("empty string -> undefined (no dangling FK)", normalizeParentId(""), undefined);
eq("whitespace-only -> undefined", normalizeParentId("   "), undefined);
eq("real id '42' -> '42'", normalizeParentId("42"), "42");
eq("id with surrounding whitespace is trimmed", normalizeParentId("  7 "), "7");

// ── normalizeIdentityHash ─────────────────────────────────────────────────────
console.log("\nnormalizeIdentityHash:");

const HASH64 = "ab".repeat(32); // 64 hex chars
eq("undefined -> undefined (unbound author)", normalizeIdentityHash(undefined), undefined);
eq("null -> undefined", normalizeIdentityHash(null), undefined);
eq("empty -> undefined", normalizeIdentityHash(""), undefined);
eq("already 0x-prefixed lower stays", normalizeIdentityHash("0x" + HASH64), "0x" + HASH64);
eq("upper-case is lower-cased", normalizeIdentityHash("0x" + "AB".repeat(32)), "0x" + HASH64);
eq("missing 0x prefix is added", normalizeIdentityHash(HASH64), "0x" + HASH64);

// ── isWellFormedIdentityHash ───────────────────────────────────────────────────
console.log("\nisWellFormedIdentityHash:");

check("canonical 0x+64hex is well-formed", isWellFormedIdentityHash("0x" + HASH64) === true);
check("undefined is not well-formed", isWellFormedIdentityHash(undefined) === false);
check("missing 0x is not well-formed", isWellFormedIdentityHash(HASH64) === false);
check("too short (63 hex) is not well-formed", isWellFormedIdentityHash("0x" + "a".repeat(63)) === false);
check("too long (65 hex) is not well-formed", isWellFormedIdentityHash("0x" + "a".repeat(65)) === false);
check("non-hex char (g) is not well-formed", isWellFormedIdentityHash("0x" + "g".repeat(64)) === false);
check("upper-case hex is not well-formed (we store lower)", isWellFormedIdentityHash("0x" + "A".repeat(64)) === false);

// Pipeline invariant: a normalized canonical hash is always well-formed.
check(
  "normalize then check is self-consistent for canonical input",
  isWellFormedIdentityHash(normalizeIdentityHash(HASH64)) === true,
);

// ── satSubU128 / satDec (the saturating primitives) ───────────────────────────
console.log("\nsatSubU128 / satDec:");

eq("satSubU128 normal", satSubU128(100n, 40n), 60n);
eq("satSubU128 exact-to-zero", satSubU128(100n, 100n), 0n);
eq("satSubU128 floors at 0n (never negative)", satSubU128(40n, 100n), 0n);
// u128 max round-trips with no Number precision loss
{
  const U128_MAX = (1n << 128n) - 1n;
  eq("satSubU128 u128-max - 1", satSubU128(U128_MAX, 1n), U128_MAX - 1n);
  eq("satSubU128 keeps full u128 precision", satSubU128(U128_MAX, 0n), U128_MAX);
}
eq("satDec normal", satDec(3), 2);
eq("satDec floors at 0", satDec(0), 0);
eq("decCount is satDec", decCount(0), 0);

// ── foldVote — the reverse-then-apply vote tally (mirrors vote / clear_vote) ───
console.log("\nfoldVote (vote tally fold):");

const ZERO: TallyState = zeroTally();
const up = (w: bigint): VoteSnapshot => ({ dir: "Up", weight: w });
const down = (w: bigint): VoteSnapshot => ({ dir: "Down", weight: w });

// first up-vote
eq("first up-vote", foldVote(ZERO, null, up(100n)), {
  upWeight: 100n, downWeight: 0n, upCount: 1, downCount: 0,
});
// first down-vote
eq("first down-vote", foldVote(ZERO, null, down(70n)), {
  upWeight: 0n, downWeight: 70n, upCount: 0, downCount: 1,
});
// re-vote SAME direction at a NEW weight: count stays 1, weight swaps 100 -> 250
{
  const after1 = foldVote(ZERO, null, up(100n));
  eq("re-vote same dir, new weight (count stays 1)", foldVote(after1, up(100n), up(250n)), {
    upWeight: 250n, downWeight: 0n, upCount: 1, downCount: 0,
  });
}
// flip Up -> Down: up side fully reversed, down side gains
{
  const after1 = foldVote(ZERO, null, up(100n));
  eq("flip Up -> Down", foldVote(after1, up(100n), down(60n)), {
    upWeight: 0n, downWeight: 60n, upCount: 0, downCount: 1,
  });
}
// clear (prev set, next null) -> back to zero
{
  const after1 = foldVote(ZERO, null, up(100n));
  eq("clear vote -> zero", foldVote(after1, up(100n), null), {
    upWeight: 0n, downWeight: 0n, upCount: 0, downCount: 0,
  });
}
// double-clear / reverse with nothing present: pure fns are identity / floor (no underflow)
eq("reverseVote of null is identity", reverseVote(ZERO, null), ZERO);
eq("applyVote of null is identity", applyVote(ZERO, null), ZERO);
// SATURATING FLOOR: reverse a stored weight LARGER than the running total (drift / out-of-order)
// floors at 0n and 0 count — NOT negative. This is the byte-parity-with-Rust saturating_sub test.
{
  const drift: TallyState = { upWeight: 40n, downWeight: 0n, upCount: 0, downCount: 0 };
  eq("reverse more weight than present floors at 0n; count floors at 0", reverseVote(drift, up(100n)), {
    upWeight: 0n, downWeight: 0n, upCount: 0, downCount: 0,
  });
}

// ── normalizeVoteDir ──────────────────────────────────────────────────────────
console.log("\nnormalizeVoteDir:");

eq("'Up' -> 'Up'", normalizeVoteDir("Up"), "Up");
eq("'Down' -> 'Down'", normalizeVoteDir("Down"), "Down");
eq("lower 'up' normalizes", normalizeVoteDir("up"), "Up");
eq("lower 'down' normalizes", normalizeVoteDir("down"), "Down");
eq("surrounding whitespace tolerated", normalizeVoteDir("  Up "), "Up");
{
  let threw = false;
  try { normalizeVoteDir("sideways"); } catch { threw = true; }
  check("unknown variant THROWS (not silently a down-vote)", threw);
}

// ── tallyScore (derived, may be negative) ─────────────────────────────────────
console.log("\ntallyScore:");

eq("score positive", tallyScore({ upWeight: 30n, downWeight: 10n, upCount: 1, downCount: 1 }), 20n);
eq("score negative", tallyScore({ upWeight: 10n, downWeight: 30n, upCount: 1, downCount: 1 }), -20n);
eq("negative score stringifies with leading -", tallyScore({ upWeight: 10n, downWeight: 30n, upCount: 0, downCount: 0 }).toString(), "-20");
eq("score zero", tallyScore(ZERO), 0n);

// ── poll per-option fold (mirrors cast_poll_vote) ─────────────────────────────
console.log("\npoll option fold:");

const ZERO_OPT: OptionState = { weight: 0n, count: 0 };
// first cast on an option
eq("first poll cast on an option", applyOption(ZERO_OPT, 100n), { weight: 100n, count: 1 });
// SAME-OPTION re-cast: reverse then apply on ONE option object -> weight swaps, count stays 1
{
  const opt = applyOption(ZERO_OPT, 100n); // {100,1}
  const recast = applyOption(reverseOption(opt, 100n), 300n);
  eq("poll same-option re-cast (count stays 1)", recast, { weight: 300n, count: 1 });
}
// CROSS-OPTION re-cast: previous option reversed to zero, new option gains
{
  const optA = applyOption(ZERO_OPT, 100n); // option 0 -> {100,1}
  const optB = ZERO_OPT; // option 2 -> {0,0}
  eq("poll cross-option recast: old option reversed", reverseOption(optA, 100n), { weight: 0n, count: 0 });
  eq("poll cross-option recast: new option applied", applyOption(optB, 100n), { weight: 100n, count: 1 });
}
// saturating floor on option reverse
eq("poll option reverse floors at 0", reverseOption({ weight: 40n, count: 0 }, 100n), { weight: 0n, count: 0 });

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? "✓" : "✗"} pure.test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
