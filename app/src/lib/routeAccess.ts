// routeAccess — the ONE route table: which top-level segments a logged-out visitor may browse.
//
// It lives in lib/, not in AppShell, for two reasons. It is re-stated by hand elsewhere
// (`lib/onboardingReturn.ts` splits the same set into RETURNABLE + HUB, and `scripts/smoke-export.mjs`
// lists the static ones), and every drift between those copies has been a real bug: /governance in
// neither of onboardingReturn's sets, /bookmarks and /lists missing from this one. And a set that lives
// in a `"use client"` component cannot be asserted against the filesystem by a node test —
// `routeClassification.test.ts` reads `src/app` and requires every segment with a `page.tsx` to be
// classified exactly once, which is what turns "somebody remembered" into "the build fails".

/**
 * The read-only surfaces a LOGGED-OUT visitor may browse without signing in: the timeline, discovery, a
 * post, a profile, the governance polls, the static legal pages, and the two purely device-local
 * surfaces. Everything else (compose, settings, notifications — the write/config surfaces) stays behind
 * the wall and bounces a guest to /welcome.
 *
 * Matched by FIRST PATH SEGMENT so it is trailing-slash- and dynamic-segment-proof under
 * `output: export` ("/" → "", "/post/1/" → "post", "/u/5Grw…/" → "u"). Fail-CLOSED: a route whose
 * segment is not listed is treated as private, so a newly-added route is walled until it is
 * deliberately opened here. /welcome is intentionally NOT listed — it is the onboarding canvas, handled
 * by AppShell's own `onWelcome` branch.
 */
export const PUBLIC_SEGMENTS: ReadonlySet<string> = new Set([
  "",
  "explore",
  "governance",
  "post",
  "u",
  "legal",
  "privacy",
  // "policy" is the abuse/report surface. It MUST be public: the reader most likely to need it is an
  // anonymous stranger who just scrolled past something, and walling it would bounce exactly that
  // person to /welcome and ask them to connect a wallet before they can find out how to report it.
  "policy",
  // "bookmarks" and "lists" are PURELY device-local: nothing on either page is chain state, nothing on
  // either needs an identity, and both carry their own "stays on this device" copy. They were walled,
  // which made the bookmark affordance a lie — a guest could bookmark a post from the ··· menu, get a
  // "Saved to bookmarks" toast, and then never reach it: signed out the page bounced to /welcome, and
  // signing in read a different bucket. Mute, block and hide were already usable signed-out; these two
  // are the same kind of state and belong on the same side of the wall.
  //
  // The `:anon` bucket is deliberately NOT adopted into `:<ss58>` at sign-in — see the note in
  // lib/viewerScopedStore.
  "bookmarks",
  "lists",
]);

/** The onboarding canvas. Not public and not walled: it owns the whole surface and its own gate. */
export const WELCOME_SEGMENT = "welcome";

/** First path segment of a pathname, the way the wall matches ("/" → "", "/post/1/" → "post"). */
export function firstSegment(pathname: string): string {
  return pathname.split("/")[1] ?? "";
}

/** May a logged-out visitor browse this path? */
export function isPublicPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return PUBLIC_SEGMENTS.has(firstSegment(pathname));
}

/**
 * Should a nav item pointing here carry the "sign in required" marker for a signed-out visitor?
 *
 * Not the same question as `!isPublicPath`, and the difference is /welcome. It is deliberately absent
 * from PUBLIC_SEGMENTS (it is the onboarding canvas, with its own gate), so the plain negation marks it
 * as walled — and /welcome is exactly where a guest goes to STOP being walled. Both nav bars resolve
 * their Profile item to /welcome/ when signed out, so the plain rule put a padlock and a
 * "(sign in required)" accessible name on the one control that leads into sign-in. Nothing is walled
 * behind it; it IS the door.
 *
 * Lives here rather than in the two nav components so they cannot answer it differently. Callers still
 * apply their own "is this viewer signed out" test; this is only about the destination.
 */
export function isWalledForGuest(pathname: string | null): boolean {
  if (!pathname) return true;
  const seg = firstSegment(pathname);
  if (seg === WELCOME_SEGMENT) return false;
  return !PUBLIC_SEGMENTS.has(seg);
}
