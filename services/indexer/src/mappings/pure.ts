// ── PURE mapping logic ───────────────────────────────────────────────────────
// Decoding/normalization extracted from mappingHandlers.ts so it is UNIT-TESTABLE with no
// dependency on the @subql runtime globals (`api`/`store`/`logger`) or @polkadot codecs.
// Every function here takes plain inputs (Uint8Array/number/string/bigint) and returns plain
// values. mappingHandlers.ts pulls the raw values off the codecs and delegates here, so the
// ON-CHAIN behavior (what gets stored) is byte-identical — these are the only branches that
// decide text/timestamp/parent contents.

/**
 * UTF-8 decode of a post body's bare bytes (`Microblog.Posts.text`, BoundedVec<u8>).
 *
 * Mirrors the codec dispatch in textToUtf8(): a codec exposing `toUtf8()` is trusted to decode
 * itself; otherwise we decode the bare bytes (`toU8a(true)`) ourselves. This function is the
 * fallback path — it takes the already-extracted bytes.
 *
 * Robust to malformed/truncated UTF-8: Node's Buffer.toString("utf8") (and TextDecoder) never
 * throw on bad bytes — they substitute U+FFFD — so a corrupted on-chain body becomes visible
 * replacement glyphs rather than a thrown error that would halt indexing on a single bad post.
 * A null/undefined byte source yields "" (an absent body, not a crash).
 */
