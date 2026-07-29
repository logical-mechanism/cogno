import { describe, it, expect } from "vitest";
import { isPublicPath, isWalledForGuest } from "./routeAccess";

// Both nav bars mark a walled destination with a padlock and a "(sign in required)" accessible name,
// and at tablet width / on mobile that aria-label IS the entire accessible name. So the predicate
// behind it is user-visible text, and it was wrong in one specific place: /welcome is deliberately not
// in PUBLIC_SEGMENTS (it is the onboarding canvas with its own gate), so a plain `!isPublicPath` marked
// the signed-out Profile item — which resolves to /welcome/ — as requiring sign-in. That item IS the
// sign-in door. Pin the distinction so it cannot come back as a "simplification".

describe("isWalledForGuest", () => {
  it("does not wall /welcome, which is where a guest goes to sign in", () => {
    expect(isWalledForGuest("/welcome/")).toBe(false);
    expect(isWalledForGuest("/welcome")).toBe(false);
    // ...even though the wall table itself does not list it.
    expect(isPublicPath("/welcome/")).toBe(false);
  });

  it("still walls the write and config surfaces", () => {
    expect(isWalledForGuest("/settings/")).toBe(true);
    expect(isWalledForGuest("/notifications/")).toBe(true);
    expect(isWalledForGuest("/compose/")).toBe(true);
  });

  it("leaves the public read surfaces unmarked", () => {
    for (const p of ["/", "/explore/", "/governance/", "/post/1/", "/u/5Grw/", "/bookmarks/", "/lists/"]) {
      expect(isWalledForGuest(p)).toBe(false);
    }
  });

  it("fails closed on an unknown segment and on a missing pathname", () => {
    expect(isWalledForGuest("/some-new-route/")).toBe(true);
    expect(isWalledForGuest(null)).toBe(true);
  });
});
