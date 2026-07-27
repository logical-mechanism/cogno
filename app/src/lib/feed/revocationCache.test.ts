// F16 — the seam's own contract, asserted. `lib/feed/constants.ts` opens by saying a node-served page
// "comes back in ONE state_call (no ~5-reads-per-post fan-out)"; `flagRevocations` was the fan-out that
// survived it, and /post's per-block thread re-read turned it into one request per participant every
// ~6s, forever, for a committee-gated tombstone.

import { describe, it, expect } from "vitest";
import { createRevocationCache } from "./revocationCache";

const A = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

function counting(answer: (a: string) => boolean = () => false) {
  const calls: string[] = [];
  return {
    calls,
    read: async (a: string) => {
      calls.push(a);
      return answer(a);
    },
  };
}

describe("createRevocationCache", () => {
  it("reads each distinct author exactly once, however many times it is asked", async () => {
    const { calls, read } = counting();
    const cache = createRevocationCache(read);
    // A page of ten posts by two authors, then the same thread re-read on each of five blocks.
    for (let block = 0; block < 5; block++) {
      await Promise.all([cache.get(A), cache.get(B), cache.get(A), cache.get(B)]);
    }
    expect(calls).toEqual([A, B]);
  });

  it("shares ONE in-flight read between callers in the same tick", async () => {
    const { calls, read } = counting();
    const cache = createRevocationCache(read);
    await Promise.all([cache.get(A), cache.get(A), cache.get(A)]);
    expect(calls).toHaveLength(1);
  });

  it("returns the real answer, not just a cached shape", async () => {
    const { read } = counting((a) => a === B);
    const cache = createRevocationCache(read);
    expect(await cache.get(A)).toBe(false);
    expect(await cache.get(B)).toBe(true);
    expect(await cache.get(B)).toBe(true); // from cache
  });

  it("re-reads once the TTL expires, so a fresh revocation lands without a reload", async () => {
    const { calls, read } = counting();
    let clock = 1_000;
    const cache = createRevocationCache(read, 1_000, () => clock);
    await cache.get(A);
    clock += 999;
    await cache.get(A);
    expect(calls).toHaveLength(1);
    clock += 2;
    await cache.get(A);
    expect(calls).toHaveLength(2);
  });

  it("does not cache a failed read, and still surfaces the failure", async () => {
    // A stuck failure would pin every post by that author to a guessed answer for the whole TTL.
    let fail = true;
    const calls: string[] = [];
    const cache = createRevocationCache(async (a) => {
      calls.push(a);
      if (fail) throw new Error("node down");
      return true;
    });
    await expect(cache.get(A)).rejects.toThrow("node down");
    fail = false;
    expect(await cache.get(A)).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
