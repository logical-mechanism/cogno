// Unit tests for the PAPI-direct social reads. social-reads.ts had ZERO coverage despite holding the
// app's most fragile decode: `readPoll` relies on PAPI unwrapping the single-field `Poll` struct to a
// bare `Binary[]` — an assumption that already shipped broken once (commit a157969: every poll rendered
// as a plain, unvotable post). These tests PIN that behaviour: readPoll must accept BOTH the bare array
// (today's reality) AND a `{ options }` wrapper (the fallback if the struct ever gains a field), and the
// viewer/tally reads must honour their ValueQuery defaults + the Reposts unit-key membership test.
// A hand-rolled fake CognoApi backs the keyed storage reads (mirrors reads.test.ts).

import { describe, it, expect } from "vitest";
import {
  readPostTally,
  readRepostCount,
  readViewerPostState,
  readPoll,
  readViewerPollChoice,
} from "./social-reads";
import type { CognoApi, Ss58 } from "@/lib/types";

/** A label as PAPI hands it back from a `Vec<u8>` field: a Binary with `.asText()`. */
const bin = (s: string) => ({ asText: () => s });

const ZERO_TALLY = { up_weight: 0n, down_weight: 0n, up_count: 0, down_count: 0 };

interface SocialSpec {
  voteTally?: Map<bigint, { up_weight: bigint; down_weight: bigint; up_count: number; down_count: number }>;
  repostCount?: Map<bigint, number>;
  /** keyed `${id}:${who}` -> the viewer's VoteRecord (OptionQuery: absent ⇒ undefined). */
  votes?: Map<string, { dir: { type: "Up" | "Down" }; weight: bigint }>;
  /** post id -> the addresses that reposted it (drives the unit-key membership test). */
  reposts?: Map<bigint, string[]>;
  /** post id -> the Polls.getValue shape: a BARE array OR a `{ options }` wrapper. */
  polls?: Map<bigint, ReturnType<typeof bin>[] | { options: ReturnType<typeof bin>[] }>;
  /** keyed `${id}:${optionIdx}` -> the per-option tally (ValueQuery: absent ⇒ zero). */
  pollTally?: Map<string, { weight: bigint; count: number }>;
  /** keyed `${id}:${who}` -> the viewer's poll choice (OptionQuery: absent ⇒ undefined). */
  pollVotes?: Map<string, { option: number }>;
}

function makeFakeApi(spec: SocialSpec): CognoApi {
  return {
    query: {
      Microblog: {
        VoteTally: { getValue: (id: bigint) => Promise.resolve(spec.voteTally?.get(id) ?? ZERO_TALLY) },
        RepostCount: { getValue: (id: bigint) => Promise.resolve(spec.repostCount?.get(id) ?? 0) },
        Votes: {
          getValue: (id: bigint, who: string) => Promise.resolve(spec.votes?.get(`${id}:${who}`)),
        },
        Reposts: {
          getEntries: (id: bigint) =>
            Promise.resolve(
              (spec.reposts?.get(id) ?? []).map((who) => ({ keyArgs: [id, who], value: undefined })),
            ),
        },
        Polls: { getValue: (id: bigint) => Promise.resolve(spec.polls?.get(id)) },
        PollTally: {
          getValue: (id: bigint, idx: number) =>
            Promise.resolve(spec.pollTally?.get(`${id}:${idx}`) ?? { weight: 0n, count: 0 }),
        },
        PollVotes: {
          getValue: (id: bigint, who: string) => Promise.resolve(spec.pollVotes?.get(`${id}:${who}`)),
        },
      },
    },
  } as unknown as CognoApi;
}

describe("readPostTally", () => {
  it("returns the populated tally with score = up_weight - down_weight", async () => {
    const api = makeFakeApi({
      voteTally: new Map([[7n, { up_weight: 50n, down_weight: 8n, up_count: 4, down_count: 1 }]]),
    });
    expect(await readPostTally(api, 7n)).toEqual({
      upWeight: 50n,
      downWeight: 8n,
      upCount: 4,
      downCount: 1,
      score: 42n,
    });
  });

  it("defaults to all-zero for an untallied post (ValueQuery)", async () => {
    const api = makeFakeApi({});
    expect(await readPostTally(api, 999n)).toEqual({
      upWeight: 0n,
      downWeight: 0n,
      upCount: 0,
      downCount: 0,
      score: 0n,
    });
  });
});

