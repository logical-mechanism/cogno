// postText — the ONE tokenizer that splits a post body into renderable segments.
//
// This lived inside PostBody.tsx as module-private code until topics needed it. It is extracted rather
// than re-implemented because render and parse MUST agree exactly: if a topic parser used its own regex,
// a body could render a linkified `#cardano` while being absent from the `#cardano` topic feed (or the
// reverse). One tokenizer, both callers.
//
// Pure: text in, plain segment objects out. No React, no DOM — so it is unit-testable and safe to call
// from the data layer (lib/topics) as well as from the renderer.
//
// The caller is responsible for handing us SANITIZED text (lib/sanitize `sanitizeText`). PostBody does
// that already, and `lib/topics` does it too — see the note on `Seg` below for why it matters.

import { isImageUrl, URL_RE, TRAILING_PUNCT } from "@/lib/media";
import { validSs58Prefix } from "@/lib/mentions";

/**
 * TOKEN_RE matches, inside a PLAIN-TEXT run (never inside a matched URL — so `https://x.org/#section`
 * and `https://x.org/@handle` are never re-tokenized), either:
 *   - a #hashtag: '#' + Unicode letters/numbers/underscore, or
 *   - a mention candidate: '@' + a ≥44-char base58 run (checksum-validated below via validSs58Prefix).
 */
export const TOKEN_RE = /#[\p{L}\p{N}_]+|@[1-9A-HJ-NP-Za-km-z]{44,}/gu;

/**
 * One run of a tokenized body.
 *
 * IMPORTANT: segment boundaries are computed over whatever string you pass in. Pass SANITIZED text —
 * `sanitizeText` strips the invisible separators (ZWSP and friends) that would otherwise let
 * `#car<ZWSP>dano` tokenize as two junk runs on the parse path while rendering as `#cardano` to the eye.
 */
export interface Seg {
  kind: "text" | "url" | "image" | "hashtag" | "mention";
  /** the run text (text/url/image/hashtag, hashtag INCLUDING its leading '#'); for a mention, the
   *  canonical prefix-42 ss58. */
  value: string;
}

/** Push a plain-text run onto `segs`, further split into text + #hashtag + @mention segments. */
function pushText(segs: Seg[], text: string): void {
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    const tok = m[0];
    if (tok[0] === "@") {
      // Only a checksum-valid ss58 PREFIX linkifies; a look-alike run stays plain text. A base58 char
      // glued to the address (no separator) is not consumed — validSs58Prefix returns just the address.
      const hit = validSs58Prefix(tok.slice(1));
      if (!hit) continue; // leave as plain text — emitted by the next slice / final tail
      if (start > last) segs.push({ kind: "text", value: text.slice(last, start) });
      segs.push({ kind: "mention", value: hit.ss58 });
      last = start + 1 + hit.length; // consumed '@' + the address only
      continue;
    }
    if (start > last) segs.push({ kind: "text", value: text.slice(last, start) });
    segs.push({ kind: "hashtag", value: tok });
    last = start + tok.length;
  }
  if (last < text.length) segs.push({ kind: "text", value: text.slice(last) });
}

/** Split a body into plain-text + url + image + hashtag + mention segments (pure; no DOM). */
export function segment(text: string): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let url = m[0];
    // Re-attach trailing sentence punctuation that isn't part of the URL to the following text run.
    const trail = url.match(TRAILING_PUNCT)?.[0] ?? "";
    if (trail) url = url.slice(0, url.length - trail.length);
    if (start > last) pushText(segs, text.slice(last, start));
    segs.push({ kind: isImageUrl(url) ? "image" : "url", value: url });
    if (trail) segs.push({ kind: "text", value: trail });
    last = start + m[0].length;
  }
  if (last < text.length) pushText(segs, text.slice(last));
  return segs;
}
