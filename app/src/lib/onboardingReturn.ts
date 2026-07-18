// Where to land a visitor AFTER they finish onboarding.
//
// Since guests can now READ the public surfaces (see AppShell's soft wall), someone can open a shared
// /post/<id> or /u/<addr> link, read it, and only THEN decide to sign in. Onboarding used to always end
// on the timeline — which is the right landing in almost every case, EXCEPT that one: it dropped you on
// the feed instead of the post you were just reading. This remembers the last CONTENT deep-link a
// visitor was on (a post or a profile — NOT the timeline / explore / legal pages, where the feed is the
// right landing) so the welcome flow can return them there.
//
// It complements — does not replace — the wall's `?next=` (returnTo.ts): a WALLED deep-link (/settings,
// /compose) still bounces to /welcome carrying `?next=`, and that wins when present. This sessionStorage
// value is the fallback for a PUBLIC deep-link, which no longer bounces and so carries no `?next=`.

import { safeReturnTo, readReturnTo, DEFAULT_RETURN } from "./returnTo";

const KEY = "cg:returnAfterOnboarding";

/** The route segments worth returning to — specific CONTENT a visitor was reading, not a hub surface. */
const RETURNABLE_SEGMENTS = new Set(["post", "u"]);
/** The other PUBLIC segments (see AppShell's PUBLIC_SEGMENTS) — hubs where the timeline is the right
 *  landing, so arriving on one FORGETS any remembered content route. */
const HUB_SEGMENTS = new Set(["", "explore", "legal", "privacy"]);

/**
 * Track the place to return to after onboarding as the visitor browses:
 *   • a CONTENT deep-link (a post / a profile) → remember it (a shared /post link should reopen the post);
 *   • a HUB surface (home / explore / legal / privacy) → FORGET it (the timeline is the right landing, so
 *     reading a post then wandering to the feed and signing in there should NOT teleport back to the post);
 *   • anything else (/welcome, a walled route) → leave it intact — a guest funnelling through /welcome to
 *     onboard must keep the content route they came from.
 * No-ops safely when sessionStorage is unavailable (private mode / embedded).
 */
export function rememberContentRoute(pathname: string): void {
  const seg = pathname.split("/")[1] ?? "";
  try {
    if (RETURNABLE_SEGMENTS.has(seg)) window.sessionStorage.setItem(KEY, pathname);
    else if (HUB_SEGMENTS.has(seg)) window.sessionStorage.removeItem(KEY);
    // else (/welcome, walled) → preserve whatever is remembered
  } catch {
    /* sessionStorage unavailable (private mode / embedded) — the timeline fallback still applies */
  }
}

/**
 * The validated post-onboarding destination, and CLEAR the remembered route so a later onboarding in the
 * same tab can't return to a stale post. Priority: an explicit `?next=` (a bounced walled deep-link) →
 * the remembered content route → the timeline. Every candidate is run through `safeReturnTo` (it came off
 * the URL / storage, so it is validated exactly like the wall's `?next=`).
 */
export function consumeReturnTarget(search: string): string {
  // An explicit ?next= (a walled deep-link the wall bounced here) is the strongest signal — honor it and
  // leave the remembered route untouched.
  const fromNext = readReturnTo(search);
  if (fromNext !== DEFAULT_RETURN) return fromNext;
  try {
    const remembered = window.sessionStorage.getItem(KEY);
    if (remembered) {
      window.sessionStorage.removeItem(KEY);
      return safeReturnTo(remembered);
    }
  } catch {
    /* sessionStorage unavailable — fall through to the timeline */
  }
  return DEFAULT_RETURN;
}
