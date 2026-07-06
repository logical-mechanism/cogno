// search — shared helpers for the query text that drives the Explore search (surface 10) and the
// RightRail box. The node runs an ASCII-case-insensitive substring scan, so the ONLY normalization
// that matters for matching is whitespace + Unicode form: a canonical query keeps the ?q= URL, the
// client cache key, and the result set stable across "a  b" vs "a b" and NFC/NFD-equivalent accents.

/** Minimum committed query length before we run a scan — a 1-char term matches near-everything and
 *  isn't worth the node's linear scan. Below this the UI stays in DEFAULT with a "keep typing" hint.
 *  (A pasted address / identity hash short-circuits to a profile before this gate — length-exempt.) */
export const MIN_QUERY_LEN = 2;

/**
 * Canonicalize a raw query string: trim the ends, collapse every internal whitespace run to a single
 * space, and NFC-normalize. Idempotent. Used at every point a query is committed (URL write, people
 * search) so equivalent inputs share one URL / cache key / result set.
 */
export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().normalize("NFC");
}

/** True for a normalized term that is non-empty but too short to run a scan for (the "keep typing"
 *  state). Callers exempt pasted addresses / identity hashes, which route to a profile regardless. */
export function isQueryTooShort(normalized: string): boolean {
  return normalized.length > 0 && normalized.length < MIN_QUERY_LEN;
}
