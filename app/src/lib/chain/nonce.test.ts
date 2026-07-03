import { describe, it, expect } from "vitest";
import { takeNonce, settleNonce } from "./nonce";
import type { CognoApi } from "@/lib/types";

// A fake api whose System.Account nonce is whatever `nonce` currently is; `reads` counts chain reads.
function fakeApi(nonce: () => number) {
  let reads = 0;
  const api = {
    query: {
      System: {
        Account: {
          getValue: async (_ss58: string, _opts?: unknown) => {
            reads++;
            return { nonce: nonce() };
          },
        },
      },
    },
  } as unknown as CognoApi;
  return { api, reads: () => reads };
}

describe("nonce manager", () => {
  it("hands out MONOTONIC nonces while the chain nonce is unchanged (the Stale-collision fix)", async () => {
    const { api } = fakeApi(() => 5);
    const a = await takeNonce(api, "acctA");
    const b = await takeNonce(api, "acctA");
    const c = await takeNonce(api, "acctA");
    // Chain says 5 for all three, but each in-flight write gets the next nonce — no collision.
    expect([a, b, c]).toEqual([5, 6, 7]);
  });

  it("resyncs from chain once the account goes idle (all writes settled)", async () => {
    let chain = 10;
    const { api } = fakeApi(() => chain);
    const a = await takeNonce(api, "acctB"); // 10
    const b = await takeNonce(api, "acctB"); // 11
    expect([a, b]).toEqual([10, 11]);
    // Both land on chain → chain nonce advances; settle both → idle → next take re-reads chain.
    chain = 12;
    settleNonce("acctB");
    settleNonce("acctB");
    const c = await takeNonce(api, "acctB");
    expect(c).toBe(12);
  });

  it("keeps the local counter while writes are still in flight (does not resync early)", async () => {
    let chain = 0;
    const { api } = fakeApi(() => chain);
    const a = await takeNonce(api, "acctC"); // 0
    const b = await takeNonce(api, "acctC"); // 1
    settleNonce("acctC"); // one settles, one still in flight → do NOT reset
    // chain hasn't observed the in-flight write yet (still 0); the counter must not hand out 0 again.
    const c = await takeNonce(api, "acctC");
    expect([a, b, c]).toEqual([0, 1, 2]);
  });

  it("takes the chain nonce as a floor when it jumps ahead of the local counter", async () => {
    let chain = 3;
    const { api } = fakeApi(() => chain);
    const a = await takeNonce(api, "acctD"); // 3
    expect(a).toBe(3);
    // An out-of-band write (another device) bumps the chain nonce past our counter.
    chain = 20;
    const b = await takeNonce(api, "acctD"); // max(20, 4) = 20
    expect(b).toBe(20);
  });

  it("serializes concurrent takes so they never share a nonce", async () => {
    const { api } = fakeApi(() => 100);
    const [a, b, c, d] = await Promise.all([
      takeNonce(api, "acctE"),
      takeNonce(api, "acctE"),
      takeNonce(api, "acctE"),
      takeNonce(api, "acctE"),
    ]);
    expect(new Set([a, b, c, d]).size).toBe(4); // all distinct
    expect([a, b, c, d].sort((x, y) => x - y)).toEqual([100, 101, 102, 103]);
  });
});
