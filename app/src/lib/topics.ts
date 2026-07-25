// topics — hashtag/topic semantics. A "topic" on this chain is a CONVENTION, not a chain field: there
// is no tag column on `Post` and no `PostsByTag` index. A topic feed is the node's existing
// case-insensitive substring search (`MicroblogApi.search_posts`) for `#tag`, narrowed client-side to an
// EXACT tag match. Nothing here is written to the chain.
//
// Why convention and not an on-chain tag field: every post already in the ledger carries its `#tags` in
// its text. An explicit tag field would be invisible to the whole existing corpus unless a migration
// re-parsed post bodies IN-RUNTIME — a consensus-critical Unicode tokenizer that could never agree
// byte-for-byte with the `\p{L}\p{N}_` regex the client uses. So the text IS the index.
//
// THE CASE FOLD IS ASCII-ONLY, AND THAT IS DELIBERATE. The node matches with `eq_ignore_ascii_case`
// (a raw-byte scan over un-normalized stored text), so `é` and `É` are different bytes to it. Folding
// with `toLowerCase()` here would canonicalize `#CAFÉ` → `#café` and then ask the node for a term it
// cannot match, producing a topic that renders in the body but yields an empty feed. We fold A–Z only —
// the same fold `Highlight`/`asciiLower` performs — which means `#café` and `#CAFÉ` are permanently two
// distinct topics. That is a real limitation of an ASCII-folding node scan; the UI says so rather than
// pretending otherwise.

import { sanitizeText } from "@/lib/sanitize";
import { segment } from "@/lib/postText";

/**
 * Longest topic we accept. Not a chain bound (there is no chain field) — it bounds what we will put in a
 * URL and in device-local storage, and keeps a pathological 4000-char "tag" out of both.
 */
export const TOPIC_MAX_LEN = 64;

/** A canonical topic: Unicode letters/numbers/underscore, no leading '#', within the length bound. */
const TOPIC_RE = new RegExp(`^[\\p{L}\\p{N}_]{1,${TOPIC_MAX_LEN}}$`, "u");

/**
 * Lowercase only ASCII A–Z, leaving every non-ASCII code point untouched — the exact fold the node's
 * `eq_ignore_ascii_case` performs. Length-preserving. Mirrors `asciiLower` in components/Highlight.
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Canonicalize a raw tag (with or without a leading '#') to its storage/URL form: no '#', ASCII-folded.
 * Returns null when it is not a valid topic — empty, over-long, or carrying anything but
 * letters/numbers/underscore. Callers MUST treat null as "not a topic" rather than coercing it.
 */
export function canonicalTag(raw: string): string | null {
  const bare = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!TOPIC_RE.test(bare)) return null;
  return asciiLower(bare);
}

/** True for an already-canonical topic — the storage validator (`isValid`) for the followed-topic set. */
export function isCanonicalTag(value: string): boolean {
  return TOPIC_RE.test(value) && asciiLower(value) === value;
}

/** The `#tag` display form of a canonical topic. */
export function tagLabel(topic: string): string {
  return `#${topic}`;
}

/** The search term that finds a topic — what goes in `?q=` and what the node substring-scans for. */
export function tagSearchTerm(topic: string): string {
  return `#${topic}`;
}

/**
 * The canonical topics mentioned in a post body, in first-appearance order, deduped.
 *
 * Sanitizes internally: an invisible separator inside a tag (`#car<ZWSP>dano`) renders as `#cardano` to
 * the reader, so the parse path has to see the same string the renderer does or the post would be
 * missing from its own topic's feed. `sanitizeText` is idempotent, so passing already-sanitized text is
 * safe and callers cannot get this wrong.
 */
export function parseTopics(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seg of segment(sanitizeText(body))) {
    if (seg.kind !== "hashtag") continue;
    const topic = canonicalTag(seg.value);
    if (topic === null || seen.has(topic)) continue;
    seen.add(topic);
    out.push(topic);
  }
  return out;
}

/**
 * When a committed search query is EXACTLY one hashtag token, the topic it names — else null.
 *
 * This is what turns `/explore/?q=%23cardano` into a topic surface without adding a fourth `mode` to
 * Explore's derived state machine: the query is still a plain search, and the topic header is rendered
 * off this derived value. A multi-term query (`#a #b`, `#a foo`) is NOT a topic — it stays a search.
 */
export function topicOfQuery(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed.startsWith("#") || /\s/.test(trimmed)) return null;
  return canonicalTag(trimmed);
}

/**
 * Does `body` carry `topic` exactly?
 *
 * The node's substring scan for `#cardano` is a SUPERSET of the topic: it also matches `#cardanoNFT`
 * (a longer tag) and `https://x.org/#cardano` (a URL fragment, which the tokenizer classifies as a URL
 * and never linkifies). Re-filtering the returned page against the real tokenizer turns that superset
 * into an exact topic feed at zero chain cost.
 */
export function bodyHasTopic(body: string, topic: string): boolean {
  return parseTopics(body).includes(topic);
}
