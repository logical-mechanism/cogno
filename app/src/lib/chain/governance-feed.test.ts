import { describe, it, expect, vi, afterEach } from "vitest";
import { Binary } from "polkadot-api";
import { readGovernancePolls, eligibleToVote, govCloseState } from "./governance-feed";
import type { CognoApi } from "@/lib/types";

type Entry = { keyArgs: [bigint]; value: Record<string, unknown> };
type Bin = ReturnType<typeof Binary.fromText>;

function mockApi(
  polls: Entry[],
  results: Entry[],
  posts: Record<string, { text: Bin }>,
  replies: Record<string, number> = {},
): CognoApi {
  return {
    query: {
      Microblog: {
        Polls: { getEntries: async () => polls },
        PollResults: { getEntries: async () => results },
        Posts: { getValue: async (id: bigint) => posts[String(id)] ?? null },
        // ReplyCount must be present even when a case does not care about it: the reader batches it
        // for every row, and a missing stub would throw on the member access rather than reject, which
        // no `.catch` on the call can intercept.
        ReplyCount: {
          getValues: async (keys: ReadonlyArray<readonly [bigint]>) =>
            keys.map(([id]) => replies[String(id)] ?? 0),
        },
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

// The serve denylist on /governance. This path reads Microblog.Posts DIRECTLY rather than through the
// FeedSource, so it gets no filtering for free — and it shipped checking only the POST id. An operator
// who denied an ACCOUNT saw the delisting hold on Home, Explore, search, that account's profile and the
// post's own permalink, while /governance quietly kept rendering their poll question, both in the row
// and in the browser tab title. "It looks like it worked everywhere I checked" is the worst shape a
// hole in this lever can take.
describe("the operator serve denylist on /governance", () => {
  const DENIED = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const ANCHOR = "https://example.org/proposal.json";
  const PINNED = `0x${"ab".repeat(32)}`;

  /** The mock has to be installed per test (doMock is not hoisted), so it is torn down per test too. */
  function denyOnlyThatAuthor() {
    vi.resetModules();
    vi.doMock("@/lib/config/denylist", () => ({
      isDeniedAuthor: (a: string | null | undefined) => a === DENIED,
      isDeniedPost: () => false,
    }));
  }

  // In `afterEach`, NOT at the end of each test body. A failing `expect` throws, which is exactly what
  // happens when the code under test regresses — and the teardown that followed it inline then never
  // ran, leaving the mocked denylist registered for every later dynamic import in this file. A broken
  // assertion would have taken unrelated tests with it.
  afterEach(() => {
    vi.doUnmock("@/lib/config/denylist");
    vi.resetModules();
  });

  const govPoll: Entry[] = [
    {
      keyArgs: [1n],
      value: {
        action: {
          action_type: { type: "HardFork" },
          anchor_url: Binary.fromText(ANCHOR),
          anchor_hash: PINNED,
        },
        close_at: undefined,
      },
    },
  ];

  it("drops the question text of a poll authored by a denied account", async () => {
    denyOnlyThatAuthor();
    const { readGovernancePolls: read } = await import("./governance-feed");
    const posts = { "1": { text: Binary.fromText("Vote for me"), author: DENIED } };
    const out = await read(mockApi(govPoll, [], posts));
    expect(out).toHaveLength(1); // the row itself still exists; only the served TEXT is withheld
    expect(out[0].question).toBe("");
  });

  // The anchor is the OTHER author-supplied field on the row. ProposalTitle fetches it and renders the
  // document's title, so keeping it would leave the delisted account with text on the page and would
  // send every /governance visitor to a host that account chose.
  it("drops the author-supplied anchor URL too, so nothing fetches it", async () => {
    denyOnlyThatAuthor();
    const { readGovernancePolls: read } = await import("./governance-feed");
    const posts = { "1": { text: Binary.fromText("Vote for me"), author: DENIED } };
    const out = await read(mockApi(govPoll, [], posts));
    expect(out[0].anchorUrl).toBeUndefined();
    // The pin goes with the URL it commits to. A hash with no anchor to check it against is unusable,
    // and a denied row fetches nothing to compare.
    expect(out[0].anchorHash).toBeUndefined();
  });

  it("leaves a poll by an undenied account alone", async () => {
    denyOnlyThatAuthor();
    const { readGovernancePolls: read } = await import("./governance-feed");
    const posts = { "1": { text: Binary.fromText("Fork now?"), author: "5SomeoneElse" } };
    const out = await read(mockApi(govPoll, [], posts));
    expect(out[0].question).toBe("Fork now?");
    expect(out[0].anchorUrl).toBe(ANCHOR);
  });

  // The list surface has to be able to check the pin itself. Without the hash on the row, a reader
  // scanning /governance would take in a substituted document's title as the row headline, with the
  // warning that contradicts it sitting behind a poll they never opened.
  it("carries the pinned anchor hash onto the row", async () => {
    denyOnlyThatAuthor();
    const { readGovernancePolls: read } = await import("./governance-feed");
    const posts = { "1": { text: Binary.fromText("Fork now?"), author: "5SomeoneElse" } };
    const out = await read(mockApi(govPoll, [], posts));
    expect(out[0].anchorHash).toBe(PINNED);
  });
});
