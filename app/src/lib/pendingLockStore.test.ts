// F8 — stale authority across a transition.
//
// The clear rule was "AllowedStake > 0", which treats a weight written for a PRIOR lock as
// authoritative about a NEWER one. Exit the vault and relock inside the observer's stability window and
// the weight is still positive from the deposit you just exited, so the fresh record was destroyed the
// instant it was written. The observer then catches up, the weight drops to zero, and with no record
// left the app tells someone who has just locked 100 ADA that they have none.
//
// The predicate is what is testable; the five call sites are not (vitest is `environment: "node"`).

import { describe, it, expect } from "vitest";
import { shouldClearPendingLock, CONFIRM_TIMEOUT_MS } from "./pendingLockStore";

const NOW = 1_700_000_000_000;
const fresh = { lockSlot: 5_000, submittedAtMs: NOW - 30_000 };

describe("shouldClearPendingLock", () => {
  it("does NOT clear a fresh record on a stale-positive weight from a prior lock", () => {
    // THE bug. The observer has read to slot 4_900 — it has not reached this lock at 5_000, so the
    // positive weight is about the deposit that was just exited, not about this one.
    expect(
      shouldClearPendingLock({
        record: fresh,
        allowedStake: 100_000_000n,
        frontier: 4_900n,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("clears once the observer has read past the lock's own slot", () => {
    expect(
      shouldClearPendingLock({
        record: fresh,
        allowedStake: 100_000_000n,
        frontier: 5_000n,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("does not clear on an unresolved frontier", () => {
    // `null` is "we cannot tell yet", never "it has not passed". Not clearing is the safe direction:
    // the status already reads as credited off AllowedStake, and the next emission resolves it.
    expect(
      shouldClearPendingLock({ record: fresh, allowedStake: 100_000_000n, frontier: null, nowMs: NOW }),
    ).toBe(false);
  });

  it("does not clear while the weight itself is unread", () => {
    expect(
      shouldClearPendingLock({ record: fresh, allowedStake: null, frontier: 9_000n, nowMs: NOW }),
    ).toBe(false);
  });

  it("does not clear on a zero weight, however far the frontier has read", () => {
    expect(
      shouldClearPendingLock({ record: fresh, allowedStake: 0n, frontier: 9_000n, nowMs: NOW }),
    ).toBe(false);
  });

  it("still clears via the confirm timeout when the lock slot never resolved", () => {
    // No slot means nothing to compare. A record that has aged out of the confirm window while the
    // account demonstrably has weight is stale (the tx never landed, or Blockfrost could not answer)
    // and must not pin the UI forever.
    const stale = { lockSlot: null, submittedAtMs: NOW - CONFIRM_TIMEOUT_MS - 1 };
    expect(
      shouldClearPendingLock({ record: stale, allowedStake: 100n, frontier: null, nowMs: NOW }),
    ).toBe(true);
  });

  it("does not clear an unconfirmed record that is still inside the confirm window", () => {
    const confirming = { lockSlot: null, submittedAtMs: NOW - 10_000 };
    expect(
      shouldClearPendingLock({ record: confirming, allowedStake: 100n, frontier: null, nowMs: NOW }),
    ).toBe(false);
  });

  it("has nothing to do without a record", () => {
    expect(
      shouldClearPendingLock({ record: null, allowedStake: 100n, frontier: 9_000n, nowMs: NOW }),
    ).toBe(false);
  });
});
