// composerDraftStore — device-local persistence of the unsent top-level POST draft (client-only, no
// chain state). Lets a page reload or an accidental composer close restore what you were writing, like
// X. Scope is deliberately the plain post text only: reply/quote are uncontrolled and poll carries
// structured options — both are left out to keep this simple and low-risk.
//
// IT PERSISTS THE MENTION REGISTRY TOO, and that is not a nicety. The composer holds friendly `@Bob`
// DISPLAY tokens; the binding from a token to an ss58 lives in a parallel `MentionRef[]` that
// `serializeMentions` expands at submit. Persisting the text ALONE meant a restored draft came back
// with an empty registry, so `serialize` was the identity function and pressing Post wrote the literal
// string `@Bob` to the chain. No attacker, fully deterministic, reachable by typing `@bob`, picking
// Bob, and pressing browser Back — and this chain has no `delete_post`, so the wrong body is permanent.
//
// PER ACCOUNT. This is the most sensitive thing in device-local storage — words the author has NOT
// chosen to publish — and it used to live under one device-global key. `useSigner` cleared it on sign-out
// for exactly that reason, which covered sign-out but not an in-place account switch: connect a
// different wallet without signing out first and the previous account's unsent text was sitting in the
// composer. Bucketing closes that path.
//
// Sign-out still DISCARDS the draft rather than parking it in the account's bucket. That is a deliberate
// asymmetry with bookmarks/mutes/searches (which sign-out preserves): unsent words are the one thing a
// person leaving a shared browser would not want left behind, even in a bucket only they can reach.

import { normalizeSs58 } from "./ss58";
import type { MentionRef } from "./mentions";

const PREFIX = "cg:draft:post";

/** Signed-out composing gets its own bucket — never an account's. Mirrors lib/viewerScopedStore. */
const ANON = "anon";

/**
 * Envelope version. A stored value that is not a `v: 1` object is read as PLAIN TEXT — that is what
 * every draft written before the registry existed looks like, and dropping those on the floor would
 * lose real unsent words on upgrade.
 */
const ENVELOPE_VERSION = 1;

/**
 * Refs are bounded so a pathological draft cannot grow this key without limit. Well above any real
 * draft: the body cap is 512 bytes and each serialized mention costs ~49 of them, so ~10 is the
 * physical ceiling anyway.
 */
const MAX_REFS = 32;

/** An unsent draft as the composer needs it back: the display text plus what binds its tokens. */
export interface PostDraft {
  /** The DISPLAY text (friendly `@Bob` tokens), exactly as it sat in the textarea. */
  text: string;
  /** The registry that binds each `@display` token in `text` to an account. */
  mentions: MentionRef[];
}

export const EMPTY_DRAFT: PostDraft = { text: "", mentions: [] };

function keyFor(who: string | null): string {
  return `${PREFIX}:${who ?? ANON}`;
}

/**
 * Validate a stored refs array. Every ref is re-checked, not trusted: this value can be hand-edited,
 * and it decides which ACCOUNT a permanent post credits. A ref that does not round-trip through
 * `normalizeSs58` is dropped, which degrades that one token to plain text — the same graceful failure
 * `serializeMentions` already produces for a token the user edited.
 */
function parseRefs(raw: unknown): MentionRef[] {
  if (!Array.isArray(raw)) return [];
  const out: MentionRef[] = [];
  for (const item of raw.slice(0, MAX_REFS)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.d !== "string" || typeof r.s !== "string" || r.d === "") continue;
    const ss58 = normalizeSs58(r.s);
    if (!ss58) continue;
    out.push({ ss58, display: r.d });
  }
  return out;
}

/** The saved post draft for `who`, or an empty one (also when storage is unavailable). */
export function loadPostDraft(who: string | null): PostDraft {
  if (typeof window === "undefined") return EMPTY_DRAFT;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(keyFor(who));
  } catch {
    return EMPTY_DRAFT;
  }
  if (raw === null || raw === "") return EMPTY_DRAFT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw, mentions: [] }; // a pre-envelope draft: plain text, no bindings
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { text: raw, mentions: [] };
  }
  const env = parsed as Record<string, unknown>;
  if (env.v !== ENVELOPE_VERSION || typeof env.t !== "string") {
    // Valid JSON that is not our envelope — e.g. the user genuinely typed `{"a":1}`. Their text.
    return { text: raw, mentions: [] };
  }
  return { text: env.t, mentions: parseRefs(env.m) };
}

/** Persist `who`'s draft; an empty/whitespace draft removes the key so nothing lingers. */
export function savePostDraft(
  who: string | null,
  text: string,
  mentions: readonly MentionRef[] = [],
): void {
  if (typeof window === "undefined") return;
  try {
    if (text.trim().length === 0) {
      window.localStorage.removeItem(keyFor(who));
      return;
    }
    // Only the refs whose token is still IN the text. `reconcileMentions` prunes on every keystroke, but
    // a save can be handed a snapshot from a beat earlier, and a stale ref persisted here would outlive
    // the reason it existed.
    const kept = mentions
      .filter((m) => m.display !== "" && text.includes(`@${m.display}`))
      .slice(0, MAX_REFS)
      .map((m) => ({ s: m.ss58, d: m.display }));
    window.localStorage.setItem(
      keyFor(who),
      JSON.stringify({ v: ENVELOPE_VERSION, t: text, m: kept }),
    );
  } catch {
    /* quota exceeded / storage disabled → in-memory only */
  }
}

/** Drop `who`'s saved draft (on a successful submit or an explicit Discard). */
export function clearPostDraft(who: string | null): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(keyFor(who));
  } catch {
    /* ignore */
  }
}

/**
 * Drop EVERY bucket's draft, plus the pre-bucketing device-global key.
 *
 * Used by sign-out, which does not know — and should not need to know — which accounts have touched this
 * browser. Enumerating is the point: a shared device must not keep anyone's unsent words.
 */
export function clearAllPostDrafts(): void {
  if (typeof window === "undefined") return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      // The bare PREFIX is the pre-bucketing key; `${PREFIX}:` covers every account bucket and anon.
      if (k === PREFIX || k?.startsWith(`${PREFIX}:`)) doomed.push(k);
    }
    for (const k of doomed) window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
