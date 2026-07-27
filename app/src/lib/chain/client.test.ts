// Pure-logic tests for the read/write boot guard. The guard compares the live runtime spec to
// what the app was built against: a spec_name mismatch (wrong chain) must set ok=false; a
// spec_version mismatch must set ok=false (posting is blocked rather than mis-encoded); and a failed
// read must yield a not-ok guard WITH a reason rather than throwing (boot must never crash).

import { describe, it, expect } from "vitest";
import { checkBootGuard, DESCRIPTOR_SPEC_VERSION } from "./client";
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

// The spec the descriptors are built against, IMPORTED from the guard rather than re-declared here.
//
// This used to be a hardcoded copy, above a comment claiming `npm run check:spec` kept it honest. It
// did not: that script compares client.ts's `DESCRIPTOR_SPEC_VERSION` against runtime/src/lib.rs and
// never reads this file, so the copy sat at 212 through the 212 → 213 bump and took three tests down
// with it — while lint, typecheck and check:spec all passed. Importing is what actually makes the
// claim true, and it means the next spec bump cannot break these tests at all.
if (DESCRIPTOR_SPEC_VERSION === null) {
  throw new Error(
    "DESCRIPTOR_SPEC_VERSION is null — the boot guard cannot gate on spec_version, so these tests " +
      "would assert nothing. check:spec fails on this too.",
  );
}
const DESCRIPTOR_SPEC: number = DESCRIPTOR_SPEC_VERSION;

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
    // `reason` is user-facing copy, so it names no runtime internals; the offending spec_name is
    // still returned structurally for Diagnostics.
    expect(g.reason).toMatch(/isn't a cogno node/i);
    expect(g.nodeSpecName).toBe("kusama");
  });

  // This case used to assert the OPPOSITE ("does NOT gate on spec_version"), pinning the hole:
  // DESCRIPTOR_SPEC_VERSION was null, so the version half of the guard was a permanent no-op and a
  // runtime spec bump would ship a frontend that silently mis-encoded every write.
  it("DOES gate on spec_version — a bumped runtime is an encoding mismatch, not a compatible node", async () => {
    const g = await checkBootGuard(apiWith({ spec_name: "cogno-chain-runtime", spec_version: 999 }));
    expect(g.ok).toBe(false);
    // Both versions stay IN the copy — the user can report them — but the word spec_version does not.
    expect(g.reason).toMatch(/versions don't match/i);
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
    // The raw throw goes to console.warn, not into user-facing copy.
    expect(g.reason).toMatch(/can't reach cogno/i);
    // The shape stays well-formed so the UI can render it.
    expect(g.nodeSpecName).toBe("");
    expect(g.nodeSpecVersion).toBe(0);
  });
});

// `ok` alone could not tell a STALE TAB from a WRONG ENDPOINT from a DOWN NODE, and the three need
// different advice: reload / change the address / wait. BootGuardNotice keys off `kind` to pick which
// one to give, so a wrong `kind` is a banner telling someone to reload when reloading cannot help.
describe("checkBootGuard classifies WHY it is not ok", () => {
  const okVersion = { spec_name: "cogno-chain-runtime", spec_version: DESCRIPTOR_SPEC };

  it("kind is 'ok' exactly when ok is true", async () => {
    const g = await checkBootGuard(apiWith(okVersion));
    expect(g.kind).toBe("ok");
    expect(g.ok).toBe(true);
  });

  it("a bumped runtime on the SAME chain is 'stale-app' — this tab, not this network", async () => {
    const g = await checkBootGuard(apiWith({ spec_name: "cogno-chain-runtime", spec_version: 999 }));
    expect(g.kind).toBe("stale-app");
  });

  it("tells a stale tab to RELOAD, which is the whole fix and was not in the copy", async () => {
    // The failure: the reason said "posting is off" and stopped, so the reader learned what broke and
    // never learned that a reload fixes it. On mainnet every runtime upgrade puts every open tab here.
    const g = await checkBootGuard(apiWith({ spec_name: "cogno-chain-runtime", spec_version: 999 }));
    expect(g.reason).toMatch(/reload/i);
  });

  it("a foreign spec_name is 'wrong-chain', where reloading would only reproduce it", async () => {
    const g = await checkBootGuard(apiWith({ spec_name: "kusama", spec_version: DESCRIPTOR_SPEC }));
    expect(g.kind).toBe("wrong-chain");
    expect(g.reason).not.toMatch(/reload/i);
  });

  it("a failed read is 'unreachable', not a version verdict it never got to make", async () => {
    const g = await checkBootGuard(
      apiWith(() => {
        throw new Error("socket closed");
      }),
    );
    expect(g.kind).toBe("unreachable");
  });

  it("ok and kind can never disagree", async () => {
    for (const v of [
      okVersion,
      { spec_name: "cogno-chain-runtime", spec_version: 999 },
      { spec_name: "kusama", spec_version: DESCRIPTOR_SPEC },
    ]) {
      const g = await checkBootGuard(apiWith(v));
      expect(g.ok).toBe(g.kind === "ok");
    }
  });
});
