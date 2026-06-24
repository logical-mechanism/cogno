import { describe, it, expect } from "vitest";
import { formatCount, formatWeight, formatSignedWeight, weightPercent } from "./format";

describe("formatCount — compact action-row counts", () => {
  it("hides zero / non-finite, shows small counts raw, compacts K/M", () => {
    expect(formatCount(0)).toBe("");
    expect(formatCount(null)).toBe("");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1500)).toBe("1.5K");
    expect(formatCount(1_200_000)).toBe("1.2M");
  });
});

describe("formatSignedWeight — lovelace → ADA, signed + compacted", () => {
  it("zero and null/undefined", () => {
    expect(formatSignedWeight(0n)).toBe("0");
    expect(formatSignedWeight(null)).toBe("");
    expect(formatSignedWeight(undefined)).toBe("");
  });

  it("converts lovelace to ADA before compacting", () => {
    expect(formatSignedWeight(32_000_000n)).toBe("+32"); // 32 ADA
    expect(formatSignedWeight(32_500_000n)).toBe("+32.5"); // 32.5 ADA
    expect(formatSignedWeight(100_000_000n)).toBe("+100"); // 100 ADA
    expect(formatSignedWeight(500_000n)).toBe("+0.5"); // 0.5 ADA
  });

  it("reduces thousands/millions of ADA to K/M and renders the sign", () => {
    expect(formatSignedWeight(1_000_000_000n)).toBe("+1K"); // 1,000 ADA
    expect(formatSignedWeight(-2_000_000_000n)).toBe("−2K"); // 2,000 ADA (unicode minus)
    expect(formatSignedWeight(1_000_000_000_000n)).toBe("+1M"); // 1,000,000 ADA
    expect(formatSignedWeight(32_000_000_000_000n)).toBe("+32M"); // 32,000,000 ADA
  });
});

describe("formatWeight — lovelace → ADA, unsigned + compacted", () => {
  it("null/zero", () => {
    expect(formatWeight(null)).toBe("");
    expect(formatWeight(0n)).toBe("0");
  });

  it("compacts in ADA with a plain minus for negatives", () => {
    expect(formatWeight(32_000_000n)).toBe("32"); // 32 ADA
    expect(formatWeight(-1_500_000_000n)).toBe("-1.5K"); // 1,500 ADA
  });
});

describe("weightPercent", () => {
  it("is share of total, rounded; guards a zero total", () => {
    expect(weightPercent(1n, 0n)).toBe(0);
    expect(weightPercent(1n, 4n)).toBe(25);
    expect(weightPercent(1n, 3n)).toBe(33);
  });
});
