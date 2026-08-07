import { describe, it, expect } from "vitest";
import {
  GOV_ACTION_SLUG,
  GOV_DEFAULT_AXES,
  buildGovernanceUrl,
  filterGovPolls,
  govAxesAreDefault,
  parseGovAction,
  parseGovChamber,
  parseGovSort,
  parseGovLens,
  parseGovStatus,
  sortGovPolls,
  type GovAxes,
} from "./governanceFilters";
import { GOV_ACTION_LABEL } from "@/lib/cardano/governance";
import type { GovPollSummary } from "@/lib/chain/governance-feed";
import type { GovActionType } from "@/lib/types";

function poll(p: Partial<GovPollSummary> & { hostId: bigint }): GovPollSummary {
  return {
    actionType: "Info",
    question: "q",
    finalized: false,
    replyCount: 0,
    ...p,
  };
}

describe("parsers", () => {
  it("falls back to the default for null, empty, unknown and case-flipped input", () => {
    for (const bad of [null, undefined, "", "nope", "OPEN", "__proto__"]) {
      expect(parseGovStatus(bad)).toBe("all");
      expect(parseGovChamber(bad)).toBe("all");
      expect(parseGovSort(bad)).toBe("latest");
      expect(parseGovLens(bad)).toBe("all");
      expect(parseGovAction(bad)).toBeNull();
    }
  });

  it("round-trips every known token", () => {
    expect(parseGovStatus("open")).toBe("open");
    expect(parseGovStatus("closed")).toBe("closed");
    expect(parseGovStatus("final")).toBe("final");
    expect(parseGovChamber("spo")).toBe("spo");
    expect(parseGovChamber("drep")).toBe("drep");
    expect(parseGovSort("closing")).toBe("closing");
    expect(parseGovSort("discussed")).toBe("discussed");
  });
});

