import { describe, it, expect } from "vitest";
import { affordanceFor, affordanceTitle } from "./writeAffordance";

describe("affordanceFor", () => {
  it("a fully set up viewer gets the normal control", () => {
    expect(affordanceFor({ status: "ready", writeReady: true })).toBe("live");
  });

  it("a signed-out guest gets an ENABLED control that reads as sign-in", () => {
    expect(affordanceFor({ status: "not-connected", writeReady: false })).toBe("invite");
  });

  it("a connected-but-unbound viewer is blocked with a reason", () => {
    expect(affordanceFor({ status: "not-identity-bound", writeReady: false })).toBe("blocked");
  });

  it("BOUND WITH NO LOCKED ADA is not 'live'. This is the regression that was shipping", () => {
    // viewerStatusOf maps bound / bound_no_stake / bound_staked all to "ready", so this viewer read as
    // "ready" while writeReady was false. Every write control rendered fully enabled with title
    // "Upvote", and the click navigated the reader away from what they were reading. Keying on status
    // alone reproduces it; keying on writeReady first is what fixes it.
    expect(affordanceFor({ status: "ready", writeReady: false })).toBe("blocked");
  });

  it("writeReady wins over every status, so no status can leak a live control", () => {
    for (const status of ["not-connected", "not-identity-bound", "ready"] as const) {
      expect(affordanceFor({ status, writeReady: true })).toBe("live");
      expect(affordanceFor({ status, writeReady: false })).not.toBe("live");
    }
  });
});

describe("affordanceTitle", () => {
  it("leaves a live control's own title alone", () => {
    expect(affordanceTitle("live", "vote")).toBeUndefined();
  });

  it("invites a guest by the action they reached for", () => {
    expect(affordanceTitle("invite", "reply")).toBe("Sign in to reply");
    expect(affordanceTitle("invite", "follow")).toBe("Sign in to follow");
  });

  it("points a blocked viewer at finishing setup", () => {
    expect(affordanceTitle("blocked", "vote")).toBe("Finish setup to vote");
  });

  it("carries no em dashes, per the copy rule", () => {
    for (const mode of ["invite", "blocked"] as const)
      for (const action of ["reply", "quote", "vote", "follow", "post"] as const)
        expect(affordanceTitle(mode, action) ?? "").not.toContain("—");
  });
});
