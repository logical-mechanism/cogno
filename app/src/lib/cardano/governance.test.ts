import { describe, it, expect } from "vitest";
import {
  classifyChoice,
  approvalRatio,
  ratificationVerdict,
  actionChambers,
  actionKind,
  actionBodies,
  chamberVote,
  countDirection,
  unanimousChoice,
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
    expect(v).toEqual({
      yes: 70n, no: 30n, abstain: 10n, total: 110n, voters: 11,
      yesVoters: 7, noVoters: 3, abstainVoters: 1,
    });
    expect(approvalRatio(v.yes, v.no)).toBeCloseTo(0.7, 6);
  });

  it("reads the SPO lens independently", () => {
    const v = chamberVote(options, "spo");
    expect(v).toEqual({
      yes: 40n, no: 20n, abstain: 5n, total: 65n, voters: 7,
      yesVoters: 4, noVoters: 2, abstainVoters: 1,
    });
  });

  it("a non-canonical option counts toward total/voters but never Yes or No", () => {
    const v = chamberVote([opt("Yes", 0n, 0, 50n, 5), opt("Maybe", 0n, 0, 30n, 3)], "drep");
    expect(v.yes).toBe(50n);
    expect(v.no).toBe(0n);
    expect(v.total).toBe(80n); // the 30 "Maybe" weight is in the total …
    expect(v.voters).toBe(8);
    expect(approvalRatio(v.yes, v.no)).toBeCloseTo(1, 6); // … but not the ratio denominator
  });

  // The state GovernanceResult reads to say "voted, no stake counted yet" rather than "no dReps voted".
  // Pinned here because vitest runs in a `node` environment and cannot render the component, so this is
  // the only place the DATA CONTRACT behind that branch can be asserted: `voters` and `total` have to be
  // able to disagree. The runtime side is pinned by pallet-microblog's
  // `governance_poll_counts_a_zero_weight_role_without_giving_it_weight`.
  it("reports participation and stake INDEPENDENTLY, so a counted role can carry no weight", () => {
    // One dRep voted Yes carrying 0 stake — a live state, not a contrived one: Cardano makes a delegation
    // effective the epoch AFTER its certificate and the observer reads the previous epoch's snapshot, so a
    // newly delegated dRep genuinely weighs 0 for up to two epochs.
    const v = chamberVote([opt("Yes", 0n, 0, 0n, 1), opt("No", 0n, 0, 0n, 0)], "drep");
    expect(v.voters).toBe(1); // somebody voted …
    expect(v.total).toBe(0n); // … carrying nothing the snapshot can price
    // So `total === 0n` must NEVER be read as "nobody voted": here it is true while a dRep has voted.
    expect(v.voters > 0 && v.total === 0n).toBe(true);
    // And there is no ratio to draw a gauge from — 0 Yes vs 0 No is not a 0% rejection.
    expect(approvalRatio(v.yes, v.no)).toBeNull();
  });

  it("still reports a genuinely empty chamber as no voters at all", () => {
    const v = chamberVote([opt("Yes", 0n, 0, 0n, 0), opt("No", 0n, 0, 0n, 0)], "drep");
    expect(v.voters).toBe(0);
    expect(v.total).toBe(0n);
  });

  it("folds head counts by choice, so direction survives a zero-stake chamber", () => {
    const v = chamberVote(
      [opt("Yes", 0n, 0, 0n, 2), opt("No", 0n, 0, 0n, 1), opt("Abstain", 0n, 0, 0n, 0)],
      "drep",
    );
    expect([v.yesVoters, v.noVoters, v.abstainVoters]).toEqual([2, 1, 0]);
    expect(v.voters).toBe(3);
    expect(v.total).toBe(0n); // no stake at all, yet the direction above is fully known
  });
});

describe("unanimousChoice / countDirection — direction when weight cannot speak", () => {
  const drep = (yes: number, no: number, abstain: number) =>
    chamberVote(
      [opt("Yes", 0n, 0, 0n, yes), opt("No", 0n, 0, 0n, no), opt("Abstain", 0n, 0, 0n, abstain)],
      "drep",
    );

  it("names the choice when every voter agreed, and gives no tally to repeat", () => {
    expect(unanimousChoice(drep(2, 0, 0))).toBe("Yes");
    expect(countDirection(drep(2, 0, 0))).toBeNull(); // "2 dReps voted Yes" — a tally would be redundant
    expect(unanimousChoice(drep(0, 1, 0))).toBe("No");
    expect(unanimousChoice(drep(0, 0, 3))).toBe("Abstain");
  });

  it("gives the tally when they split, and no single choice to name", () => {
    expect(unanimousChoice(drep(2, 1, 0))).toBeNull();
    expect(countDirection(drep(2, 1, 0))).toBe("2 Yes, 1 No");
    expect(countDirection(drep(1, 1, 1))).toBe("1 Yes, 1 No, 1 Abstain");
  });

  it("omits empty buckets rather than reporting zeroes", () => {
    expect(countDirection(drep(3, 0, 1))).toBe("3 Yes, 1 Abstain");
  });

  it("says nothing at all when nobody voted", () => {
    expect(unanimousChoice(drep(0, 0, 0))).toBeNull();
    expect(countDirection(drep(0, 0, 0))).toBeNull();
  });

  it("ignores non-canonical options, which belong to no bucket", () => {
    const v = chamberVote([opt("Maybe", 0n, 0, 0n, 2)], "drep");
    expect(v.voters).toBe(2); // they did turn out …
    expect(unanimousChoice(v)).toBeNull(); // … but there is no canonical direction to claim
    expect(countDirection(v)).toBeNull();
  });
});

describe("ratificationVerdict", () => {
  const one = (n: number) => ({ min: n, max: n });
  const range = { min: 0.67, max: 0.75 };

  it("single-value threshold → plain meets/below on the rounded percent", () => {
    expect(ratificationVerdict(0.6, one(0.51))).toBe("meets");
    expect(ratificationVerdict(0.51, one(0.51))).toBe("meets"); // exactly on the bar
    expect(ratificationVerdict(0.5, one(0.51))).toBe("below");
  });

  it("rounds like the display (0.505 shown as 51% must read 'meets 51%')", () => {
    expect(ratificationVerdict(0.505, one(0.51))).toBe("meets");
  });

  it("a null ratio (no Yes/No cast) is 'below'", () => {
    expect(ratificationVerdict(null, one(0.67))).toBe("below");
  });

  it("range threshold → 'partial' inside [min, max), never a flat 'meets' at the floor", () => {
    expect(ratificationVerdict(0.8, range)).toBe("meets"); // clears even the strictest group
    expect(ratificationVerdict(0.75, range)).toBe("meets"); // exactly the strictest group
    expect(ratificationVerdict(0.7, range)).toBe("partial"); // inside → some groups only
    expect(ratificationVerdict(0.67, range)).toBe("partial"); // on the floor but under the ceiling
    expect(ratificationVerdict(0.6, range)).toBe("below"); // under the loosest group
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
