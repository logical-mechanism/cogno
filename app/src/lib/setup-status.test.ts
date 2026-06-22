import { describe, it, expect } from "vitest";
import { setupStatus } from "./setup-status";
import type { SessionState } from "./session";

describe("setupStatus — the single setup funnel", () => {
  it("disconnected → not ready, next is connect", () => {
    const s = setupStatus("disconnected");
    expect(s.phase).toBe("disconnected");
    expect(s.ready).toBe(false);
    expect(s.next).toEqual({ kind: "connect", label: "Connect wallet" });
  });

  it("connecting → not ready, no actionable next step (in flight)", () => {
    const s = setupStatus("connecting");
    expect(s.phase).toBe("connecting");
    expect(s.ready).toBe(false);
    expect(s.next).toBeNull();
  });

  it("connected_unbound → not ready, next is the identity bind", () => {
    const s = setupStatus("connected_unbound");
    expect(s.phase).toBe("unbound");
    expect(s.ready).toBe(false);
    expect(s.next).toEqual({ kind: "bind", label: "Finish setup" });
  });

  it("binding → not ready, no actionable next step (in flight)", () => {
    const s = setupStatus("binding");
    expect(s.phase).toBe("binding");
    expect(s.ready).toBe(false);
    expect(s.next).toBeNull();
  });

  it.each<SessionState>(["bound", "bound_no_stake", "bound_staked"])(
    "%s → ready with no required next step (stake/lock are optional boosts)",
    (state) => {
      const s = setupStatus(state);
      expect(s.phase).toBe("ready");
      expect(s.ready).toBe(true);
      expect(s.next).toBeNull();
      expect(s.headline).toBe("You're all set");
    },
  );

  it("every non-ready phase offers a headline + detail to render", () => {
    for (const state of ["disconnected", "connecting", "connected_unbound", "binding"] as const) {
      const s = setupStatus(state);
      expect(s.headline.length).toBeGreaterThan(0);
      expect(s.detail.length).toBeGreaterThan(0);
    }
  });
});
