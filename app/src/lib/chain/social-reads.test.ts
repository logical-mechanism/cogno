// Decode-contract tests for `readPoll` — the node-served `MicroblogApi.poll` → `PollView` seam. Guards
// the spec-207 additions: the poll `kind` (a `u8`: 0 = Stake, 1 = Governance) and the per-option SPO +
// dRep chamber fields (`spo_weight`/`spo_count`/`drep_weight`/`drep_count`).

import { describe, it, expect } from "vitest";
import { Binary } from "polkadot-api";
import { readPoll } from "./social-reads";
import type { CognoApi } from "@/lib/types";

/** A minimal fake api serving one poll view + its `Polls`/`PollResults` storage rows to `readPoll`. */
function apiWithPoll(view: unknown, poll: unknown, result: unknown): CognoApi {
  return {
    apis: { MicroblogApi: { poll: () => Promise.resolve(view) } },
    query: {
      Microblog: {
        Polls: { getValue: () => Promise.resolve(poll) },
        PollResults: { getValue: () => Promise.resolve(result) },
      },
    },
  } as unknown as CognoApi;
}

/** One wire-shape option (snake_case, as PAPI decodes it). */
function opt(
  index: number,
  label: string,
  weight: bigint,
  count: number,
  spoW = 0n,
  spoC = 0,
  drepW = 0n,
  drepC = 0,
) {
  return {
    index,
    label: Binary.fromText(label),
    weight,
    count,
    spo_weight: spoW,
    spo_count: spoC,
    drep_weight: drepW,
    drep_count: drepC,
  };
}

describe("readPoll", () => {
  it("decodes a governance poll's kind + SPO/dRep chamber fields", async () => {
    const view = {
      host_id: 5n,
      options: [
        opt(0, "yes", 300n, 3, 15_000_000n, 1, 7_000_000n, 1),
        opt(1, "no", 100n, 1, 5_000_000n, 1, 0n, 0),
      ],
      total_votes: 4,
      kind: 1, // Governance
    };
    const api = apiWithPoll(view, { options: [], close_at: undefined }, undefined);
    const p = await readPoll(api, 5n);

    expect(p.kind).toBe("Governance");
    expect(p.totalWeight).toBe(400n); // holder lens Σ only — chambers are NOT summed in
    expect(p.options[0]).toMatchObject({
      label: "yes",
      weight: 300n,
      count: 3,
      spoWeight: 15_000_000n,
      spoCount: 1,
      drepWeight: 7_000_000n,
      drepCount: 1,
    });
    expect(p.options[1]).toMatchObject({ spoWeight: 5_000_000n, spoCount: 1, drepWeight: 0n, drepCount: 0 });
    expect(p.finalized).toBe(false);
  });

  it("maps kind 0 to a Stake poll with zero chambers, and carries close_at + finalized", async () => {
    const view = {
      host_id: 1n,
      options: [opt(0, "a", 10n, 1), opt(1, "b", 0n, 0)],
      total_votes: 1,
      kind: 0, // Stake
    };
    const api = apiWithPoll(view, { options: [], close_at: 42 }, {}); // a PollResults row ⇒ finalized
    const p = await readPoll(api, 1n);

    expect(p.kind).toBe("Stake");
    expect(p.options.every((o) => o.spoWeight === 0n && o.drepWeight === 0n && o.spoCount === 0 && o.drepCount === 0)).toBe(true);
    expect(p.closeAt).toBe(42);
    expect(p.finalized).toBe(true);
  });

  it("returns a Stake fallback for a missing poll view", async () => {
    const api = apiWithPoll(undefined, undefined, undefined);
    const p = await readPoll(api, 9n);
    expect(p.kind).toBe("Stake");
    expect(p.options).toEqual([]);
    expect(p.totalWeight).toBe(0n);
  });
});
