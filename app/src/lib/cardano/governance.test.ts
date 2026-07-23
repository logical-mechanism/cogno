import { describe, it, expect } from "vitest";
import {
  classifyChoice,
  approvalRatio,
  actionChambers,
  actionKind,
  actionBodies,
  chamberVote,
  FALLBACK_THRESHOLDS,
} from "./governance";
import type { GovActionType, PollOptionView } from "@/lib/types";

const opt = (
  label: string,
  spoWeight: bigint,
  spoCount: number,
  drepWeight: bigint,
  drepCount: number,
): PollOptionView => ({ index: 0, label, weight: 0n, count: 0, spoWeight, spoCount, drepWeight, drepCount });

const T = FALLBACK_THRESHOLDS;

describe("classifyChoice", () => {
  it("recognizes the canonical choices, case/space-insensitive", () => {
    expect(classifyChoice("Yes")).toBe("yes");
    expect(classifyChoice(" no ")).toBe("no");
    expect(classifyChoice("ABSTAIN")).toBe("abstain");
    expect(classifyChoice("maybe")).toBe("other");
  });
});

describe("approvalRatio", () => {
  it("computes Yes/(Yes+No), excluding abstain from the denominator", () => {
    expect(approvalRatio(70n, 30n)).toBeCloseTo(0.7, 6);
    expect(approvalRatio(1n, 1n)).toBeCloseTo(0.5, 6);
  });
  it("is null when no Yes/No weight was cast", () => {
    expect(approvalRatio(0n, 0n)).toBeNull();
  });
  it("holds precision on lovelace-scale sums", () => {
    const r = approvalRatio(6_666_666_000_000n, 3_333_334_000_000n);
    expect(r).toBeGreaterThan(0.66);
    expect(r).toBeLessThan(0.67);
  });
});

describe("actionChambers — CIP-1694 deciding bodies", () => {
  const bodies = (a: GovActionType) => actionChambers(a, T).tallied.map((c) => c.body);

  it("NoConfidence & UpdateCommittee = SPO + dRep", () => {
    for (const a of ["NoConfidence", "UpdateCommittee"] as const) {
      expect(bodies(a)).toEqual(["spo", "drep"]);
    }
  });

  it("Treasury & NewConstitution = dRep only (SPOs don't vote)", () => {
    for (const a of ["TreasuryWithdrawal", "NewConstitution"] as const) {
      expect(bodies(a)).toEqual(["drep"]);
    }
  });

  it("HardFork = SPO + dRep", () => {
    expect(bodies("HardFork")).toEqual(["spo", "drep"]);
  });

  it("ParamChange = dRep only, threshold is a range (varies by parameter group)", () => {
    const c = actionChambers("ParamChange", T);
    expect(c.tallied.map((x) => x.body)).toEqual(["drep"]);
    const thr = c.tallied[0].threshold!;
    expect(thr.min).toBeCloseTo(0.67, 6); // network/economic/technical group
    expect(thr.max).toBeCloseTo(0.75, 6); // governance group
  });

  it("ParamChange range spans ALL four dRep param-group thresholds, not just network..gov", () => {
    // A governance-set change that pushes the economic group above gov and the technical below network:
    // the range must widen to the true extremes, not stay pinned to [network, gov].
    const t = { ...T, drep: { ...T.drep, ppEconomicGroup: 0.8, ppTechnicalGroup: 0.55 } };
    const thr = actionChambers("ParamChange", t).tallied[0].threshold!;
    expect(thr.min).toBeCloseTo(0.55, 6); // technical group is now the lowest
    expect(thr.max).toBeCloseTo(0.8, 6); // economic group is now the highest
  });

  it("Info is advisory: SPO + dRep vote, but no thresholds", () => {
    const c = actionChambers("Info", T);
    expect(c.advisory).toBe(true);
    expect(c.tallied.every((x) => x.threshold === null)).toBe(true);
  });

  it("resolves real threshold values from the passed table", () => {
    expect(actionChambers("TreasuryWithdrawal", T).tallied[0].threshold).toEqual({ min: 0.67, max: 0.67 });
    expect(actionChambers("HardFork", T).tallied[1].threshold).toEqual({ min: 0.6, max: 0.6 }); // dRep HF
    expect(actionChambers("HardFork", T).tallied[0].threshold).toEqual({ min: 0.51, max: 0.51 }); // SPO HF
  });
});

describe("chamberVote — fold options into a chamber's Yes/No/Abstain", () => {
  const options = [
    opt("Yes", 40n, 4, 70n, 7),
    opt("No", 20n, 2, 30n, 3),
    opt("Abstain", 5n, 1, 10n, 1),
  ];

  it("reads the dRep lens", () => {
    const v = chamberVote(options, "drep");
    expect(v).toEqual({ yes: 70n, no: 30n, abstain: 10n, total: 110n, voters: 11 });
    expect(approvalRatio(v.yes, v.no)).toBeCloseTo(0.7, 6);
  });

  it("reads the SPO lens independently", () => {
    const v = chamberVote(options, "spo");
    expect(v).toEqual({ yes: 40n, no: 20n, abstain: 5n, total: 65n, voters: 7 });
  });

  it("a non-canonical option counts toward total/voters but never Yes or No", () => {
    const v = chamberVote([opt("Yes", 0n, 0, 50n, 5), opt("Maybe", 0n, 0, 30n, 3)], "drep");
    expect(v.yes).toBe(50n);
    expect(v.no).toBe(0n);
    expect(v.total).toBe(80n); // the 30 "Maybe" weight is in the total …
    expect(v.voters).toBe(8);
    expect(approvalRatio(v.yes, v.no)).toBeCloseTo(1, 6); // … but not the ratio denominator
  });
});

describe("actionBodies — threshold-independent tally bodies (for eligibility)", () => {
  it("matches actionChambers' bodies without needing thresholds", () => {
    expect(actionBodies("TreasuryWithdrawal")).toEqual(["drep"]);
    expect(actionBodies("HardFork")).toEqual(["spo", "drep"]);
    expect(actionBodies("NewConstitution")).toEqual(["drep"]);
    expect(actionBodies("Info")).toEqual(["spo", "drep"]);
  });
});

describe("actionKind — backend tally kind the composer stores", () => {
  it("is Governance for the SPO+dRep actions", () => {
    for (const a of ["Info", "NoConfidence", "UpdateCommittee", "HardFork"] as const) {
      expect(actionKind(a)).toBe("Governance");
    }
  });
  it("is Drep for the dRep-led actions", () => {
    for (const a of ["NewConstitution", "ParamChange", "TreasuryWithdrawal"] as const) {
      expect(actionKind(a)).toBe("Drep");
    }
  });
});
