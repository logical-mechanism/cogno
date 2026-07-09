// lib/mentions — pure @mention serialize/parse for the ss58-in-body mention model (no chain field).
//
// A mention refers to a PERSON by their UNIQUE AccountId, encoded in the post BODY as `@<full-ss58>`.
// There is no scarce username namespace and no side-field on a Post: the body IS the message, so a
// mention is self-describing — any client parses an ss58 in a body and renders it as a mention, with
// zero coordination (`parseMentionBody`). The composer shows a friendly `@displayName` DISPLAY token
// while the user types; on submit that token is expanded to `@<ss58>` (`serializeMentions`).
//
// display-token vs stored-value: the user sees `@elon`, the stored bytes are `@<48-char-ss58>`. Each
// serialized mention is ~49 bytes against the 512-byte body cap, so the composer's byte meter MUST
// count the SERIALIZED length (see Composer), or a post that looks short fails the runtime `TooLong`.
//
// Pure + framework-free (unit-tested): the serialize/parse round-trip is the CROSS-CLIENT INTEROP
// contract, so it must be deterministic and reversible.

import { normalizeSs58 } from "./ss58";
import type { Ss58 } from "./types";

/** A resolved mention picked in the composer: an account + the display text shown for it. */
export interface MentionRef {
  /** Canonical prefix-42 ss58 of the mentioned account (the stored value). */
  ss58: Ss58;
  /** The display text shown after the `@` in the editor (e.g. "elon"), UNIQUE within one draft. */
  display: string;
}

/** The `@display` token inserted into the editor for a picked mention. */
export function mentionToken(display: string): string {
  return `@${display}`;
}

/** True for a character that could be part of a name/handle run (so a mention token can't be a prefix
 *  of a longer word the user kept typing, e.g. `@elon` inside `@elonx`). */
function isNameCont(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * Expand each `@display` token in `text` to `@<ss58>` using the picked mentions. Left-to-right single
 * pass; at each `@`, the LONGEST matching display wins (so "elon musk" is matched before "elon"), and
 * a match is only taken when the token is followed by a non-name character (end-of-string, whitespace,
 * or punctuation) — a token the user edited into a longer word no longer matches and is left as plain
 * text (safe graceful degradation: it renders literally, and is NEVER mis-serialized to a wrong ss58).
 */
export function serializeMentions(text: string, mentions: MentionRef[]): string {
  if (mentions.length === 0 || text.indexOf("@") === -1) return text;
  // display → ss58, unique keys (first wins), longest display first for greedy longest-match.
  const byDisplay = new Map<string, Ss58>();
  for (const m of mentions) if (m.display && !byDisplay.has(m.display)) byDisplay.set(m.display, m.ss58);
  const displays = Array.from(byDisplay.keys()).sort((a, b) => b.length - a.length);
  if (displays.length === 0) return text;

  let out = "";
  let i = 0;
  outer: while (i < text.length) {
    if (text[i] === "@") {
      for (const d of displays) {
        if (text.startsWith(d, i + 1) && !isNameCont(text[i + 1 + d.length])) {
          out += `@${byDisplay.get(d)!}`;
          i += 1 + d.length;
          continue outer;
        }
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

// A candidate `@`+base58 run: the base58 alphabet (no 0/O/I/l), ≥44 chars. Only a cheap PREFILTER —
// each candidate is checksum-validated (`normalizeSs58`), so a well-formed-looking non-address is
// rejected, never linkified. A trailing base58 char glued to a real address (no separator) is handled
// by `validSs58Prefix`, which finds the longest valid ss58 PREFIX of the run.
const MENTION_CANDIDATE_RE = /@[1-9A-HJ-NP-Za-km-z]{44,}/gu;

/** Plausible ss58 AccountId32 lengths at prefix 42 (35 payload+prefix+checksum bytes → ~47–48 base58
 *  chars; a small window tolerates leading-zero variance). Scanned longest-first. */
const SS58_MAX_LEN = 49;
const SS58_MIN_LEN = 44;

/**
 * The LONGEST checksum-valid ss58 that is a prefix of a base58 `run` (the text after an `@`), with the
 * length consumed — or null. Handles a body like `@<ss58>.` or `@<ss58>x` where a non-space char is
 * glued to the address: only the valid address prefix is consumed, the rest stays plain text.
 */
export function validSs58Prefix(run: string): { ss58: Ss58; length: number } | null {
  for (let len = Math.min(run.length, SS58_MAX_LEN); len >= SS58_MIN_LEN; len--) {
    const ss58 = normalizeSs58(run.slice(0, len));
    if (ss58) return { ss58, length: len };
  }
  return null;
}

/** A parsed `@<ss58>` mention span found in a rendered body. */
export interface ParsedMention {
  /** char index of the `@`. */
  index: number;
  /** length of the matched `@<ss58>` run (the chars to replace with a chip). */
  length: number;
  /** the canonical prefix-42 ss58 the mention refers to. */
  ss58: Ss58;
  /** the raw matched text (including the leading `@`). */
  raw: string;
}

/**
 * Find every `@<ss58>` mention in a post body, checksum-validated. Newest clients and old ones agree
 * on this parse — it is the read side of the interop contract with {@link serializeMentions}.
 */
export function parseMentionBody(body: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  for (const m of body.matchAll(MENTION_CANDIDATE_RE)) {
    const at = m.index ?? 0;
    const hit = validSs58Prefix(m[0].slice(1)); // drop the leading '@'
    if (!hit) continue;
    const length = 1 + hit.length;
    out.push({ index: at, length, ss58: hit.ss58, raw: body.slice(at, at + length) });
  }
  return out;
}
