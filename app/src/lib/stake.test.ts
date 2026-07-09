import { describe, it, expect } from "vitest";
import { stakeTier, avatarRing } from "./stake";

const ADA = 1_000_000n; // lovelace per ADA

describe("stakeTier — weight (lovelace) → monochrome ring tier", () => {
  it("no ring for null / zero / negative", () => {
    expect(stakeTier(null)).toBe(0);
    expect(stakeTier(undefined)).toBe(0);
    expect(stakeTier(0n)).toBe(0);
    expect(stakeTier(-5n)).toBe(0);
  });

  it("tier 1 for any positive stake below 10K ADA", () => {
    expect(stakeTier(1n)).toBe(1);
    expect(stakeTier(100n * ADA)).toBe(1); // 100 ADA (the flat posting deposit, if VotingPower==that)
    expect(stakeTier(9_999n * ADA)).toBe(1);
  });

  it("tier 2 from 10K ADA up to (not incl.) 100K ADA", () => {
    expect(stakeTier(10_000n * ADA)).toBe(2); // exact floor
    expect(stakeTier(15_927n * ADA)).toBe(2); // a live-chain account (~15.9K ADA)
    expect(stakeTier(99_999n * ADA)).toBe(2);
  });

  it("tier 3 from 100K ADA up (large u128 stays exact)", () => {
    expect(stakeTier(100_000n * ADA)).toBe(3); // exact floor
    expect(stakeTier(50_000_000n * ADA)).toBe(3); // 50M ADA whale, > 2^53 lovelace
  });
});

describe("avatarRing — tier + red danger override, with self-hide", () => {
  it("hides (null) only when tier 0 AND reputation non-disputed", () => {
    expect(avatarRing(0n, 0n)).toBeNull();
    expect(avatarRing(null, null)).toBeNull();
    expect(avatarRing(0n, 500n * ADA)).toBeNull(); // positive rep, no stake → still nothing to draw
  });

  it("shows the tier ring (no danger) for staked, non-negative reputation", () => {
    expect(avatarRing(100n * ADA, 0n)).toEqual({ tier: 1, danger: false });
    expect(avatarRing(15_927n * ADA, 999n * ADA)).toEqual({ tier: 2, danger: false });
    expect(avatarRing(100_000n * ADA, null)).toEqual({ tier: 3, danger: false });
  });

  it("disputed (net-negative) reputation forces the red ring at EVERY tier, including tier 0", () => {
    expect(avatarRing(0n, -1n * ADA)).toEqual({ tier: 0, danger: true });
    expect(avatarRing(null, -1n * ADA)).toEqual({ tier: 0, danger: true });
    expect(avatarRing(100n * ADA, -50n * ADA)).toEqual({ tier: 1, danger: true });
    expect(avatarRing(200_000n * ADA, -5n * ADA)).toEqual({ tier: 3, danger: true });
  });

  // The ring and the ReputationBadge next to the name must never disagree: the badge hides a score
  // whose magnitude rounds below the 0.1-ADA display floor ("−0"), so the ring must stay neutral too.
  it("does NOT red-ring a dust-negative score the ReputationBadge hides", () => {
    expect(avatarRing(0n, -1n)).toBeNull(); // 1 lovelace net-negative → badge hidden → no ring
    expect(avatarRing(0n, -99_999n)).toBeNull(); // just under the 0.1-ADA floor
    expect(avatarRing(100n * ADA, -99_999n)).toEqual({ tier: 1, danger: false });
  });

  it("red-rings from the exact 0.1-ADA display floor up (where the badge first appears)", () => {
    expect(avatarRing(0n, -100_000n)).toEqual({ tier: 0, danger: true });
  });
});
