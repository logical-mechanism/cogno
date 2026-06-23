import { describe, it, expect } from "vitest";
import { setupStatus } from "./setup-status";
import type { SessionState } from "./session";

describe("setupStatus — the single setup funnel", () => {
  // Pre-bind phases ignore posting power; pass null.
  it("disconnected → not ready, next is connect", () => {
    const s = setupStatus("disconnected", null);
    expect(s.phase).toBe("disconnected");
    expect(s.ready).toBe(false);
    expect(s.next).toEqual({ kind: "connect", label: "Connect wallet" });
  });

  it("connecting → not ready, no actionable next step (in flight)", () => {
    const s = setupStatus("connecting", null);
    expect(s.phase).toBe("connecting");
    expect(s.ready).toBe(false);
    expect(s.next).toBeNull();
  });

  it("connected_unbound → not ready, next is the identity bind", () => {
    const s = setupStatus("connected_unbound", null);
    expect(s.phase).toBe("unbound");
    expect(s.ready).toBe(false);
    expect(s.next).toEqual({ kind: "bind", label: "Finish setup" });
  });

  it("binding → not ready, no actionable next step (in flight)", () => {
    const s = setupStatus("binding", null);
    expect(s.phase).toBe("binding");
    expect(s.ready).toBe(false);
    expect(s.next).toBeNull();
  });

  it.each<SessionState>(["bound", "bound_no_stake", "bound_staked"])(
    "%s with posting power → ready, no required next step (stake is the only optional boost)",
    (state) => {
      const s = setupStatus(state, 100_000_000n);
      expect(s.phase).toBe("ready");
      expect(s.ready).toBe(true);
      expect(s.next).toBeNull();
      expect(s.headline).toBe("You're all set");
    },
  );

  it.each<SessionState>(["bound", "bound_no_stake", "bound_staked"])(
    "%s with ZERO posting power → not ready, next is to lock ADA (binding alone can't post)",
    (state) => {
      const s = setupStatus(state, 0n);
      expect(s.phase).toBe("needs_power");
      expect(s.ready).toBe(false);
      expect(s.next).toEqual({ kind: "lock", label: "Lock ADA" });
    },
  );

  it.each<SessionState>(["bound", "bound_no_stake", "bound_staked"])(
    "%s while posting power is still loading → neutral checking state, no action",
    (state) => {
      const s = setupStatus(state, null);
      expect(s.phase).toBe("checking_power");
      expect(s.ready).toBe(false);
      expect(s.next).toBeNull();
    },
  );

  it("every non-ready phase offers a headline + detail to render", () => {
    for (const state of ["disconnected", "connecting", "connected_unbound", "binding"] as const) {
      const s = setupStatus(state, null);
      expect(s.headline.length).toBeGreaterThan(0);
      expect(s.detail.length).toBeGreaterThan(0);
    }
    // bound-but-unlocked likewise renders a full headline + detail.
    const unlocked = setupStatus("bound", 0n);
    expect(unlocked.headline.length).toBeGreaterThan(0);
    expect(unlocked.detail.length).toBeGreaterThan(0);
  });
});
