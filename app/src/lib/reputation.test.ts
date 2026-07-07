import { describe, it, expect } from "vitest";
import { reputationBadge } from "./reputation";

describe("reputationBadge", () => {
  it("hides an unknown / still-loading score", () => {
    expect(reputationBadge(null)).toBeNull();
    expect(reputationBadge(undefined)).toBeNull();
  });

  it("hides a neutral net-zero score (no reputation votes yet)", () => {
    expect(reputationBadge(0n)).toBeNull();
  });

  it("tones a positive net score 'up' with an explicit + sign", () => {
    const view = reputationBadge(32_000_000n * 1_000_000n); // 32M ADA in lovelace
    expect(view).not.toBeNull();
    expect(view!.tone).toBe("up");
    expect(view!.label.startsWith("+")).toBe(true);
  });

  it("tones a negative net score 'down' with a leading minus", () => {
    const view = reputationBadge(-1_500n * 1_000_000n); // −1.5K ADA in lovelace
    expect(view).not.toBeNull();
    expect(view!.tone).toBe("down");
    // formatSignedWeight uses the U+2212 minus sign for negatives.
    expect(view!.label.startsWith("−")).toBe(true);
  });

  it("hides a nonzero score below the 0.1-ADA display floor (would render as '+0'/'−0')", () => {
    // 1 lovelace and −50000 lovelace are nonzero but round to "0" ADA in the compact display; a
    // "+0"/"−0" chip is the very zero-noise the badge suppresses, so it must hide.
    expect(reputationBadge(1n)).toBeNull();
    expect(reputationBadge(-50_000n)).toBeNull();
  });

  it("shows once the magnitude reaches the 0.1-ADA display floor", () => {
    expect(reputationBadge(100_000n)!.tone).toBe("up"); // 0.1 ADA
    expect(reputationBadge(-100_000n)!.tone).toBe("down");
  });
});
