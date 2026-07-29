import { describe, it, expect } from "vitest";
import { setupStatus } from "./setup-status";
import type { SessionState } from "./session";

const BOUND_STATES: SessionState[] = ["bound", "bound_no_stake", "bound_staked"];

describe("setupStatus — the single setup funnel", () => {
  // Pre-bind phases ignore posting power AND the stake read; pass null for both.
  it("disconnected → not ready, next is connect", () => {
    const s = setupStatus("disconnected", null, null);
    expect(s.phase).toBe("disconnected");
    expect(s.ready).toBe(false);
    expect(s.next).toEqual({ kind: "connect", label: "Connect wallet" });
  });

  it("connecting → not ready, no actionable next step (in flight)", () => {
    const s = setupStatus("connecting", null, null);
    expect(s.phase).toBe("connecting");
    expect(s.ready).toBe(false);
    expect(s.next).toBeNull();
  });

  it("connected_unbound → not ready, next is the identity bind", () => {
    const s = setupStatus("connected_unbound", null, null);
    expect(s.phase).toBe("unbound");
    expect(s.ready).toBe(false);
    expect(s.next).toEqual({ kind: "bind", label: "Finish setup" });
  });

  it("binding → not ready, no actionable next step (in flight)", () => {
    const s = setupStatus("binding", null, null);
    expect(s.phase).toBe("binding");
    expect(s.ready).toBe(false);
    expect(s.next).toBeNull();
  });

  it.each(BOUND_STATES)(
    "%s stake-bound with posting power → ready, no required next step",
    (state) => {
      const s = setupStatus(state, 100_000_000n, true);
      expect(s.phase).toBe("ready");
      expect(s.ready).toBe(true);
      expect(s.next).toBeNull();
      expect(s.headline).toBe("You're all set");
    },
  );

  it.each(BOUND_STATES)(
    "%s WITHOUT a stake bind but WITH posting power → READY. The stake bind is not a posting gate",
    (state) => {
      // The regression this pins: the stake bind writes TalkStake::VotingPower and nothing else, so a
      // bound + locked account posts normally without it. Treating it as required blocked every wallet
      // that cannot sign over a reward address from posting at all.
      const s = setupStatus(state, 100_000_000n, false);
      expect(s.phase).toBe("ready");
      expect(s.ready).toBe(true);
      expect(s.next).toBeNull();
      // Reported, but only as advice.
      expect(s.votingPowerLinked).toBe(false);
    },
  );

  it("never proposes the stake bind as the one required next action, in any reachable state", () => {
    const states = [
      "disconnected", "connecting", "connected_unbound", "binding",
      "bound", "bound_no_stake", "bound_staked",
    ] as const;
    for (const state of states)
      for (const power of [null, 0n, 100_000_000n])
        for (const stake of [null, false, true])
          for (const pending of [false, true])
            expect(setupStatus(state, power, stake, pending).next?.kind).not.toBe("stake");
  });

  it.each(BOUND_STATES)(
    "%s stake-bound with ZERO posting power → not ready, next is to lock ADA",
    (state) => {
      const s = setupStatus(state, 0n, true);
      expect(s.phase).toBe("needs_power");
      expect(s.ready).toBe(false);
      expect(s.next).toEqual({ kind: "lock", label: "Lock ADA" });
    },
  );

  it.each(BOUND_STATES)(
    "%s stake-bound while posting power is still loading → neutral checking state, no action",
    (state) => {
      const s = setupStatus(state, null, true);
      expect(s.phase).toBe("checking_power");
      expect(s.ready).toBe(false);
      expect(s.next).toBeNull();
    },
  );

  it.each(BOUND_STATES)(
    "%s with zero power while the STAKE read loads → still 'lock ADA'. Stake never holds up the lock",
    (state) => {
      // An in-flight stake read used to mask the real next step behind a neutral "checking" state.
      const s = setupStatus(state, 0n, null);
      expect(s.phase).toBe("needs_power");
      expect(s.next).toEqual({ kind: "lock", label: "Lock ADA" });
      expect(s.votingPowerLinked).toBeNull();
    },
  );

  it("stake-bound, zero power, a lock crediting → crediting, no action (don't say 'lock again')", () => {
    const s = setupStatus("bound_staked", 0n, true, true);
    expect(s.phase).toBe("crediting");
    expect(s.ready).toBe(false);
    expect(s.next).toBeNull();
  });

  it("every non-ready phase offers a headline + detail to render", () => {
    for (const state of ["disconnected", "connecting", "connected_unbound", "binding"] as const) {
      const s = setupStatus(state, null, null);
      expect(s.headline.length).toBeGreaterThan(0);
      expect(s.detail.length).toBeGreaterThan(0);
    }
    // bound-but-unlocked likewise renders a full headline + detail.
    const needsLock = setupStatus("bound", 0n, false);
    expect(needsLock.headline.length).toBeGreaterThan(0);
    expect(needsLock.detail.length).toBeGreaterThan(0);
    const unlocked = setupStatus("bound", 0n, true);
    expect(unlocked.headline.length).toBeGreaterThan(0);
    expect(unlocked.detail.length).toBeGreaterThan(0);
  });
});
