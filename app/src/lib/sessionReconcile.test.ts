// The effect in useSigner cannot be render-tested (vitest runs `environment: "node"`), so the pure
// predicate is the guard. Each case below is a shipped or narrowly-avoided failure, not a permutation.

import { describe, it, expect } from "vitest";
import { shouldAdoptSignOut, type SignOutAdoptionInput } from "./sessionReconcile";
import type { Ss58 } from "./types";

const A = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as Ss58;
const B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty" as Ss58;

const input = (over: Partial<SignOutAdoptionInput> = {}): SignOutAdoptionInput => ({
  hydrated: true,
  chosenSs58: A,
  devChosen: false,
  recordSs58: A,
  recordSeen: true,
  ...over,
});

describe("shouldAdoptSignOut", () => {
  it("adopts a sign-out performed in another tab", () => {
    // THE bug: this tab has unlocked (chosen is set), the other tab cleared `cg-session`.
    expect(shouldAdoptSignOut(input({ recordSs58: null }))).toBe(true);
  });

  it("adopts a different account signing in elsewhere", () => {
    expect(shouldAdoptSignOut(input({ recordSs58: B }))).toBe(true);
  });

  it("leaves an agreeing session alone", () => {
    expect(shouldAdoptSignOut(input())).toBe(false);
  });

  it("never fires before hydration", () => {
    // `useRestoredSession` returns null on the hydration render by design (no localStorage read during
    // SSG-hydration). Adopting there would sign out every returning user on every page load.
    expect(shouldAdoptSignOut(input({ hydrated: false, recordSs58: null }))).toBe(false);
  });

  it("exempts dev accounts, which are chosen without a record", () => {
    expect(shouldAdoptSignOut(input({ devChosen: true, recordSs58: null }))).toBe(false);
  });

  it("does not fire before a record has ever been observed", () => {
    // `connectWallet` sets `chosen` and then writes the record, and `persistentStore.commit` swallows a
    // storage throw. Without this arm, a browser with site data blocked could never sign in: the record
    // would never land and the tab would tear its own fresh session down immediately.
    expect(shouldAdoptSignOut(input({ recordSeen: false, recordSs58: null }))).toBe(false);
  });

  it("does nothing for a tab with no in-memory key of its own", () => {
    // A restored (seedless) tab renders straight off the record, so there is nothing to tear down —
    // the record going null already makes it a guest.
    expect(shouldAdoptSignOut(input({ chosenSs58: null, recordSs58: null }))).toBe(false);
  });
});
