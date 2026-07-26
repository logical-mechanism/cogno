// describeStabilityWindow — the lock-to-credit wait, rendered as copy a user reads BEFORE committing
// 100 real ADA. The two values that matter are the two the chain actually ships.

import { describe, it, expect } from "vitest";
import { describeStabilityWindow, slotToUnixSec } from "./observer";

describe("describeStabilityWindow — the two shipped windows", () => {
  it("renders the preprod window (600 slots) as minutes", () => {
    expect(describeStabilityWindow(600n)).toBe("about 10 minutes");
  });

  it("renders the MAINNET window (129,600 slots) as hours, not 'a few minutes'", () => {
    // This is the whole point of reading it. The copy this replaced said "a few minutes" statically,
    // which is a ~200x understatement here: a user is told minutes and waits a day and a half.
    expect(describeStabilityWindow(129_600n)).toBe("about 36 hours");
  });
});

describe("describeStabilityWindow — unit boundaries", () => {
  it("picks a sensible unit across the range", () => {
    expect(describeStabilityWindow(45n)).toBe("about 45 seconds");
    expect(describeStabilityWindow(300n)).toBe("about 5 minutes");
    expect(describeStabilityWindow(7_200n)).toBe("about 2 hours");
    expect(describeStabilityWindow(259_200n)).toBe("about 3 days");
  });

  it("singularizes, so it never says '1 hours'", () => {
    expect(describeStabilityWindow(3_600n)).toBe("about 1 hour");
    expect(describeStabilityWindow(86_400n * 1n)).toBe("about 24 hours");
  });

  it("degrades to a neutral phrase on a nonsense window rather than asserting a duration", () => {
    expect(describeStabilityWindow(0n)).toBe("a moment");
  });
});

describe("slotToUnixSec — the anchor arithmetic the countdown shares", () => {
  it("is a plain offset from the Shelley anchor (1 slot = 1 second)", () => {
    const cfg = {
      shelleyStartUnix: 1_000_000n,
      shelleyStartSlot: 500n,
      stabilitySlots: 600n,
      stakeEpochLookback: 2n,
    };
    expect(slotToUnixSec(500n, cfg)).toBe(1_000_000);
    expect(slotToUnixSec(1_100n, cfg)).toBe(1_000_600);
  });
});
