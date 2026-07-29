import { describe, it, expect } from "vitest";
import {
  primaryLens,
  showsChamberBlock,
  chamberRequiredRole,
  lensWeight,
  lensCount,
  lensVoterUnit,
  lensVoters,
  roleLabel,
  chamberBlocksViewer,
  pollClosesIn,
} from "./poll";
import type { PollOptionView } from "./types";

const opt: PollOptionView = {
  index: 0,
  label: "Yes",
  weight: 100n,
  count: 10,
  spoWeight: 40n,
  spoCount: 4,
  drepWeight: 70n,
  drepCount: 7,
};

describe("primaryLens", () => {
  it("headlines the holder lens for Stake and Governance", () => {
    expect(primaryLens("Stake")).toBe("holder");
    expect(primaryLens("Governance")).toBe("holder");
  });
  it("headlines the single chamber for Spo/Drep", () => {
    expect(primaryLens("Spo")).toBe("spo");
    expect(primaryLens("Drep")).toBe("drep");
  });
});

describe("showsChamberBlock", () => {
  it("shows the supplementary chamber block only for Governance", () => {
    expect(showsChamberBlock("Governance")).toBe(true);
    expect(showsChamberBlock("Spo")).toBe(false);
    expect(showsChamberBlock("Drep")).toBe(false);
    expect(showsChamberBlock("Stake")).toBe(false);
  });
});

describe("chamberRequiredRole", () => {
  it("requires the matching role only for single-chamber polls", () => {
    expect(chamberRequiredRole("Spo")).toBe("Spo");
    expect(chamberRequiredRole("Drep")).toBe("DRep");
    expect(chamberRequiredRole("Governance")).toBeNull();
    expect(chamberRequiredRole("Stake")).toBeNull();
  });
});

describe("lens accessors", () => {
  it("selects the right per-option weight/count", () => {
    expect(lensWeight(opt, "holder")).toBe(100n);
    expect(lensWeight(opt, "spo")).toBe(40n);
    expect(lensWeight(opt, "drep")).toBe(70n);
    expect(lensCount(opt, "holder")).toBe(10);
    expect(lensCount(opt, "spo")).toBe(4);
    expect(lensCount(opt, "drep")).toBe(7);
  });
  it("names the voter unit and pluralizes", () => {
    expect(lensVoterUnit("spo")).toBe("pool");
    expect(lensVoterUnit("drep")).toBe("dRep");
    expect(lensVoterUnit("holder")).toBe("voter");
    expect(lensVoters(1, "drep")).toBe("1 dRep");
    expect(lensVoters(3, "drep")).toBe("3 dReps");
    expect(lensVoters(0, "spo")).toBe("0 pools");
  });
});

describe("roleLabel", () => {
  it("labels roles for gate copy", () => {
    expect(roleLabel("Spo")).toBe("SPO");
    expect(roleLabel("DRep")).toBe("dRep");
  });
});

describe("chamberBlocksViewer", () => {
  it("never blocks an open (Stake/Governance) poll", () => {
    expect(chamberBlocksViewer("Stake", [])).toBe(false);
    expect(chamberBlocksViewer("Governance", [])).toBe(false);
    expect(chamberBlocksViewer("Governance", null)).toBe(false);
  });
  it("fails OPEN while the viewer's roles are unknown (loading / not connected)", () => {
    expect(chamberBlocksViewer("Drep", null)).toBe(false);
    expect(chamberBlocksViewer("Spo", null)).toBe(false);
  });
  it("blocks a CONFIRMED non-member of the chamber", () => {
    expect(chamberBlocksViewer("Drep", [])).toBe(true);
    expect(chamberBlocksViewer("Drep", ["Spo"])).toBe(true);
    expect(chamberBlocksViewer("Spo", ["DRep"])).toBe(true);
  });
  it("allows a member of the chamber (incl. multi-role)", () => {
    expect(chamberBlocksViewer("Drep", ["DRep"])).toBe(false);
    expect(chamberBlocksViewer("Spo", ["Spo"])).toBe(false);
    expect(chamberBlocksViewer("Drep", ["Spo", "DRep"])).toBe(false);
  });
});

// SECS_PER_BLOCK is 6, so one minute is 10 blocks, one hour 600, one day 14400. The cases below are
// written in blocks rather than derived from the constant on purpose: a test that recomputes the
// conversion it is checking agrees with itself no matter what the conversion does.
describe("pollClosesIn", () => {
  it("says nothing when there is nothing truthful to say", () => {
    expect(pollClosesIn(undefined, 100)).toBeNull(); // floating poll, no deadline
    expect(pollClosesIn(1000, null)).toBeNull(); // head unknown (still connecting)
  });

  it("returns null once the deadline is reached, so no countdown outlives the poll", () => {
    expect(pollClosesIn(1000, 1000)).toBeNull(); // exactly at the deadline
    expect(pollClosesIn(1000, 1001)).toBeNull(); // past it
    expect(pollClosesIn(1000, 99_999)).toBeNull(); // long past it
  });

  it("collapses the last minute rather than counting seconds down", () => {
    expect(pollClosesIn(1001, 1000)).toBe("in under a minute"); // 1 block, 6s
    expect(pollClosesIn(1009, 1000)).toBe("in under a minute"); // 9 blocks, 54s
  });

  it("reads in minutes below an hour, singular at one", () => {
    expect(pollClosesIn(1010, 1000)).toBe("in about 1 minute"); // 10 blocks, 60s
    expect(pollClosesIn(1100, 1000)).toBe("in about 10 minutes");
    expect(pollClosesIn(1590, 1000)).toBe("in about 59 minutes");
  });

  it("never says '60 minutes' — rounding promotes it to the next unit", () => {
    // 595 blocks is 59.5 min, which rounds to 60 and so fails the `< 60` minutes branch. That is the
    // intended behaviour, not an off-by-one: "in about 1 hour" is what a person would say.
    expect(pollClosesIn(1595, 1000)).toBe("in about 1 hour");
  });

  it("reads in hours up to two days, singular at one", () => {
    expect(pollClosesIn(1600, 1000)).toBe("in about 1 hour"); // 600 blocks
    expect(pollClosesIn(2800, 1000)).toBe("in about 3 hours");
    // 47h stays in hours: "in about 47 hours" tells a voter more than "in about 2 days".
    expect(pollClosesIn(1000 + 47 * 600, 1000)).toBe("in about 47 hours");
  });

  it("switches to days at 48 hours", () => {
    expect(pollClosesIn(1000 + 48 * 600, 1000)).toBe("in about 2 days");
    expect(pollClosesIn(1000 + 7 * 14_400, 1000)).toBe("in about 7 days");
  });
});
