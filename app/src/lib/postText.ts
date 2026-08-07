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

/**
 * How many image segments a body renders as a full-size reveal block before the rest collapse to
 * plain links.
 *
 * This is a FLOOD CAP, not a style preference. An image block is `max-width: 360px` at `aspect-ratio:
 * 16/9` (~203px tall) and an image segment costs as little as EIGHT bytes to write — `ipfs://a` is a
 * bare CID with no extension, which `isImageUrl` assumes is an image. So a single 512-byte post packs
 * 56 blocks ≈ 11 800px, roughly thirteen desktop screens, and the reveal cover does not help: it gates
 * the FETCH, not the LAYOUT, so the space is claimed before anyone clicks. That is a timeline takeover
 * aimable at the global feed, a single thread (as a reply), or a quote card.
 *
 * One, because the honest common case is one image and the second block is already a third of a
 * screen. The overflow is not hidden — see {@link capImageSegments}.
 */
export const MAX_IMAGE_BLOCKS = 1;

/**
 * How many further image blocks each press of the expander reveals.
 *
 * The expander is a STEP, not an "unhide everything" switch, and that is the whole point of the cap:
 * revealing all 56 blocks on one press would just move the 13 000px wall one click away rather than
 * remove it. Three, so the ordinary case resolves in a single press — a real multi-photo post is one to
 * four images — while a flood stays something the reader keeps choosing to load rather than something
 * that happens to them.
 */
export const IMAGE_REVEAL_STEP = 3;

/**
 * The expander's label: what THIS press will reveal, plus the scale of what is left.
 *
 * Naming both is deliberate on two counts. It keeps the button honest — it steps, so a label promising
 * all 55 would lie about what the press does. And the remaining count is the reader's only signal that
 * a post is a flood rather than a photo album: "Show 3 more images (55 hidden)" says what happened here
 * without the page having to render it.
 */
export function expanderLabel(hidden: number): string {
  if (hidden === 0) return "Show more"; // a height-clamped body with no held-back images
  if (hidden === 1) return "Show 1 more image";
  if (hidden <= IMAGE_REVEAL_STEP) return `Show ${hidden} more images`;
  return `Show ${IMAGE_REVEAL_STEP} more images (${hidden} hidden)`;
}

/**
 * Drop every image segment past `cap`, and report how many were hidden.
 *
 * HIDDEN, NOT DEMOTED TO LINKS. The first version turned them into `url` segments so "no content is
 * lost" — which was wrong in practice: an ordinary four-photo post then rendered one image followed by
 * three lines of raw URL text, which reads as broken rather than as trimmed. Nothing is actually lost by
 * hiding them, because the expander restores every block on request and each block links to its own URL.
 *
 * Order is preserved and non-image segments are untouched, so the FIRST image in reading order is the
 * one kept — the one an ordinary post meant to lead with. The caller offers an expander that re-renders
 * with `cap: Infinity`.
 */
export function capImageSegments(segs: Seg[], cap: number): { segs: Seg[]; hidden: number } {
  let seen = 0;
  let hidden = 0;
  const out = segs.filter((s) => {
    if (s.kind !== "image") return true;
    seen += 1;
    if (seen <= cap) return true;
    hidden += 1;
    return false;
  });
  // Nothing hidden ⇒ hand back the ORIGINAL array, so `useMemo` consumers keep referential equality and
  // the overwhelmingly common (0- or 1-image) post re-renders exactly as it did before.
  return hidden === 0 ? { segs, hidden: 0 } : { segs: out, hidden };
}

/**
 * How many lines a body renders before it is height-clamped behind the same expander.
 *
 * The image cap above closes the AMPLIFIED flood; this closes the plain one. A body is rendered under
 * `white-space: pre-wrap`, so every newline the author wrote costs a line — and a newline is ONE byte.
 * `a` + 510 newlines + `b` is a legal 512-byte post that renders ~511 lines ≈ 10 200px, about ten
 * desktop screens, with no images and no cleverness at all.
 *
 * Counting the author's OWN newlines is sufficient and needs no DOM measurement: 512 bytes of prose
 * wraps to ~10 lines in a 560px column, so nothing but explicit newlines can reach this cap. 16 lines
 * clears a long paragraph, a short list or a stanza untouched.
 */
export const MAX_BODY_LINES = 16;

/** True when `text` carries more than `cap` lines — the height-clamp predicate. Early-exits. */
export function exceedsLineCap(text: string, cap: number = MAX_BODY_LINES): boolean {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" && ++lines > cap) return true;
  }
  return false;
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
