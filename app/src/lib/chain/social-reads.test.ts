// Decode-contract tests for `readPoll` — the node-served `MicroblogApi.poll` → `PollView` seam. Guards
// the spec-207 additions (the poll `kind` u8 + the per-option SPO/dRep chamber fields) and the spec-209
// additions: kinds 2 = Spo / 3 = Drep, and the optional governance-action tag
// (`action = { action_type: u8, anchor_url, anchor_hash? }`).

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

  it("maps kind 2 → Spo and kind 3 → Drep (spec 209)", async () => {
    const spo = await readPoll(
      apiWithPoll(
        { host_id: 2n, options: [opt(0, "yes", 0n, 1, 9_000_000n, 1, 0n, 0), opt(1, "no", 0n, 0)], total_votes: 1, kind: 2 },
        { options: [], close_at: undefined },
        undefined,
      ),
      2n,
    );
    expect(spo.kind).toBe("Spo");
    expect(spo.options[0]).toMatchObject({ spoWeight: 9_000_000n, spoCount: 1, drepWeight: 0n, drepCount: 0 });

    const drep = await readPoll(
      apiWithPoll(
        { host_id: 3n, options: [opt(0, "yes", 0n, 1, 0n, 0, 4_000_000n, 1), opt(1, "no", 0n, 0)], total_votes: 1, kind: 3 },
        { options: [], close_at: undefined },
        undefined,
      ),
      3n,
    );
    expect(drep.kind).toBe("Drep");
    expect(drep.options[0]).toMatchObject({ drepWeight: 4_000_000n, drepCount: 1, spoWeight: 0n, spoCount: 0 });
  });

  it("decodes a governance-action tag (type + anchor link); a plain poll's action is undefined", async () => {
    const tagged = await readPoll(
      apiWithPoll(
        {
          host_id: 7n,
          options: [opt(0, "Yes", 0n, 0), opt(1, "No", 0n, 0), opt(2, "Abstain", 0n, 0)],
          total_votes: 0,
          kind: 1,
          action: {
            action_type: 6, // TreasuryWithdrawal
            anchor_url: Binary.fromText("https://github.com/org/proposal"),
            anchor_hash: undefined,
          },
        },
        { options: [], close_at: undefined },
        undefined,
      ),
      7n,
    );
    expect(tagged.action).toEqual({
      actionType: "TreasuryWithdrawal",
      anchorUrl: "https://github.com/org/proposal",
      anchorHash: undefined,
    });

    const plain = await readPoll(
      apiWithPoll(
        { host_id: 8n, options: [opt(0, "a", 0n, 0), opt(1, "b", 0n, 0)], total_votes: 0, kind: 0 },
        { options: [], close_at: undefined },
        undefined,
      ),
      8n,
    );
    expect(plain.action).toBeUndefined();
  });

  it("passes a governance-action anchor_hash (SizedHex) straight through", async () => {
    const hash = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const p = await readPoll(
      apiWithPoll(
        {
          host_id: 11n,
          options: [opt(0, "Yes", 0n, 0), opt(1, "No", 0n, 0)],
          total_votes: 0,
          kind: 2,
          action: { action_type: 0, anchor_url: Binary.fromText("https://ipfs.io/ipfs/cid"), anchor_hash: hash },
        },
        { options: [], close_at: undefined },
        undefined,
      ),
      11n,
    );
    expect(p.action).toMatchObject({ actionType: "Info", anchorUrl: "https://ipfs.io/ipfs/cid", anchorHash: hash });
  });
});
