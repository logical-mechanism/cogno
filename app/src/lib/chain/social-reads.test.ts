// Decode-contract tests for `readPoll` — the node-served `MicroblogApi.poll` → `PollView` seam. Guards
// the spec-207 additions (the poll `kind` u8 + the per-option SPO/dRep chamber fields) and the spec-209
// additions: kinds 2 = Spo / 3 = Drep, and the optional governance-action tag
// (`action = { action_type: u8, anchor_url, anchor_hash? }`).

import { describe, it, expect } from "vitest";
import { Binary } from "polkadot-api";
import { readPoll, readPollChoices } from "./social-reads";
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

// ── readPollChoices — the bounded, author-keyed poll-position read behind the reply vote chip ──
//
// The invariant under test is that the read is keyed by the NAMED authors and answers positionally.
// A whole-set enumeration was rejected precisely because it cannot be capped safely, so the tests here
// pin the batch shape rather than an entry fold.

/** A fake api serving `Polls` (option labels) + a positional `PollVotes.getValues`. */
function apiWithChoices(
  labels: string[] | null,
  votes: Record<string, number>,
  spy?: { keys: (readonly [bigint, string])[] },
): CognoApi {
  return {
    query: {
      Microblog: {
        Polls: {
          getValue: () =>
            Promise.resolve(labels ? { options: labels.map((l) => Binary.fromText(l)) } : undefined),
        },
        PollVotes: {
          getValues: (keys: ReadonlyArray<readonly [bigint, string]>) => {
            if (spy) keys.forEach((k) => spy.keys.push(k));
            return Promise.resolve(keys.map(([, who]) => votes[who]));
          },
        },
      },
    },
  } as unknown as CognoApi;
}

describe("readPollChoices", () => {
  it("issues no read at all for an empty author list", async () => {
    const spy = { keys: [] as (readonly [bigint, string])[] };
    const r = await readPollChoices(apiWithChoices(["Yes"], {}, spy), 7n, []);
    expect(r).toEqual({ labels: [], choices: new Map() });
    expect(spy.keys).toHaveLength(0);
  });

  it("asks for exactly the authors it was given, keyed by (hostId, who)", async () => {
    const spy = { keys: [] as (readonly [bigint, string])[] };
    await readPollChoices(apiWithChoices(["Yes", "No"], {}, spy), 7n, ["addrA", "addrB"]);
    expect(spy.keys).toEqual([
      [7n, "addrA"],
      [7n, "addrB"],
    ]);
  });

  it("keeps option 0 — the falsy-index trap", async () => {
    const r = await readPollChoices(apiWithChoices(["Yes", "No"], { addrA: 0 }), 7n, ["addrA"]);
    expect(r.choices.get("addrA")).toBe(0);
  });

  it("omits an author who has not cast, rather than recording a zero", async () => {
    const r = await readPollChoices(
      apiWithChoices(["Yes", "No"], { addrB: 1 }),
      7n,
      ["addrA", "addrB"],
    );
    expect(r.choices.has("addrA")).toBe(false);
    expect(r.choices.get("addrB")).toBe(1);
  });

  it("zips positionally, so a gap does not shift later authors onto the wrong choice", async () => {
    const r = await readPollChoices(
      apiWithChoices(["Yes", "No", "Abstain"], { addrA: 2, addrC: 1 }),
      7n,
      ["addrA", "addrB", "addrC"],
    );
    expect(r.choices.get("addrA")).toBe(2);
    expect(r.choices.has("addrB")).toBe(false);
    expect(r.choices.get("addrC")).toBe(1);
  });

  it("decodes the option labels off Polls", async () => {
    const r = await readPollChoices(apiWithChoices(["Yes", "No"], {}), 7n, ["addrA"]);
    expect(r.labels).toEqual(["Yes", "No"]);
  });

  it("degrades to no labels when the host is not a poll", async () => {
    const r = await readPollChoices(apiWithChoices(null, { addrA: 0 }), 7n, ["addrA"]);
    expect(r.labels).toEqual([]);
  });

  it("never throws — a failing read yields no choices", async () => {
    const api = {
      query: {
        Microblog: {
          Polls: { getValue: () => Promise.reject(new Error("down")) },
          PollVotes: { getValues: () => Promise.reject(new Error("down")) },
        },
      },
    } as unknown as CognoApi;
    await expect(readPollChoices(api, 7n, ["addrA"])).resolves.toEqual({
      labels: [],
      choices: new Map(),
    });
  });
});
