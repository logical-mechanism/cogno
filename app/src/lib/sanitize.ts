// sanitize — display-time hardening for attacker-controlled user text (client safety).
//
// The chain stores RAW BYTES. `pallet-profile::set_profile` and `pallet-microblog` bound a field's
// LENGTH only (feelessly) and validate NO characters, and the read path trims just the ends — so any
// code point an attacker can type survives all the way to the DOM (see the same note in `lib/mentions`).
// A malicious poster does not even need this frontend: the CLI writes the same bytes. So the ONLY place
// this class of abuse can be contained is at the render boundary, on THIS device — client safety, not
// moderation.
//
// This is NOT about XSS. React already escapes markup and no render path uses dangerouslySetInnerHTML,
// so script injection is already impossible. This defends against the VISUAL / layout attacks React does
// nothing to stop:
//
//   • BIDIRECTIONAL CONTROLS (Trojan Source, CVE-2021-42574). U+202A–202E / U+2066–2069 / U+200E–200F /
//     U+061C reorder the surrounding glyphs, so a name, handle or URL can RENDER as text that is not its
//     bytes — a mention / link / address spoof. We STRIP the explicit formatting + isolate + mark codes.
//     Genuine RTL (Arabic / Hebrew) needs none of them — the Unicode bidi algorithm derives direction
//     from the letters themselves — and the render boundary sets dir="auto" so real RTL still lays out.
//   • INVISIBLE / DEFAULT-IGNORABLE SEPARATORS. Zero-width space, word-joiner + invisible-math + deprecated
//     format codes (U+2060–206F), BOM, Mongolian vowel separator, soft-hyphen, interlinear annotation
//     (U+FFF9–FFFB) and the archaic Hangul / half-width fillers all render as nothing but split / pad text
//     (invisible padding, word-count games, blank-name / look-alike spoofs) — STRIPPED. U+200C ZWNJ /
//     U+200D ZWJ and the variation selectors are KEPT (load-bearing in emoji ZWJ sequences and Arabic /
//     Indic shaping) but bounded by the caps below. The emoji TAG block (U+E0000–E007F) is deliberately NOT
//     stripped — subdivision-flag emoji (England / Scotland / Wales) are legitimate tag sequences and the
//     residual is invisible (no visual harm), defeated anyway by the ss58 shown beside every name.
//   • ZALGO. Stacking dozens of combining marks (categories Mn / Me) on one base overflows the line box and
//     paints over neighbouring UI. We cap the marks per GRAPHEME CLUSTER to MAX_MARKS. Counting per cluster
//     (not per consecutive run) closes the "interleave a kept ZWJ to reset the counter" bypass — ZWJ/ZWNJ +
//     marks stay one cluster, so every mark on a single base is counted together. Even the busiest real text
//     (decomposed Vietnamese, fully-pointed Masoretic Hebrew, vocalised Arabic) stays under the cap. SPACING
//     marks (Mc, e.g. Devanagari vowel signs) take horizontal room and are legitimate — NOT capped. A
//     hoarded run of ZWJ/ZWNJ (never adjacent in valid text) is collapsed to MAX_JOINERS.
//   • OTHER CONTROLS. C0 / C1 control codes are stripped, except the whitespace (\t \n \r) a body carries.
//
// Pure + framework-free, unit-tested. IDEMPOTENT: sanitize(sanitize(x)) === sanitize(x), so applying it at
// more than one layer (defense in depth) never compounds. DISPLAY-ONLY — never sanitize before a byte-length
// count, an on-chain write, or the search path (`lib/search` stays byte-comparable with the node's raw scan
// on purpose).

// Explicit bidi formatting (LRE/RLE/PDF/LRO/RLO), isolates (LRI/RLI/FSI/PDI), and marks (LRM/RLM/ALM) —
// the reordering codes. Stripped outright.
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu;

// Invisible / default-ignorable separators that render as nothing but split / pad text: ZWSP, the
// word-joiner + invisible-math + deprecated format block (U+2060–206F), BOM, Mongolian vowel separator,
// soft-hyphen, interlinear annotation (U+FFF9–FFFB), and the archaic Hangul / half-width fillers. ZWJ
// (U+200D), ZWNJ (U+200C) and the variation selectors are EXCLUDED (they shape emoji / Indic / Arabic) and
// bounded by the caps below. The emoji TAG block (U+E0000–E007F) is NOT stripped (subdivision-flag emoji).
const INVISIBLE_RE = /[\u200B\u2060-\u206F\uFEFF\u180E\u00AD\u115F\u1160\u3164\uFFA0\uFFF9-\uFFFB]/gu;

