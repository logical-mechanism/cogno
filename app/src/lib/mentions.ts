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

import { normalizeSs58, truncateSs58 } from "./ss58";
import { sanitizeInline } from "./sanitize";
import type { Ss58 } from "./types";

/**
 * The text a rendered `@mention` shows: the mentioned account's display name, or — when they're
 * unbound / nameless / still loading — their truncated ss58 (`@5Grw…utQY`). Never empty.
 *
 * The name is hardened via `sanitizeInline` (lib/sanitize), and that is load-bearing, not cosmetic. A
 * display name is attacker-controlled: `pallet-profile::set_profile` bounds it by LENGTH only (64 bytes,
 * feelessly), validating no characters, and the read path trims just the ends — so any code point
 * survives all the way to the DOM. A mention renders inside a post body, which is `white-space:
 * pre-wrap`, so an un-collapsed name would render its newlines as HARD LINE BREAKS *inside somebody
 * else's post*: set your name to 62 newlines and every permanent, undeletable post that mentions you
 * grows to 63 lines in every feed, and its author cannot do a thing about it. `sanitizeInline` collapses
 * the whitespace AND strips the bidi-override / invisible / Zalgo abuse that would otherwise ride a
 * mention into a stranger's post.
 *
 * This is only HALF of what a mention must render. See {@link mentionParts}: a name alone is not an
 * identity, because it is mutable and the post it appears in is not.
 */
export function mentionLabel(displayName: string | undefined, ss58: Ss58): string {
  const collapsed = sanitizeInline(displayName ?? "");
  return collapsed ? collapsed : truncateSs58(ss58);
}

/** What a rendered `@mention` puts on screen: the label, plus the address that anchors it. */
export interface MentionParts {
  /** The primary text after the `@` — the display name, or the truncated ss58 when there is none. */
  label: string;
  /**
   * The truncated ss58 to render ALONGSIDE `label`, or null when `label` already IS the address (a
   * nameless account) and repeating it would just be noise.
   */
  address: string | null;
}

/**
 * Split a mention into the two things it must show. The address half is the point.
 *
 * A mention's name is resolved LIVE from `Profile.Profiles` at render time (useAccountProfile), not
 * snapshotted into the post body — the body stores only `@<ss58>`. That is the right storage decision
 * (a rename should not leave every old mention showing a dead name) and it hands an attacker a
 * retroactive edit on somebody else's writing: be mentioned once as `@alice`, rename to
 * `@intersect_official`, and from that block on a stranger's permanent, undeletable post renders an
 * endorsement they never wrote and cannot take back. The mentioned account does not even have to be
 * involved after the fact; the rename is free and feeless and can happen a year later.
 *
 * The address is what defeats that, and it is why every other identity surface in this app pairs a
 * DisplayName with a `<Handle>`: PostCardHeader, MentionSuggestions, PersonRow, FollowsPanel. The
 * mention chip was the ONE render of a display name with no address beside it — which also made
 * lib/sanitize's stated justification for tolerating a residual spoof class ("defeated anyway by the
 * ss58 shown beside every name") false at exactly the site where the spoof lands inside someone
 * else's post.
 *
 * Pure, so the rule is unit-testable and cannot drift between the chip and anything that later renders
 * a mention (a notification row, a preview).
 */
export function mentionParts(displayName: string | undefined, ss58: Ss58): MentionParts {
  const label = mentionLabel(displayName, ss58);
  const short = truncateSs58(ss58);
  return { label, address: label === short ? null : short };
}

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

/**
 * The display text to insert into the composer when a person is picked from the @-autocomplete.
 *
 * Two rules, and both were wrong at the one call site that used to hold this inline.
 *
 * 1. IT GOES THROUGH `mentionLabel`, so the inserted token is the SANITIZED name — the same string the
 *    popover row rendered. The old `s.displayName?.trim() || fallback` inserted the RAW chain bytes: an
 *    account whose `display_name` is `Alice‮evilX`, `Alice\nSmith`, or ZWSP-only put those bytes
 *    into a stranger's composer, where the byte meter then charged the 512-byte budget against the raw
 *    name instead of the 49-byte ss58, and the user read something different from the row they clicked.
 *    `set_profile` validates no characters, only length, so every one of those is representable.
 *
 *    This is NOT a sanitize-before-write violation. The token is a DISPLAY artefact that never reaches
 *    the chain: `serializeMentions` replaces it wholesale with the raw `@<ss58>`.
 *
 * 2. IT DISAMBIGUATES A CLASH. A display name is not unique across accounts, and `serializeMentions`
 *    maps display → ss58, so two different accounts under one name in a single draft would bind both
 *    tokens to whichever won the map. Appending the truncated ss58 keeps the mapping total.
 */
export function pickMentionDisplay(
  displayName: string | undefined,
  ss58: Ss58,
  existing: readonly MentionRef[],
): string {
  const label = mentionLabel(displayName, ss58);
  const clash = existing.some((m) => m.display === label && m.ss58 !== ss58);
  return clash ? `${label} (${truncateSs58(ss58)})` : label;
}

/** The draft last handed to `onSubmit`: its DISPLAY text and the refs it was serialized with. */
export interface SubmittedDraft {
  text: string;
  refs: MentionRef[];
}

/**
 * The composer's mention-registry rule, as a pure function of (registry, new display text, last submit).
 * `useMentions` is this plus a `useState` — it lives here so the rule is unit-testable, because the two
 * ways it can go wrong both corrupt a POST PERMANENTLY (this chain has no `delete_post`).
 *
 * Normally: drop any ref whose display token is no longer in the text (the user deleted or broke it → it
 * degrades to plain text, and `serializeMentions` leaves it literal rather than mis-binding it).
 *
 * The exception is a RESTORE. A controlled surface clears the composer optimistically at submit and hands
 * the SAME display text back if the tx fails (Home's failed-post restore). The refs are long gone by then
 * — pruned against the empty box — and `serializeMentions` is a no-op on an empty registry, so without
 * this the restored `@alice` would re-serialize to a LITERAL and the retry would post an UNBOUND mention.
 *
 * Two guards keep that exception narrow:
 *   - `text === submitted.text` EXACTLY, not "the draft is empty". The composer is not disabled during
 *     the write, so the user can type while the tx is in flight; an emptiness rule would already have
 *     lost the refs by the time the failure landed. It also stops an unrelated draft that merely happens
 *     to contain `@alice` from inheriting a binding.
 *   - `mentions` must be EMPTY. The snapshot outlives a SUCCESSFUL post too, and a display name is not
 *     unique across accounts: a user who later picks a DIFFERENT account under the same name and retypes
 *     the same sentence must keep THEIR pick. Restoring over a non-empty registry would silently swap it
 *     back — a mention bound to the WRONG account, which is worse than the literal this exists to prevent.
 */
export function reconcileMentions(
  mentions: MentionRef[],
  text: string,
  submitted: SubmittedDraft | null,
): MentionRef[] {
  if (
    mentions.length === 0 &&
    submitted !== null &&
    submitted.text !== "" &&
    text === submitted.text
  ) {
    return submitted.refs;
  }
  const kept = mentions.filter((m) => text.includes(mentionToken(m.display)));
  return kept.length === mentions.length ? mentions : kept;
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
