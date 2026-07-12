// search — shared helpers for the query text that drives the Explore search (surface 10) and the
// RightRail box. The node runs a raw-byte ASCII-case-insensitive substring scan over un-normalized
// stored text, so we deliberately do NOT Unicode-normalize the query (that would rewrite an NFD term
// to NFC and stop it byte-matching NFD-authored content). We only trim + collapse whitespace, which
// keeps the ?q= URL, the client cache key, and the result set stable across "a  b" vs "a b".

/** Minimum committed query length before we run a scan — a 1-char ASCII term matches near-everything
 *  and isn't worth the node's linear scan. Below this the UI stays in DEFAULT with a "keep typing"
 *  hint. (A pasted address / identity hash short-circuits to a profile before this gate.) */
export const MIN_QUERY_LEN = 2;

/**
 * Canonicalize a raw query string: collapse every internal whitespace run to a single space and trim
 * the ends. Idempotent. NOT Unicode-normalized (see the file header) so it stays byte-comparable with
 * the node's scan. Used wherever a query is committed (URL write, people search).
 */
export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * True for a normalized term that is non-empty but too short to run a scan for (the "keep typing"
 * state). Only ASCII terms are gated: a single CJK/ideograph is a complete word the node can match, so
 * blocking it would be a real regression — only Latin single characters are the noisy case. Callers
 * exempt pasted addresses / identity hashes, which route to a profile regardless.
 */
export function isQueryTooShort(normalized: string): boolean {
  if (!/^[\x00-\x7F]*$/.test(normalized)) return false; // any non-ASCII char → searchable at length 1
  const codePoints = [...normalized].length;
  return codePoints > 0 && codePoints < MIN_QUERY_LEN;
}
