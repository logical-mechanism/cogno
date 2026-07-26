// describeStabilityWindow — the lock-to-credit wait, rendered as copy a user reads BEFORE committing
// 100 real ADA. The two values that matter are the two the chain actually ships.

import { describe, it, expect } from "vitest";
import {
  describeStabilityWindow,
  slotToUnixSec,
  readObserverConfig,
  classifyObserverHealth,
  type ObserverLiveness,
} from "./observer";

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
      vaultPolicyId: "16".repeat(14),
    };
    expect(slotToUnixSec(500n, cfg)).toBe(1_000_000);
    expect(slotToUnixSec(1_100n, cfg)).toBe(1_000_600);
  });
});

// classifyObserverHealth — the read half of an alarm that, until now, reached nobody at all.
//
// The observer inherent is the SOLE writer of talk-capacity weight, voting power and role badges. When
// it freezes, all three stop and every other liveness signal in the stack stays green: blocks are still
// produced, GRANDPA still finalizes, the socket stays up, the feed keeps moving. The pallet latches
// `CardanoObserver.Stalled` for exactly this, and nothing read it; the node-side Prometheus gauges are
// a different signal, and the shipped alertmanager config has every notifier commented out.
//
// These pin the pallet's rules, because a wrong verdict here is worse than no verdict: it either
// suppresses a real freeze or tells a healthy chain it is broken.
describe("classifyObserverHealth", () => {
  const base: ObserverLiveness = {
    latched: false,
    lastAppliedAt: 1_000,
    bestBlock: 1_005,
    stallAfter: 50,
    everObserved: true,
  };

  it("is ok while the gap is inside the window", () => {
    expect(classifyObserverHealth(base).kind).toBe("ok");
  });

  it("uses the pallet's STRICT >, so a gap exactly equal to StallAfter is still ok", () => {
    // pallets/cardano-observer: `if blocks <= T::StallAfter::get() { return ... }`. An off-by-one here
    // would fire the banner one block before the chain agrees, on every single stall.
    expect(classifyObserverHealth({ ...base, bestBlock: 1_050 }).kind).toBe("ok");
    expect(classifyObserverHealth({ ...base, bestBlock: 1_051 }).kind).toBe("stalled");
  });

  it("derives a stall even before the on-chain latch has armed", () => {
    // The latch is a LAGGING signal by design: on_initialize runs before the block's inherents, so it
    // fires on a gap already over the threshold. Deriving it too means the UI and the chain agree on
    // the same block instead of the UI trailing.
    const h = classifyObserverHealth({ ...base, latched: false, bestBlock: 1_400 });
    expect(h).toEqual({ kind: "stalled", blocks: 400 });
  });

  it("honours the latch even when the derived gap looks fine", () => {
    expect(classifyObserverHealth({ ...base, latched: true }).kind).toBe("stalled");
  });

  it("never reports a NEGATIVE stall length from a lagging LastAppliedAt read", () => {
    // watchValue subscriptions land independently, so lastAppliedAt can briefly be AHEAD of the
    // bestBlock this hook was handed. "Paused (-3 blocks)" is not a thing to show anyone.
    const h = classifyObserverHealth({ ...base, latched: true, lastAppliedAt: 1_008 });
    expect(h.kind === "stalled" && h.blocks >= 0).toBe(true);
  });

  it("calls a chain that never observed 'never-started', not 'stalled'", () => {
    // THE CASE THE AUDIT SINGLED OUT. The alarm can only arm after at least one successful observation
    // (the pallet guards on LastReference being Some), so a chain that never started has an
    // arbitrarily large gap and no latch. `--dev` is exactly this: no db-sync, so the inherent abstains
    // on every block forever. Reporting it as stalled would shout on every dev run.
    const h = classifyObserverHealth({
      ...base,
      everObserved: false,
      latched: false,
      lastAppliedAt: 1,
      bestBlock: 999_999,
    });
    expect(h.kind).toBe("never-started");
  });

  it("prefers 'never-started' over a latched flag left behind in old state", () => {
    // A dev chain that latched under an earlier build carries Stalled = true in state forever.
    const h = classifyObserverHealth({ ...base, everObserved: false, latched: true });
    expect(h.kind).toBe("never-started");
  });

  it("says 'unknown' rather than guessing while any input is unresolved", () => {
    // Fail SILENT, never alarming: an unresolved read is not a diagnosis, and an RPC hiccup must not
    // tell every reader on the site that the chain has stopped.
    for (const patch of [
      { everObserved: null },
      { bestBlock: null },
      { stallAfter: null },
      { lastAppliedAt: null, latched: false },
    ] as Partial<ObserverLiveness>[]) {
      expect(classifyObserverHealth({ ...base, ...patch }).kind).toBe("unknown");
    }
  });

  it("still reports a stall when the latch is set but LastAppliedAt has not resolved", () => {
    // The latch alone is enough to be truthful; only the reported length needs the second read.
    const h = classifyObserverHealth({ ...base, latched: true, lastAppliedAt: null });
    expect(h).toEqual({ kind: "stalled", blocks: 50 });
  });

  it("treats a failed Stalled read (false) as not-stalled but still derives from the gap", () => {
    // useObserverHealth falls back to `latched: false` on a read error, matching usePendingCapacity's
    // conservative convention. The derived gap is what keeps that fallback from hiding a real freeze.
    expect(classifyObserverHealth({ ...base, latched: false, bestBlock: 1_060 }).kind).toBe("stalled");
  });
});
