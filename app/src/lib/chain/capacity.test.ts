// Pure-logic tests for the client-side talk-capacity replay (the ADVISORY mirror of the runtime's
// CheckCapacity). The whole point of this file is that the math matches the runtime VERBATIM, so
// every edge the audit calls out (first-touch=0, ceil-division, weight=0 guard, ceiling clamps)
// gets a test that would FAIL if the replay drifted from the runtime.

import { describe, it, expect } from "vitest";
import {
  capOf,
  postCost,
  currentCapacity,
  computeView,
  draftStatus,
  postsOf,
  type CapacityConsts,
  type CapacityInputs,
} from "./capacity";

// Representative runtime-shaped constants (the exact values are read from metadata at runtime;
// these are deterministic stand-ins with the same units/relationships).
const K: CapacityConsts = {
  capRatio: 10n, // cap = weight * 10, clamped at ceiling
  regenPerBlock: 2n, // rate = weight * 2 per block
  ceiling: 1_000n, // hard cap
  baseCost: 100n, // a post costs 100 + 5/byte
  perByteCost: 5n,
};

describe("capOf — capped-linear ceiling", () => {
  it("is weight*capRatio below the ceiling", () => {
    expect(capOf(50n, K)).toBe(500n);
  });

  it("clamps a massive weight*capRatio to the ceiling (no overflow blow-through)", () => {
    // 1e18 * 10 would be enormous; must clamp to 1000, never the linear value.
    expect(capOf(1_000_000_000_000_000_000n, K)).toBe(1_000n);
  });

  it("is 0 when weight is 0", () => {
    expect(capOf(0n, K)).toBe(0n);
  });

  it("returns exactly the ceiling at the boundary weight", () => {
    // weight*capRatio == ceiling: linear < ceiling is false, so it returns the ceiling.
    expect(capOf(100n, K)).toBe(1_000n);
  });
});

describe("postCost — base + per-byte", () => {
  it("is baseCost for a zero-length draft", () => {
    expect(postCost(0, K)).toBe(100n);
  });

  it("adds perByteCost per UTF-8 byte", () => {
    expect(postCost(10, K)).toBe(100n + 50n);
  });
});

describe("currentCapacity — replay of current_capacity()", () => {
  it("FIRST-TOUCH (bucket=null) returns 0, NOT the cap", () => {
    // ⛔ The load-bearing invariant: a never-bound bucket is EMPTY, not full.
    const inputs: CapacityInputs = { weight: 50n, bucket: null };
    expect(currentCapacity(inputs, 100, K)).toBe(0n);
  });

  it("returns cap_last when no blocks have elapsed", () => {
    const inputs: CapacityInputs = { weight: 50n, bucket: { capLast: 200n, lastBlock: 10 } };
    expect(currentCapacity(inputs, 10, K)).toBe(200n);
  });

  it("regenerates weight*regenPerBlock per elapsed block", () => {
    const inputs: CapacityInputs = { weight: 50n, bucket: { capLast: 0n, lastBlock: 0 } };
    // 5 blocks * 50 weight * 2 rate = 500.
    expect(currentCapacity(inputs, 5, K)).toBe(500n);
  });

  it("clamps regeneration at the cap (never exceeds min(weight*capRatio, ceiling))", () => {
    const inputs: CapacityInputs = { weight: 50n, bucket: { capLast: 0n, lastBlock: 0 } };
    // After 1000 blocks the linear fill would be huge, but cap = min(500, 1000) = 500.
    expect(currentCapacity(inputs, 1000, K)).toBe(500n);
  });

  it("clamps regeneration at the CEILING when weight*capRatio exceeds it", () => {
    const inputs: CapacityInputs = { weight: 500n, bucket: { capLast: 0n, lastBlock: 0 } };
    // cap = min(5000, 1000) = 1000; after enough blocks it must stop at 1000.
    expect(currentCapacity(inputs, 1000, K)).toBe(1_000n);
  });

  it("treats a future-dated lastBlock as zero elapsed (no negative regen)", () => {
    // at < lastBlock would give negative elapsed; Math.max(0, …) must floor it.
    const inputs: CapacityInputs = { weight: 50n, bucket: { capLast: 200n, lastBlock: 100 } };
    expect(currentCapacity(inputs, 50, K)).toBe(200n);
  });
});

