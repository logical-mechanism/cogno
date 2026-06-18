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
