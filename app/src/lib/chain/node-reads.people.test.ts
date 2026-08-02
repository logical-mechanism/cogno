// Unit tests for the CURSORED people readers (spec 217):
//   - nodeSearchPeople — display-name search
//   - nodeWhoToFollow  — the right-rail suggestions
//
// The defect these pin is REACHABILITY, not ranking. Both runtime reads walk a hash-ordered map under a
// per-call budget of 10,000 EXAMINED rows and both FILTER inside it, so before the cursor a bound account
// whose address hashed past position 10,000 was permanently invisible — its exact display name returned
// "No people found" with no signal that anything had been cut. The reads now hand back the last account
// they examined and `chasePeoplePage` follows it.
//
// The fake API models the runtime's actual contract: a page is `after`-exclusive, holds only rows the
// scan budget reached, and carries `next_cursor` ONLY when the budget was spent (never when the walk
// ended on its own — a cursor there would make a client loop on an empty page for ever).

import { describe, it, expect } from "vitest";
import { Binary } from "polkadot-api";
import { nodeSearchPeople, nodeWhoToFollow } from "./node-reads";
import type { CognoApi, Ss58 } from "@/lib/types";

interface FakePerson {
  account: string;
  name: string;
  followers: number;
}

/** Fold a fake person into the `PersonSummary` shape `personSummaryToSuggestion` decodes. */
function summary(p: FakePerson) {
  return {
    account: p.account,
    display_name: Binary.fromText(p.name),
    avatar: Binary.fromText(""),
    weight: 0n,
    follower_count: p.followers,
    account_tally: { up_weight: 0n, down_weight: 0n, up_count: 0, down_count: 0 },
  };
}

interface Calls {
  search: Array<{ after?: Ss58; limit: number }>;
  who: Array<{ after?: Ss58; limit: number }>;
}

/**
 * A fake node whose walk order is `people` as given (standing in for hash order — arbitrary but stable)
 * and whose per-call scan budget is `budget` ROWS EXAMINED, counted before the filter, exactly as the
 * runtime counts it.
 */
function fakeApi(people: FakePerson[], budget: number) {
  const calls: Calls = { search: [], who: [] };

  const walk = (after: Ss58 | undefined, keep: (p: FakePerson) => boolean, limit: number) => {
    const start = after == null ? 0 : people.findIndex((p) => p.account === after) + 1;
    const window = people.slice(start, start + budget);
    const matched = window.filter(keep);
    matched.sort((a, b) => b.followers - a.followers);
    // A cursor ONLY when the budget was actually spent — i.e. there are more rows past this window.
    const spent = window.length === budget && start + budget < people.length;
    return Promise.resolve({
      people: matched.slice(0, limit).map(summary),
      next_cursor: spent ? window[window.length - 1].account : undefined,
    });
  };

  const api = {
    apis: {
      MicroblogApi: {
        search_people: (
          term: Parameters<typeof Binary.toText>[0],
          limit: number,
          after: Ss58 | undefined,
        ) => {
          calls.search.push({ after, limit });
          const needle = Binary.toText(term).toLowerCase();
          return walk(after, (p) => p.name.toLowerCase().includes(needle), limit);
        },
        who_to_follow: (limit: number, after: Ss58 | undefined) => {
          calls.who.push({ after, limit });
          return walk(after, () => true, limit);
        },
      },
    },
  } as unknown as CognoApi;

  return { api, calls };
}

/** `n` filler people who match nothing, standing in for a ground-credential flood. */
function filler(n: number): FakePerson[] {
  return Array.from({ length: n }, (_, i) => ({
    account: `5filler${i}`,
    name: `zzz${i}`,
    followers: 0,
  }));
}

describe("nodeSearchPeople", () => {
  it("finds a match that sits past the first scan window", async () => {
    // The only matching profile is beyond the first budget's worth of rows. Against the pre-217 read —
    // one call, no cursor — this comes back EMPTY and Explore renders "No people found" for a name that
    // is right there on chain.
    const target: FakePerson = { account: "5target", name: "Alice", followers: 3 };
    const { api, calls } = fakeApi([...filler(25), target], 10);

    const found = await nodeSearchPeople(api, "alice", 20);

    expect(found.map((p) => p.author)).toEqual(["5target"]);
    expect(calls.search.length).toBeGreaterThan(1);
    // Each hop resumes AFTER the previous window's last row, never from the start.
    expect(calls.search[0].after).toBeUndefined();
    expect(calls.search[1].after).toBe("5filler9");
  });

  it("stops as soon as the walk is exhausted, and never loops on a null cursor", async () => {
    const { api, calls } = fakeApi([{ account: "5a", name: "Alice", followers: 1 }], 10);

    const found = await nodeSearchPeople(api, "alice", 20);

    expect(found).toHaveLength(1);
    expect(calls.search).toHaveLength(1);
  });

  it("ranks the assembled union, not just the last page", async () => {
    // The runtime ranks only WITHIN a page, so a high-follower match in a later window would otherwise
    // land below a low-follower one from an earlier window.
    const low: FakePerson = { account: "5low", name: "Alice Low", followers: 1 };
    const high: FakePerson = { account: "5high", name: "Alice High", followers: 99 };
    const { api } = fakeApi([low, ...filler(9), high], 10);

    const found = await nodeSearchPeople(api, "alice", 20);

    expect(found.map((p) => p.author)).toEqual(["5high", "5low"]);
  });

  it("stops once the requested window is full rather than draining the corpus", async () => {
    const { api, calls } = fakeApi(
      Array.from({ length: 60 }, (_, i) => ({
        account: `5a${i}`,
        name: `Alice ${i}`,
        followers: i,
      })),
      10,
    );

    const found = await nodeSearchPeople(api, "alice", 5);

    expect(found).toHaveLength(5);
    expect(calls.search).toHaveLength(1);
  });

  it("does not return the same account twice when a page seam repeats a row", async () => {
    // A profile written between two pages can shift the walk, so the same account can arrive on both.
    const dupe: FakePerson = { account: "5dupe", name: "Alice", followers: 2 };
    const { api } = fakeApi([dupe, ...filler(9), dupe], 10);

    const found = await nodeSearchPeople(api, "alice", 20);

    expect(found.map((p) => p.author)).toEqual(["5dupe"]);
  });
});

describe("nodeWhoToFollow", () => {
  it("reaches suggestions past the first scan window", async () => {
    // who_to_follow filters too (the bound-account gate), so it had the same invisibility defect on top
    // of ranking a truncated candidate pool.
    const best: FakePerson = { account: "5best", name: "Best", followers: 500 };
    const { api, calls } = fakeApi([...filler(15), best], 10);

    const found = await nodeWhoToFollow(api, 20);

    expect(found.map((p) => p.author)).toContain("5best");
    expect(found[0].author).toBe("5best");
    expect(calls.who.length).toBeGreaterThan(1);
  });
});
