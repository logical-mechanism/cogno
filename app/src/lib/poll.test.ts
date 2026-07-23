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
