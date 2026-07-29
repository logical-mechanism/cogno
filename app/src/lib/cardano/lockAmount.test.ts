import { describe, it, expect } from "vitest";
import { LOCK_ADA_WHOLE } from "./lockAmount";
import { MIN_LOCK } from "./blueprint";

// The whole point of lockAmount.ts is that the copy string does NOT import the vault artifact. That
// buys a first-load chunk without 6 KB of Plutus CBOR in it and costs the derivation, so this test is
// what puts the derivation back — once, at build time, where the payload does not matter.
//
// If this fails, a redeploy moved the script's floor. Update LOCK_ADA_WHOLE; do not relax the test.
describe("LOCK_ADA_WHOLE", () => {
  it("matches the current vault script's own minLock", () => {
    expect(LOCK_ADA_WHOLE).toBe((MIN_LOCK / 1_000_000n).toString());
  });

  it("is a whole number of ADA, so the copy needs no decimal", () => {
    expect(MIN_LOCK % 1_000_000n).toBe(0n);
  });
});