// C0 / C1 control characters, KEEPING the whitespace a multi-line body legitimately uses (\t \n \r).
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

// A single nonspacing (Mn) or enclosing (Me) combining mark — the Zalgo stackers. Spacing marks (Mc) are
// deliberately excluded. Stateless (no /g), so `.test` is safe to reuse.
const COMBINING_RE = /[\p{Mn}\p{Me}]/u;

// A blank-but-printable filler that JS \s does NOT cover (braille blank cell). Stripped from single-line
// identity fields only — it is legitimate content inside a braille post body.
const INLINE_BLANK_RE = /[\u2800]/gu;

const ZWNJ = "\u200C";
const ZWJ = "\u200D";

/** Max nonspacing / enclosing combining marks kept per grapheme cluster (above this = Zalgo). Chosen to
 *  clear the busiest legitimate stack — pointed Masoretic Hebrew / vocalised Syriac reach ~5–6. */
export const MAX_MARKS = 8;

/** Max consecutive ZWJ / ZWNJ kept — in valid text these are never even adjacent, so 2 is generous. */
export const MAX_JOINERS = 2;

// > MAX_JOINERS consecutive joiners = hoarding; collapse the run back to the cap.
const JOINER_RUN_RE = new RegExp(`[${ZWNJ}${ZWJ}]{${MAX_JOINERS + 1},}`, "gu");

// Intl.Segmenter is ES2022; the project's tsconfig `lib` is ES2020, so reach it through a minimal local
// type + runtime guard rather than widening the whole project's lib. The fallback in `clampStacks` covers
// any engine that genuinely lacks it (older Firefox before 125, older Safari).
interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}
const SegmenterCtor = (
  Intl as {
    Segmenter?: new (locales?: string, options?: { granularity: "grapheme" }) => GraphemeSegmenter;
  }
).Segmenter;
const segmenter =
  typeof SegmenterCtor === "function"
    ? new SegmenterCtor(undefined, { granularity: "grapheme" })
    : null;

/** Keep at most MAX_MARKS Mn/Me marks within one grapheme cluster; drop the excess stackers. */
function clampCluster(cluster: string): string {
  let marks = 0;
  let out = "";
  for (const ch of cluster) {
    if (COMBINING_RE.test(ch)) {
      marks += 1;
      if (marks > MAX_MARKS) continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Cap combining marks per GRAPHEME CLUSTER. Using Intl.Segmenter closes the "interleave a kept ZWJ to
 * reset the counter" bypass a per-consecutive-run cap has — ZWJ/ZWNJ + marks stay one cluster, so every
 * mark on a single base is counted together. Falls back to a per-run cap (treating ZWJ/ZWNJ as
 * transparent — they neither count as a mark nor reset the run) on engines without Intl.Segmenter.
 */
function clampStacks(s: string): string {
  if (segmenter) {
    let out = "";
    for (const { segment } of segmenter.segment(s)) out += clampCluster(segment);
    return out;
  }
  let out = "";
  let markRun = 0;
  for (const ch of s) {
    if (COMBINING_RE.test(ch)) {
      markRun += 1;
      if (markRun > MAX_MARKS) continue;
    } else if (ch !== ZWJ && ch !== ZWNJ) {
      markRun = 0;
    }
    out += ch;
  }
  return out;
}

/**
 * Harden a possibly MULTI-LINE body (posts, bios): strip bidi / invisible / control codes, clamp Zalgo and
 * collapse hoarded joiners, KEEPING legitimate line breaks and tabs (rendered under `white-space: pre-wrap`).
 */
export function sanitizeText(input: string): string {
  if (!input) return input;
  const stripped = input.replace(BIDI_RE, "").replace(INVISIBLE_RE, "").replace(CONTROL_RE, "");
  // Clamp first, THEN collapse joiner runs — dropping excess marks can leave the run's joiners adjacent,
  // and collapsing after keeps the whole thing idempotent.
  return clampStacks(stripped).replace(JOINER_RUN_RE, (m) => m.slice(0, MAX_JOINERS));
}

/**
 * Harden a SINGLE-LINE field (display names, locations, poll options, link labels, hidden-post snippets):
 * {@link sanitizeText} plus strip the braille blank cell and collapse ALL whitespace (including newlines,
 * tabs, NBSP and the Unicode line / paragraph separators `\s` covers) to single spaces, then trim. A
 * one-line field must never carry a break or a blank-cell pad — a display name with 60 newlines, or one
 * built from blank cells, would otherwise blow up or spoof every row that renders it.
 */
export function sanitizeInline(input: string): string {
  if (!input) return input;
  return sanitizeText(input).replace(INLINE_BLANK_RE, "").replace(/\s+/g, " ").trim();
}
