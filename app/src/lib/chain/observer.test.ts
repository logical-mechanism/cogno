// describeStabilityWindow — the lock-to-credit wait, rendered as copy a user reads BEFORE committing
// 100 real ADA. The two values that matter are the two the chain actually ships.

import { describe, it, expect } from "vitest";
import { describeStabilityWindow, slotToUnixSec, readObserverConfig } from "./observer";

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

describe("readObserverConfig — one round trip per chain handle", () => {
  /** A fake api whose observer_config() counts its calls and can be made to fail. */
  function fakeApi(): { api: never; calls: () => number; fail: (why: string | null) => void } {
    let calls = 0;
    let failWith: string | null = null;
    const api = {
      apis: {
        CardanoObserverApi: {
          observer_config: async () => {
            calls += 1;
            if (failWith) throw new Error(failWith);
            return {
              shelley_start_unix: 1_000_000n,
              shelley_start_slot: 500n,
              stability_slots: 600n,
              stake_epoch_lookback: 2n,
            };
          },
        },
      },
    };
    return {
      api: api as never,
      calls: () => calls,
      fail: (why) => {
        failWith = why;
      },
    };
  }

  it("shares one read across every caller, including concurrent ones", async () => {
    // The value is fixed for the life of a runtime, but the callers are hooks: Settings alone mounts
    // two useStabilityWindows plus a usePendingCapacity, so this was four or five identical runtime-API
    // round trips for a constant.
    const f = fakeApi();
    const [a, b] = await Promise.all([readObserverConfig(f.api), readObserverConfig(f.api)]);
    const c = await readObserverConfig(f.api);
    expect(f.calls()).toBe(1);
    expect(a.stabilitySlots).toBe(600n);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("keys the cache per handle, so a reconnect re-reads", async () => {
    const first = fakeApi();
    const second = fakeApi();
    await readObserverConfig(first.api);
    await readObserverConfig(second.api);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
  });

  it("never caches a FAILURE — a wedged read would freeze the countdown for the connection", async () => {
    const f = fakeApi();
    f.fail("socket closed");
    await expect(readObserverConfig(f.api)).rejects.toThrow(/socket closed/);
    f.fail(null);
    expect((await readObserverConfig(f.api)).stabilitySlots).toBe(600n);
    expect(f.calls()).toBe(2);
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
