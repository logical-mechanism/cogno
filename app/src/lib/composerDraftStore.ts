// composerDraftStore — device-local persistence of the unsent top-level POST draft (client-only, no
// chain state). Lets a page reload or an accidental composer close restore what you were writing, like
// X. Scope is deliberately the plain post text only: reply/quote are uncontrolled and poll carries
// structured options — both are left out to keep this simple and low-risk.
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

const PREFIX = "cg:draft:post";

/** Signed-out composing gets its own bucket — never an account's. Mirrors lib/viewerScopedStore. */
const ANON = "anon";

/**
 * A plain keyed accessor rather than a `createViewerScopedStore`: the composer reads and writes this
 * imperatively (loaded once on mount, saved on a debounce) and never subscribes, so the reactive store's
 * subscribe/notify machinery would be dead weight here.
 */
function keyFor(who: string | null): string {
  return `${PREFIX}:${who ?? ANON}`;
}

/** The saved post draft for `who`, or "" when none (or storage is unavailable). */
export function loadPostDraft(who: string | null): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(keyFor(who)) ?? "";
  } catch {
    return "";
  }
}

/** Persist `who`'s draft; an empty/whitespace draft removes the key so nothing lingers. */
export function savePostDraft(who: string | null, text: string): void {
  if (typeof window === "undefined") return;
  try {
    if (text.trim().length === 0) window.localStorage.removeItem(keyFor(who));
    else window.localStorage.setItem(keyFor(who), text);
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
