// composerDraftStore — device-local persistence of the unsent top-level POST draft (client-only, no
// chain state). Lets a page reload or an accidental composer close restore what you were writing, like
// X. Scope is deliberately the plain post text only: reply/quote are uncontrolled and poll carries
// structured options — both are left out to keep this simple and low-risk.

const KEY = "cg:draft:post";

/** The saved post draft, or "" when none (or storage is unavailable). */
export function loadPostDraft(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

/** Persist the draft; an empty/whitespace draft removes the key so nothing lingers. */
export function savePostDraft(text: string): void {
  if (typeof window === "undefined") return;
  try {
    if (text.trim().length === 0) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, text);
  } catch {
    /* quota exceeded / storage disabled → in-memory only */
  }
}

/** Drop the saved draft (on a successful submit or an explicit Discard). */
export function clearPostDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
