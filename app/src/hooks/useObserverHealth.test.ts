import { describe, expect, it } from "vitest";

import { deriveEverObserved } from "./useObserverHealth";

describe("deriveEverObserved", () => {
  it("is true once the frontier has moved", () => {
    expect(deriveEverObserved({ hasReference: true, lastAppliedAt: 0 })).toBe(true);
    expect(deriveEverObserved({ hasReference: true, lastAppliedAt: null })).toBe(true);
  });

  it("is true while the FIRST observation is still draining, when the frontier is not yet set", () => {
    // The spec-215 case this exists for. LastReference advances only on a block that carried its whole
    // change set, so a chain whose first observation backlogs has applied real pages and credited real
    // weight while still reading `None`. Keying on the frontier alone rendered "not started" there.
    expect(deriveEverObserved({ hasReference: false, lastAppliedAt: 12 })).toBe(true);
  });

  it("is false only when both reads resolved and neither shows an observation", () => {
    // Block 0 is genesis and carries no extrinsics, so a zero clock is never a real observation.
    expect(deriveEverObserved({ hasReference: false, lastAppliedAt: 0 })).toBe(false);
  });

  it("stays null while either read is unresolved, so inconclusive never reads as never", () => {
    expect(deriveEverObserved({ hasReference: null, lastAppliedAt: null })).toBe(null);
    expect(deriveEverObserved({ hasReference: null, lastAppliedAt: 0 })).toBe(null);
    expect(deriveEverObserved({ hasReference: false, lastAppliedAt: null })).toBe(null);
  });
});