// The slug map is a permanent URL contract, so it is pinned against the one runtime enumeration of the
// seven CIP-1694 types (GOV_ACTION_LABEL's keys — GovActionType is a pure type union with no runtime form).
describe("GOV_ACTION_SLUG", () => {
  const types = Object.keys(GOV_ACTION_LABEL) as GovActionType[];

  it("is total over every action type", () => {
    expect(types).toHaveLength(7);
    for (const t of types) expect(typeof GOV_ACTION_SLUG[t]).toBe("string");
  });

  it("has no duplicate slugs", () => {
    const slugs = types.map((t) => GOV_ACTION_SLUG[t]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("round-trips through parseGovAction", () => {
    for (const t of types) expect(parseGovAction(GOV_ACTION_SLUG[t])).toBe(t);
  });
});

describe("buildGovernanceUrl", () => {
  it("returns a bare path when everything is default", () => {
    expect(buildGovernanceUrl(GOV_DEFAULT_AXES)).toBe("/governance/");
  });

  it("sets only the changed axis", () => {
    expect(buildGovernanceUrl({ ...GOV_DEFAULT_AXES, status: "open" })).toBe("/governance/?t=open");
    expect(buildGovernanceUrl({ ...GOV_DEFAULT_AXES, chamber: "spo" })).toBe("/governance/?c=spo");
    expect(buildGovernanceUrl({ ...GOV_DEFAULT_AXES, sort: "discussed" })).toBe("/governance/?s=discussed");
    expect(buildGovernanceUrl({ ...GOV_DEFAULT_AXES, action: "HardFork" })).toBe("/governance/?a=hard-fork");
  });

  it("emits a stable key order for a fully specified view", () => {
    const axes: GovAxes = { status: "open", action: "ParamChange", chamber: "drep", sort: "closing", lens: "all" };
    expect(buildGovernanceUrl(axes)).toBe("/governance/?t=open&a=params&c=drep&s=closing");
  });

  it("round-trips every axis combination back through the parsers", () => {
    const statuses = ["all", "open", "closed", "final"] as const;
    const chambers = ["all", "spo", "drep"] as const;
    const sorts = ["latest", "closing", "discussed"] as const;
    const actions: (GovActionType | null)[] = [null, "Info", "TreasuryWithdrawal"];
    for (const status of statuses)
      for (const chamber of chambers)
        for (const sort of sorts)
          for (const action of actions) {
            const url = buildGovernanceUrl({ status, action, chamber, sort, lens: "all" });
            const q = new URLSearchParams(url.split("?")[1] ?? "");
            expect({
              status: parseGovStatus(q.get("t")),
              action: parseGovAction(q.get("a")),
              chamber: parseGovChamber(q.get("c")),
              sort: parseGovSort(q.get("s")),
              lens: parseGovLens(q.get("v")),
            }).toEqual({ status, action, chamber, sort, lens: "all" });
          }
  });
});

describe("govAxesAreDefault", () => {
  it("is true only for the untouched view", () => {
    expect(govAxesAreDefault(GOV_DEFAULT_AXES)).toBe(true);
    expect(govAxesAreDefault({ ...GOV_DEFAULT_AXES, status: "open" })).toBe(false);
    expect(govAxesAreDefault({ ...GOV_DEFAULT_AXES, action: "Info" })).toBe(false);
  });
});

describe("filterGovPolls", () => {
  const all = [
    poll({ hostId: 1n, actionType: "Info", closeAt: 100 }),
    poll({ hostId: 2n, actionType: "ParamChange", closeAt: 100 }),
    poll({ hostId: 3n, actionType: "HardFork", closeAt: 500 }),
    poll({ hostId: 4n, actionType: "TreasuryWithdrawal", finalized: true }),
  ];
  const none = { status: "all", action: null, chamber: "all", lens: "all" } as const;

  it("keeps everything by default", () => {
    expect(filterGovPolls(all, none, 200)).toHaveLength(4);
  });

  it("filters by action type", () => {
    expect(filterGovPolls(all, { ...none, action: "HardFork" }, 200).map((p) => p.hostId)).toEqual([3n]);
  });

  // The CIP-1694 encoding: NewConstitution, ParamChange and TreasuryWithdrawal are dRep-only; Info,
  // NoConfidence, UpdateCommittee and HardFork are decided by both chambers.
  it("filters by deciding chamber", () => {
    const spo = filterGovPolls(all, { ...none, chamber: "spo" }, 200).map((p) => p.hostId);
    expect(spo).toEqual([1n, 3n]);
    const drep = filterGovPolls(all, { ...none, chamber: "drep" }, 200).map((p) => p.hostId);
    expect(drep).toEqual([1n, 2n, 3n, 4n]);
  });

  it("maps the 'closed' token onto the provisional state", () => {
    // best block 200: ids 1 and 2 are past closeAt=100 (provisional), 3 is still open, 4 is final.
    expect(filterGovPolls(all, { ...none, status: "closed" }, 200).map((p) => p.hostId)).toEqual([1n, 2n]);
    expect(filterGovPolls(all, { ...none, status: "open" }, 200).map((p) => p.hostId)).toEqual([3n]);
    expect(filterGovPolls(all, { ...none, status: "final" }, 200).map((p) => p.hostId)).toEqual([4n]);
  });

  it("works on the non-status axes before the chain head is known", () => {
    expect(filterGovPolls(all, { ...none, action: "Info" }, null).map((p) => p.hostId)).toEqual([1n]);
  });
});

describe("sortGovPolls", () => {
  it("returns a new array and does not mutate the input", () => {
    const input = [poll({ hostId: 1n }), poll({ hostId: 2n })];
    const before = [...input];
    const out = sortGovPolls(input, "latest", 100);
    expect(out).not.toBe(input);
    expect(input).toEqual(before);
  });

  it("groups open, then closed, then final, whatever the order", () => {
    const polls = [
      poll({ hostId: 1n, finalized: true }),
      poll({ hostId: 2n, closeAt: 50 }), // past head 100 → provisional
      poll({ hostId: 3n, closeAt: 500 }), // open
    ];
    for (const sort of ["latest", "closing", "discussed"] as const) {
      expect(sortGovPolls(polls, sort, 100).map((p) => p.hostId)).toEqual([3n, 2n, 1n]);
    }
  });

  it("latest orders newest first within a group", () => {
    const polls = [poll({ hostId: 1n }), poll({ hostId: 3n }), poll({ hostId: 2n })];
    expect(sortGovPolls(polls, "latest", 100).map((p) => p.hostId)).toEqual([3n, 2n, 1n]);
  });

  it("closing orders by soonest deadline, floating polls last", () => {
    const polls = [
      poll({ hostId: 1n, closeAt: 900 }),
      poll({ hostId: 2n }), // floating, never closes
      poll({ hostId: 3n, closeAt: 300 }),
    ];
    expect(sortGovPolls(polls, "closing", 100).map((p) => p.hostId)).toEqual([3n, 1n, 2n]);
  });

  // The deadline of a closed poll is in the past, so applying the closing key there would flip those
  // sections to oldest-first with nothing saying so.
  it("closing leaves the closed and final groups newest first", () => {
    const polls = [
      poll({ hostId: 1n, closeAt: 10 }),
      poll({ hostId: 2n, closeAt: 90 }),
      poll({ hostId: 3n, closeAt: 50 }),
    ];
    expect(sortGovPolls(polls, "closing", 100).map((p) => p.hostId)).toEqual([3n, 2n, 1n]);
  });

  it("discussed orders by direct reply count, newest first on a tie", () => {
    const polls = [
      poll({ hostId: 1n, replyCount: 2 }),
      poll({ hostId: 2n, replyCount: 9 }),
      poll({ hostId: 3n, replyCount: 2 }),
    ];
    expect(sortGovPolls(polls, "discussed", 100).map((p) => p.hostId)).toEqual([2n, 3n, 1n]);
  });

  it("is deterministic on an all-ties input", () => {
    const polls = [poll({ hostId: 5n }), poll({ hostId: 7n }), poll({ hostId: 6n })];
    const a = sortGovPolls(polls, "discussed", 100).map((p) => p.hostId);
    const b = sortGovPolls(polls, "discussed", 100).map((p) => p.hostId);
    expect(a).toEqual(b);
    expect(a).toEqual([7n, 6n, 5n]);
  });
});

// The personal lens turns the list into a work queue. Its most important property is that it FAILS
// OPEN: an empty queue is a claim that there is nothing to do, and that claim must never be made on
// data that has not arrived.
describe("filterGovPolls — the personal lens", () => {
  // Info and HardFork are decided by both chambers; ParamChange and TreasuryWithdrawal are dRep-only.
  const polls = [
    poll({ hostId: 1n, actionType: "Info", closeAt: 500 }),
    poll({ hostId: 2n, actionType: "TreasuryWithdrawal", closeAt: 500 }),
    poll({ hostId: 3n, actionType: "HardFork", closeAt: 500 }),
  ];
  const base = { status: "all", action: null, chamber: "all" } as const;

  it("does not filter at all when the lens is off", () => {
    const out = filterGovPolls(polls, { ...base, lens: "all" }, 100, { roles: [], voted: new Set() });
    expect(out).toHaveLength(3);
  });

  it("keeps only what the viewer's chamber decides", () => {
    const spo = filterGovPolls(polls, { ...base, lens: "eligible" }, 100, {
      roles: ["Spo"],
      voted: new Set(),
    });
    expect(spo.map((p) => p.hostId)).toEqual([1n, 3n]);

    const drep = filterGovPolls(polls, { ...base, lens: "eligible" }, 100, {
      roles: ["DRep"],
      voted: new Set(),
    });
    expect(drep.map((p) => p.hostId)).toEqual([1n, 2n, 3n]);
  });

  it("drops what the viewer has already voted in", () => {
    const out = filterGovPolls(polls, { ...base, lens: "unvoted" }, 100, {
      roles: ["DRep"],
      voted: new Set([2n]),
    });
    expect(out.map((p) => p.hostId)).toEqual([1n, 3n]);
  });

  it("never counts a closed poll as outstanding work", () => {
    const closed = [poll({ hostId: 9n, actionType: "Info", closeAt: 10 })]; // past head 100
    const out = filterGovPolls(closed, { ...base, lens: "unvoted" }, 100, {
      roles: ["Spo"],
      voted: new Set(),
    });
    expect(out).toHaveLength(0);
  });

  it("fails OPEN while the viewer's roles are unknown, rather than painting an empty queue", () => {
    const out = filterGovPolls(polls, { ...base, lens: "eligible" }, 100, {
      roles: null,
      voted: new Set(),
    });
    expect(out).toHaveLength(3);
  });

  // The regression the sibling test above could not catch. It only exercises `eligible`, which fails
  // open inside `eligibleToVote`; `unvoted` reaches a SECOND narrowing (a closed poll is never
  // outstanding work) that ran regardless of whether the roles were known. A signed-out reader on a
  // shared `?v=unvoted` therefore got a list quietly cut down to open polls, with no control on screen
  // to undo it. Needs a CLOSED poll in the set: with everything open both branches agree by accident.
  it("fails OPEN on the unvoted lens too, not just eligible", () => {
    const mixed = [
      poll({ hostId: 1n, actionType: "Info", closeAt: 500 }), // open at head 100
      poll({ hostId: 9n, actionType: "Info", closeAt: 10 }), // closed at head 100
    ];
    const out = filterGovPolls(mixed, { ...base, lens: "unvoted" }, 100, {
      roles: null,
      voted: new Set(),
    });
    expect(out.map((p) => p.hostId)).toEqual([1n, 9n]);
  });

  it("fails OPEN while the voted set has not loaded", () => {
    const out = filterGovPolls(polls, { ...base, lens: "unvoted" }, 100, {
      roles: ["DRep"],
      voted: null,
    });
    expect(out).toHaveLength(3);
  });

  it("ignores the lens entirely when no viewer is supplied", () => {
    expect(filterGovPolls(polls, { ...base, lens: "unvoted" }, 100)).toHaveLength(3);
  });
});
