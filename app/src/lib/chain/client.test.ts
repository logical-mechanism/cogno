// Pure-logic tests for the read/write boot guard. The guard compares the live runtime spec to
// what the app was built against: a spec_name mismatch (wrong chain) must set ok=false; a
// spec_version mismatch must set ok=false (posting is blocked rather than mis-encoded); and a failed
// read must yield a not-ok guard WITH a reason rather than throwing (boot must never crash).

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

// The spec the descriptors are built against. `npm run check:spec` asserts this equals the runtime's
// spec_version in runtime/src/lib.rs, so it cannot drift out from under these tests.
const DESCRIPTOR_SPEC = 205;

describe("checkBootGuard", () => {
  it("ok=true when the spec_name AND spec_version match the descriptors", async () => {
    const g = await checkBootGuard(
      apiWith({ spec_name: "cogno-chain-runtime", spec_version: DESCRIPTOR_SPEC }),
    );
    expect(g.ok).toBe(true);
    expect(g.nodeSpecName).toBe("cogno-chain-runtime");
    expect(g.nodeSpecVersion).toBe(DESCRIPTOR_SPEC);
    expect(g.descriptorSpecVersion).toBe(DESCRIPTOR_SPEC);
    expect(g.reason).toBeUndefined();
  });

  it("ok=false with a reason on a spec_name mismatch (this is not a cogno-chain node)", async () => {
    const g = await checkBootGuard(apiWith({ spec_name: "kusama", spec_version: DESCRIPTOR_SPEC }));
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/spec_name/i);
    expect(g.reason).toContain("kusama");
  });

  // This case used to assert the OPPOSITE ("does NOT gate on spec_version"), pinning the hole:
  // DESCRIPTOR_SPEC_VERSION was null, so the version half of the guard was a permanent no-op and a
  // runtime spec bump would ship a frontend that silently mis-encoded every write.
  it("DOES gate on spec_version — a bumped runtime is an encoding mismatch, not a compatible node", async () => {
    const g = await checkBootGuard(apiWith({ spec_name: "cogno-chain-runtime", spec_version: 999 }));
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/spec_version/i);
    expect(g.reason).toContain("999");
    expect(g.reason).toContain(String(DESCRIPTOR_SPEC));
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
