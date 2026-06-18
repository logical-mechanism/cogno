// Pure-logic tests for the read/write boot guard. The guard compares the live runtime spec to
// what the app was built against: a spec_name mismatch (wrong chain) must set ok=false; a failed
// read must yield a not-ok guard WITH a reason rather than throwing (boot must never crash). The
// descriptor spec_version is null here, so version is intentionally NOT gated.

import { describe, it, expect } from "vitest";
import { checkBootGuard } from "./client";
import type { CognoApi } from "@/lib/types";

// A fake api whose System.Version() resolves to a controllable version (or throws).
function apiWith(version: { spec_name: string; spec_version: number } | (() => never)): CognoApi {
  return {
    constants: {
      System: {
        Version: async () => (typeof version === "function" ? version() : version),
      },
    },
  } as unknown as CognoApi;
}

describe("checkBootGuard", () => {
  it("ok=true when the spec_name matches and the descriptor version is unpinned (null)", async () => {
    const g = await checkBootGuard(apiWith({ spec_name: "cogno-chain-runtime", spec_version: 107 }));
    expect(g.ok).toBe(true);
    expect(g.nodeSpecName).toBe("cogno-chain-runtime");
    expect(g.nodeSpecVersion).toBe(107);
    expect(g.descriptorSpecVersion).toBeNull();
    expect(g.reason).toBeUndefined();
  });

  it("ok=false with a reason on a spec_name mismatch (this is not a cogno-chain node)", async () => {
    const g = await checkBootGuard(apiWith({ spec_name: "kusama", spec_version: 107 }));
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/spec_name/i);
    expect(g.reason).toContain("kusama");
  });

  it("does NOT gate on spec_version while DESCRIPTOR_SPEC_VERSION is null (any version ok)", async () => {
    // A future spec bump with the same name must still pass — version is not pinned in the build.
    const g = await checkBootGuard(apiWith({ spec_name: "cogno-chain-runtime", spec_version: 999 }));
    expect(g.ok).toBe(true);
  });

  it("returns a not-ok guard WITH a reason when the version read throws (never crashes boot)", async () => {
    const g = await checkBootGuard(
      apiWith(() => {
        throw new Error("System.Version constant missing");
      }),
    );
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/could not read runtime version/i);
    expect(g.reason).toContain("System.Version constant missing");
    // The shape stays well-formed so the UI can render it.
    expect(g.nodeSpecName).toBe("");
    expect(g.nodeSpecVersion).toBe(0);
  });
});