describe("computeView", () => {
  it("assembles cap, have, and ratePerBlock consistently", () => {
    const inputs: CapacityInputs = { weight: 50n, bucket: { capLast: 100n, lastBlock: 0 } };
    const v = computeView(inputs, 2, K);
    expect(v.cap).toBe(500n);
    expect(v.ratePerBlock).toBe(100n); // 50 * 2
    expect(v.have).toBe(300n); // 100 + 50*2*2
    expect(v.at).toBe(2);
  });
});

describe("draftStatus — edge ordering is load-bearing", () => {
  const view = (over: Partial<ReturnType<typeof computeView>>) =>
    ({
      weight: 50n,
      bucket: { capLast: 0n, lastBlock: 0 },
      cap: 500n,
      have: 0n,
      ratePerBlock: 100n,
      at: 0,
      ...over,
    }) as ReturnType<typeof computeView>;

  it("weight=0 returns no_weight (a timer is never the answer), NOT div-by-zero", () => {
    const s = draftStatus(view({ weight: 0n, ratePerBlock: 0n, cap: 0n }), 10, K);
    expect(s.kind).toBe("no_weight");
  });

  it("need>cap returns too_long (never postable at this length) before any timer", () => {
    // A 100-byte post costs 100 + 500 = 600 > cap 500.
    const s = draftStatus(view({ have: 500n }), 100, K);
    expect(s.kind).toBe("too_long");
    if (s.kind === "too_long") expect(s.cap).toBe(500n);
  });

  it("have>=need returns ok", () => {
    const s = draftStatus(view({ have: 200n }), 0, K); // need = 100
    expect(s.kind).toBe("ok");
  });

  it("ceil-division: blocks-until-postable rounds UP", () => {
    // need=100, have=0, rate=100 -> exactly 1 block.
    let s = draftStatus(view({ have: 0n }), 0, K);
    expect(s.kind).toBe("wait");
    if (s.kind === "wait") expect(s.blocks).toBe(1);

    // need=100, have=1, rate=100 -> (99 + 99)/100 = 0? No: (100-1+100-1)/100 = 198/100 = 1 (ceil).
    s = draftStatus(view({ have: 1n }), 0, K);
    expect(s.kind).toBe("wait");
    if (s.kind === "wait") expect(s.blocks).toBe(1);

    // need=300 (40-byte post), have=0, rate=100 -> ceil(300/100) = 3.
    s = draftStatus(view({ have: 0n, cap: 500n }), 40, K);
    expect(s.kind).toBe("wait");
    if (s.kind === "wait") expect(s.blocks).toBe(3);

    // need=301, have=0, rate=100 -> ceil(301/100) = 4 (the +rate-1 ceil term).
    const K2: CapacityConsts = { ...K, baseCost: 301n, perByteCost: 0n };
    s = draftStatus(view({ have: 0n, cap: 500n }), 0, K2);
    expect(s.kind).toBe("wait");
    if (s.kind === "wait") expect(s.blocks).toBe(4);
  });

  it("rate=0 (defensive) returns no_weight, guarding the ceil-division /0n", () => {
    // weight nonzero in the view but ratePerBlock forced to 0 — the guard must still fire.
    const s = draftStatus(view({ ratePerBlock: 0n, have: 0n }), 0, K);
    expect(s.kind).toBe("no_weight");
  });

  it("under-budget with a live bucket -> 'wait'; first-touch (no bucket) -> 'charging'", () => {
    const waiting = draftStatus(view({ have: 0n, bucket: { capLast: 0n, lastBlock: 0 } }), 0, K);
    expect(waiting.kind).toBe("wait");
    const charging = draftStatus(view({ have: 0n, bucket: null }), 0, K);
    expect(charging.kind).toBe("charging");
  });
});

describe("postsOf", () => {
  it("is whole-post headroom (floor of amount/baseCost)", () => {
    expect(postsOf(250n, K)).toBe(2); // 250/100 = 2
  });

  it("guards baseCost=0 (no div-by-zero, returns 0)", () => {
    expect(postsOf(250n, { ...K, baseCost: 0n })).toBe(0);
  });
});
