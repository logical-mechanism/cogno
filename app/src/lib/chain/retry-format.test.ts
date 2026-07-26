// The retry countdown's units.
//
// Spec 212 retuned talk-capacity from a dev-tuned 25-block refill to a real ~5 hour window, which moved
// this copy's realistic range from "a few seconds" to "a few minutes". The formatter is pinned here
// because the failure is silent: a bare seconds count still renders, it just stops being readable.

import { describe, it, expect } from "vitest";
import { formatRetry } from "@/components/RateLimitNotice";

describe("formatRetry", () => {
  it("keeps seconds under a minute", () => {
    expect(formatRetry(1)).toBe("1s");
    expect(formatRetry(6)).toBe("6s");
    expect(formatRetry(59)).toBe("59s");
  });

  it("rounds up to whole seconds (never promises sooner than the truth)", () => {
    expect(formatRetry(5.1)).toBe("6s");
  });

  it("switches to minutes at a minute, rounding up", () => {
    expect(formatRetry(60)).toBe("1 min");
    expect(formatRetry(61)).toBe("2 min");
    // The realistic worst case at the spec-212 constants: a full 512-byte post from an empty bucket
    // at the 100-ADA floor lock is 46 blocks = 276s. This is the case the old `~276s` copy failed.
    expect(formatRetry(276)).toBe("5 min");
  });

  it("switches to hours past an hour, and singularizes exactly one", () => {
    expect(formatRetry(3600)).toBe("1 hour");
    expect(formatRetry(5400)).toBe("1.5 hours");
    // A full empty-to-full refill is 3,000 blocks = 5 hours.
    expect(formatRetry(18_000)).toBe("5 hours");
  });
});