describe("readRepostCount", () => {
  it("returns the count, defaulting to 0 (ValueQuery)", async () => {
    const api = makeFakeApi({ repostCount: new Map([[3n, 11]]) });
    expect(await readRepostCount(api, 3n)).toBe(11);
    expect(await readRepostCount(api, 4n)).toBe(0);
  });
});

describe("readViewerPostState", () => {
  const me = "alice" as Ss58;

  it("maps an Up vote + a repost (viewer present in the unit-key entries)", async () => {
    const api = makeFakeApi({
      votes: new Map([[`5:${me}`, { dir: { type: "Up" }, weight: 9n }]]),
      reposts: new Map([[5n, ["bob", "alice"]]]),
    });
    expect(await readViewerPostState(api, 5n, me)).toEqual({ myVote: "Up", reposted: true });
  });

  it("maps a Down vote with no repost", async () => {
    const api = makeFakeApi({
      votes: new Map([[`5:${me}`, { dir: { type: "Down" }, weight: 4n }]]),
      reposts: new Map([[5n, ["bob"]]]),
    });
    expect(await readViewerPostState(api, 5n, me)).toEqual({ myVote: "Down", reposted: false });
  });

  it("returns null/false when the viewer hasn't acted (only OTHERS reposted)", async () => {
    const api = makeFakeApi({ reposts: new Map([[5n, ["bob", "carol"]]]) });
    expect(await readViewerPostState(api, 5n, me)).toEqual({ myVote: null, reposted: false });
  });
});

describe("readPoll — the single-field struct-unwrap regression (a157969)", () => {
  const wantOptions = [
    { index: 0, label: "Yes", weight: 30n, count: 2 },
    { index: 1, label: "No", weight: 10n, count: 1 },
  ];
  const pollTally = new Map([
    [`1:0`, { weight: 30n, count: 2 }],
    [`1:1`, { weight: 10n, count: 1 }],
  ]);

  it("decodes the BARE Binary[] PAPI actually returns today", async () => {
    const api = makeFakeApi({ polls: new Map([[1n, [bin("Yes"), bin("No")]]]), pollTally });
    expect(await readPoll(api, 1n)).toEqual({
      hostId: 1n,
      options: wantOptions,
      totalWeight: 40n,
      totalCount: 3,
    });
  });

  it("ALSO tolerates a { options } wrapper (if Poll ever gains a second field) — identical result", async () => {
    const api = makeFakeApi({ polls: new Map([[1n, { options: [bin("Yes"), bin("No")] }]]), pollTally });
    expect(await readPoll(api, 1n)).toEqual({
      hostId: 1n,
      options: wantOptions,
      totalWeight: 40n,
      totalCount: 3,
    });
  });

  it("returns an empty poll for a None host (no poll attached)", async () => {
    const api = makeFakeApi({});
    expect(await readPoll(api, 1n)).toEqual({ hostId: 1n, options: [], totalWeight: 0n, totalCount: 0 });
  });

  it("handles an empty options array without throwing", async () => {
    const api = makeFakeApi({ polls: new Map([[1n, []]]) });
    expect(await readPoll(api, 1n)).toEqual({ hostId: 1n, options: [], totalWeight: 0n, totalCount: 0 });
  });

  it("defaults a missing PollTally option to zero weight/count (ValueQuery)", async () => {
    // Two options, but only option 0 has a tally entry — option 1 must read as zero, not throw.
    const api = makeFakeApi({
      polls: new Map([[1n, [bin("A"), bin("B")]]]),
      pollTally: new Map([[`1:0`, { weight: 5n, count: 1 }]]),
    });
    const res = await readPoll(api, 1n);
    expect(res.options[1]).toEqual({ index: 1, label: "B", weight: 0n, count: 0 });
    expect(res.totalWeight).toBe(5n);
    expect(res.totalCount).toBe(1);
  });
});

describe("readViewerPollChoice", () => {
  const me = "alice" as Ss58;
  it("returns the chosen option index, or null when uncast", async () => {
    const api = makeFakeApi({ pollVotes: new Map([[`1:${me}`, { option: 1 }]]) });
    expect(await readViewerPollChoice(api, 1n, me)).toBe(1);
    expect(await readViewerPollChoice(api, 1n, "bob" as Ss58)).toBeNull();
  });
});
