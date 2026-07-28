// The device-local bucket key must not depend on where the viewer is in the bind lifecycle.
//
// This pins SEMANTICS, not call sites: it cannot stop the thirty-second surface re-deriving the key by
// hand. That is the eslint `no-restricted-syntax` rule in eslint.config.mjs. What it CAN do is fail if
// anyone ever reintroduces the lifecycle gate inside `viewerBucket` itself, which would put every
// caller back on the wrong bucket at once.

import { describe, it, expect } from "vitest";
import { viewerBucket } from "./viewerBucket";
import type { Ss58 } from "@/lib/types";
import type { Viewer } from "@/components/kit";

const ADDR = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as Ss58;

const viewer = (status: Viewer["status"], address?: Ss58): Viewer => ({
  status,
  address,
  writeReady: false,
});

describe("viewerBucket", () => {
  it("returns the address for a connected-but-unbound viewer", () => {
    // The whole bug: this is the window between the derive signature and the CIP-8 bind resolving,
    // and a `status === "ready"` gate returns null here — a DIFFERENT bucket from every other surface.
    expect(viewerBucket(viewer("not-identity-bound", ADDR))).toBe(ADDR);
  });

  it("returns the same value for not-identity-bound and ready", () => {
    expect(viewerBucket(viewer("not-identity-bound", ADDR))).toBe(
      viewerBucket(viewer("ready", ADDR)),
    );
  });

  it("returns the address even while the gate reports not-connected", () => {
    // `useIdentity` clears `bound` to null during render whenever `activeKey` changes, and
    // `deriveSessionState` reports `not-connected` for `bound === null` — so this state is reached on
    // every page load, and permanently for the session if the `isAccountBound` read throws.
    expect(viewerBucket(viewer("not-connected", ADDR))).toBe(ADDR);
  });

  it("is null for signed-out browsing (the :anon bucket)", () => {
    expect(viewerBucket(viewer("not-connected"))).toBeNull();
    expect(viewerBucket(null)).toBeNull();
    expect(viewerBucket(undefined)).toBeNull();
  });
});
