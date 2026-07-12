// The tablist keyboard rule. Pure, so it is tested here rather than through a DOM.
//
// Home/End were the divergence: ProfileTabs and the Explore strip handled them; TimelineTabs,
// FollowsPanel and the notifications strip did not. Same widget, same role="tablist", different keyboard
// contract depending on which page you were on. These assertions are what makes the merged strip the
// SUPERSET rather than whichever implementation happened to get copied.

import { describe, it, expect } from "vitest";
import { nextTabIndex } from "./tabKeys";

describe("nextTabIndex", () => {
  it("moves right and wraps at the end", () => {
    expect(nextTabIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
  });

  it("moves left and wraps at the start", () => {
    expect(nextTabIndex("ArrowLeft", 2, 3)).toBe(1);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
  });

  it("jumps to the ends with Home/End — the half of the strips that lacked this", () => {
    expect(nextTabIndex("Home", 2, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
  });

  it("ignores every other key — they must fall through, NOT be preventDefault()ed", () => {
    // The strips that return early on unknown keys do so precisely so Tab still moves focus out of the
    // tablist and Enter still activates. A handler that swallowed everything would trap the user.
    for (const k of ["Tab", "Enter", " ", "a", "ArrowUp", "ArrowDown", "Escape"]) {
      expect(nextTabIndex(k, 0, 3)).toBeNull();
    }
  });

  it("is a no-op on a single tab (Home's strip drops 'Following' when follows are off)", () => {
    expect(nextTabIndex("ArrowRight", 0, 1)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 1)).toBe(0);
    expect(nextTabIndex("End", 0, 1)).toBe(0);
  });

  it("refuses to compute an index when the active tab is not in the list", () => {
    // `active` is caller state and can transiently disagree with `tabs` (the Following tab disappears
    // when follows go off). Returning null means "don't move" rather than focusing a tab that isn't there.
    expect(nextTabIndex("ArrowRight", -1, 3)).toBeNull();
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
  });
});
