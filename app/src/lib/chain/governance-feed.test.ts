import { describe, it, expect } from "vitest";
import { Binary } from "polkadot-api";
import { readGovernancePolls, eligibleToVote, govCloseState } from "./governance-feed";
import type { CognoApi } from "@/lib/types";

type Entry = { keyArgs: [bigint]; value: Record<string, unknown> };
type Bin = ReturnType<typeof Binary.fromText>;

function mockApi(polls: Entry[], results: Entry[], posts: Record<string, { text: Bin }>): CognoApi {
  return {
    query: {
      Microblog: {
        Polls: { getEntries: async () => polls },
        PollResults: { getEntries: async () => results },
        Posts: { getValue: async (id: bigint) => posts[String(id)] ?? null },
      },
    },
  } as unknown as CognoApi;
}

describe("readGovernancePolls", () => {
  it("keeps only action-tagged polls, decodes the type, marks finalized, newest first", async () => {
    const polls: Entry[] = [
      {
        keyArgs: [1n],
        value: {
          action: {
            action_type: { type: "TreasuryWithdrawal" },
            anchor_url: Binary.fromText("https://example.org/p.json"),
          },
          close_at: 100,
        },
      },
      { keyArgs: [2n], value: { action: undefined, close_at: undefined } }, // plain poll — dropped
      { keyArgs: [3n], value: { action: { action_type: 4 }, close_at: undefined } }, // HardFork, no anchor
    ];
    const results: Entry[] = [{ keyArgs: [1n], value: {} }]; // poll 1 is finalized
    const posts = {
      "1": { text: Binary.fromText("Fund the thing?") },
      "3": { text: Binary.fromText("Fork now?") },
    };
    const out = await readGovernancePolls(mockApi(polls, results, posts));
    expect(out.map((p) => p.hostId)).toEqual([3n, 1n]); // newest (higher id) first
    expect(out[0]).toMatchObject({ hostId: 3n, actionType: "HardFork", question: "Fork now?", finalized: false });
    expect(out[0].anchorUrl).toBeUndefined(); // no anchor on this action → undefined
    expect(out[1]).toMatchObject({
      hostId: 1n,
      actionType: "TreasuryWithdrawal",
      question: "Fund the thing?",
      anchorUrl: "https://example.org/p.json",
      closeAt: 100,
      finalized: true,
    });
  });

  it("never throws — a read failure yields []", async () => {
    const api = {
      query: {
        Microblog: {
          Polls: {
            getEntries: async () => {
              throw new Error("rpc down");
            },
          },
          PollResults: { getEntries: async () => [] },
          Posts: { getValue: async () => null },
        },
      },
    } as unknown as CognoApi;
    expect(await readGovernancePolls(api)).toEqual([]);
  });
});

describe("eligibleToVote", () => {
  it("is undefined when the viewer's roles are unknown", () => {
    expect(eligibleToVote("TreasuryWithdrawal", null)).toBeUndefined();
  });
  it("a dRep can vote a dRep-led action; an SPO cannot (Treasury is dRep-only)", () => {
    expect(eligibleToVote("TreasuryWithdrawal", ["DRep"])).toBe(true);
    expect(eligibleToVote("TreasuryWithdrawal", ["Spo"])).toBe(false);
  });
  it("an SPO can vote an SPO+dRep action; a role-less account cannot", () => {
    expect(eligibleToVote("HardFork", ["Spo"])).toBe(true);
    expect(eligibleToVote("HardFork", [])).toBe(false);
  });
});

describe("govCloseState", () => {
  it("final once finalized", () => {
    expect(govCloseState({ finalized: true, closeAt: 5 }, 10)).toBe("final");
  });
  it("provisional past the deadline, open before it (or with no deadline)", () => {
    expect(govCloseState({ finalized: false, closeAt: 10 }, 12)).toBe("provisional");
    expect(govCloseState({ finalized: false, closeAt: 10 }, 5)).toBe("open");
    expect(govCloseState({ finalized: false, closeAt: undefined }, 5)).toBe("open");
  });
});