export function utf8FromBytes(bytes: Uint8Array | null | undefined): string {
  if (!bytes) return "";
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The decision a corrupt/missing block timestamp forces (blockTimestamp's fallback).
 *
 * Given a raw milliseconds value (already pulled off whatever codec/source), decide the Date to
 * store and whether we had to FALL BACK to epoch 0. The contract: a timestamp is valid iff it is
 * a finite, positive integer-ish number of ms. Anything else (0, negative, NaN, Infinity,
 * null/undefined, non-numeric) is NOT a real wall-clock and triggers the epoch-0 fallback — which
 * the caller must log loudly because `new Date(0)` (1970-01-01) silently corrupts recency ordering
 * and verify-m4c does not fold timestamp, so it would pass the gate undetected.
 *
 * @returns {date} the Date to store, {didFallback} true iff `raw` was not a usable ms value.
 */
export function timestampDecision(
  raw: number | null | undefined,
): { date: Date; didFallback: boolean } {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return { date: new Date(raw), didFallback: false };
  }
  return { date: new Date(0), didFallback: true };
}

/**
 * Normalize an optional parent post id to the stored form: a non-empty string, or undefined for a
 * top-level post (which becomes a NULL `parentId` column). Empty/whitespace-only ids collapse to
 * undefined so a missing parent never produces a dangling FK to id "".
 */
export function normalizeParentId(
  parentId: string | null | undefined,
): string | undefined {
  if (parentId == null) return undefined;
  const trimmed = parentId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize an identity hash to its stored 0x-hex form (CognoGate.IdentityLinked `identity`,
 * [u8;32] == beacon token_name, DR-01). Accepts the codec's `toHex()` output and guarantees a
 * lower-cased, 0x-prefixed string. Returns undefined for an absent value so an unbound author keeps
 * a NULL `identityHash`.
 */
export function normalizeIdentityHash(
  hex: string | null | undefined,
): string | undefined {
  if (hex == null) return undefined;
  const trimmed = hex.trim();
  if (trimmed.length === 0) return undefined;
  const lower = trimmed.toLowerCase();
  return lower.startsWith("0x") ? lower : "0x" + lower;
}

/**
 * Whether an identity hash has the on-chain shape: 0x + 64 lower-case hex chars (a [u8;32]).
 * Used only to gate a WARN — a wrong-length hash still gets stored (the chain is the source of
 * truth) but it signals a codec/upgrade mismatch worth an operator's attention.
 */
export function isWellFormedIdentityHash(hex: string | null | undefined): boolean {
  return typeof hex === "string" && /^0x[0-9a-f]{64}$/.test(hex);
}

// ── STAKE-WEIGHTED TALLY FOLD ─────────────────────────────────────────────────
// The deterministic reverse-then-apply that mirrors pallets/microblog `vote` / `clear_vote` /
// `cast_poll_vote` BYTE-FOR-BYTE. Votes + poll-votes are stake-weighted AND changeable: on every
// (re)vote/clear the runtime REVERSES the voter's PREVIOUSLY-STORED weight then APPLIES the fresh
// one, all with saturating arithmetic. The indexer folds ONLY the events (keeping a per-(target,
// voter) record of the last {choice,weight}); verify-m4c re-derives the same independently. These
// pure fns hold the arithmetic so it is unit-tested with no @subql/@polkadot runtime — they are the
// SOLE place the tally math lives, so the handler and the tests can never drift from each other.

/** A post's vote tally snapshot — all plain values (u128 weights as bigint, u32 counts as number). */
export interface TallyState {
  upWeight: bigint;
  downWeight: bigint;
  upCount: number;
  downCount: number;
}

/** One stored vote: its direction + the weight snapshot the tally was adjusted by. */
export interface VoteSnapshot {
  dir: "Up" | "Down";
  weight: bigint;
}

/**
 * Normalize a decoded `VoteDir` codec string to the canonical `"Up"`/`"Down"`. The fold branches on
 * exact equality (`dir === "Up"`), so a casing drift across @polkadot/api versions (`"up"`, `"Up"`)
 * would silently mis-bucket a vote — pin it here, used identically by the handler (before `foldVote`
 * + storing `Vote.dir`) and by verify-m4c. THROWS on an unknown variant (a codec/upgrade mismatch is
 * not silently a down-vote).
 */
export function normalizeVoteDir(raw: string | null | undefined): "Up" | "Down" {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "up") return "Up";
  if (s === "down") return "Down";
  throw new Error(`unknown VoteDir variant: ${JSON.stringify(raw)}`);
}

/** A zero tally (an unvoted post). */
export function zeroTally(): TallyState {
  return { upWeight: 0n, downWeight: 0n, upCount: 0, downCount: 0 };
}

/**
 * Saturating u128 subtraction: `a - b`, floored at 0n. Mirrors Rust `u128::saturating_sub` exactly
 * — reversing a stored weight larger than the running total (drift / out-of-order) floors at 0, it
 * never goes negative. This is the single most safety-critical line for byte-parity with the chain.
 */
export function satSubU128(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

/** Saturating u32 decrement: `n - 1`, floored at 0. Mirrors Rust `u32::saturating_sub(1)`. */
export function satDec(n: number): number {
  return n > 0 ? n - 1 : 0;
}

/** Plain increment (counts only ever grow by 1 on apply; the chain uses `saturating_add(1)`). */
export function inc(n: number): number {
  return n + 1;
}

/** Reverse a single stored vote from a tally (saturating on both weight and count). No-op for null. */
export function reverseVote(t: TallyState, prev: VoteSnapshot | null | undefined): TallyState {
  if (!prev) return t;
  if (prev.dir === "Up") {
    return { ...t, upWeight: satSubU128(t.upWeight, prev.weight), upCount: satDec(t.upCount) };
  }
  return { ...t, downWeight: satSubU128(t.downWeight, prev.weight), downCount: satDec(t.downCount) };
}

/** Apply a single fresh vote to a tally (saturating_add on weight; +1 on count). No-op for null. */
export function applyVote(t: TallyState, next: VoteSnapshot | null | undefined): TallyState {
  if (!next) return t;
  if (next.dir === "Up") {
    return { ...t, upWeight: t.upWeight + next.weight, upCount: inc(t.upCount) };
  }
  return { ...t, downWeight: t.downWeight + next.weight, downCount: inc(t.downCount) };
}

/**
 * The full vote fold: REVERSE the previously-stored vote (if any) then APPLY the new one (if any).
 *   - first vote:   prev=null, next={dir,w}
 *   - re-vote/flip: prev={...}, next={dir,w}   (reverse old, apply new — count nets correctly)
 *   - clear:        prev={...}, next=null
 * Mirrors `vote` (prev=Votes::get, next=fresh) and `clear_vote` (prev=Votes::take, next=None).
 */
export function foldVote(
  t: TallyState,
  prev: VoteSnapshot | null | undefined,
  next: VoteSnapshot | null | undefined,
): TallyState {
  return applyVote(reverseVote(t, prev), next);
}

/** Derived post score = upWeight - downWeight. MAY be negative. Kept as bigint (never Number). */
export function tallyScore(t: TallyState): bigint {
  return t.upWeight - t.downWeight;
}

// ── POLL PER-OPTION TALLY FOLD ────────────────────────────────────────────────
// `cast_poll_vote` reverses the PREVIOUS option's tally by the stored weight, then applies the fresh
// weight to the chosen option. When the re-cast keeps the same option, both steps land on ONE option
// (reverse then apply on the same OptionState) — the handler must fold on a single object to match.

/** One poll option's stake-weighted tally. */
export interface OptionState {
  weight: bigint;
  count: number;
}

/** Reverse a stored poll choice from its option (saturating weight + count). */
export function reverseOption(o: OptionState, prevWeight: bigint): OptionState {
  return { weight: satSubU128(o.weight, prevWeight), count: satDec(o.count) };
}

/** Apply a fresh poll choice to its option (add weight + 1 count). */
export function applyOption(o: OptionState, weight: bigint): OptionState {
  return { weight: o.weight + weight, count: inc(o.count) };
}

// ── FOLLOW COUNTERS ───────────────────────────────────────────────────────────
// Followed/Unfollowed fold simple inc/dec counters (NOT stake-weighted). dec is saturating at 0 to
// mirror the chain's `FollowerCount`/`FollowingCount` `saturating_sub(1)` (defensive — the chain
// guarantees an Unfollowed only fires for an existing edge).

/** Saturating decrement for a follow counter. */
export function decCount(n: number): number {
  return satDec(n);
}
