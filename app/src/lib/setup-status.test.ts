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
    "%s WITHOUT a stake bind → not ready, next is add voting power (mandatory, before the lock)",
    (state) => {
      // Even WITH posting power, an account that never bound its stake key is setup-incomplete.
      const s = setupStatus(state, 100_000_000n, false);
      expect(s.phase).toBe("needs_voting_power");
      expect(s.ready).toBe(false);
      expect(s.next).toEqual({ kind: "stake", label: "Add voting power" });
    },
  );

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
    "%s while the STAKE read is still loading → neutral checking (never flash 'add voting power')",
    (state) => {
      const s = setupStatus(state, 0n, null);
      expect(s.phase).toBe("checking_power");
      expect(s.ready).toBe(false);
      expect(s.next).toBeNull();
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
    // needs-voting-power and bound-but-unlocked likewise render a full headline + detail.
    const needsStake = setupStatus("bound", 100_000_000n, false);
    expect(needsStake.headline.length).toBeGreaterThan(0);
    expect(needsStake.detail.length).toBeGreaterThan(0);
    const unlocked = setupStatus("bound", 0n, true);
    expect(unlocked.headline.length).toBeGreaterThan(0);
    expect(unlocked.detail.length).toBeGreaterThan(0);
  });
});
