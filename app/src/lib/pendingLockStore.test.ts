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
import {
  shouldClearPendingLock,
  pendingLockCreditIndeterminate,
  CONFIRM_TIMEOUT_MS,
} from "./pendingLockStore";

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

// The other half of the same distinction. "Not cleared" is two different facts, and only one of them
// licenses the "overdue" nudge — which asserts a NEGATIVE ("your lock still hasn't credited") and offers
// to dismiss it. usePendingCapacity nulls the frontier on ANY LastReference read error and the errored
// subscription is terminated, so a single transient error on an account whose lock HAS credited pinned
// it on a false "it never landed" for the rest of the session.
describe("pendingLockCreditIndeterminate", () => {
  it("is true when a positive weight cannot be attributed for want of a frontier", () => {
    expect(
      pendingLockCreditIndeterminate({
        record: fresh,
        allowedStake: 100_000_000n,
        frontier: null,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("is false once the frontier resolves, whichever side of the lock slot it lands", () => {
    for (const frontier of [4_900n, 9_000n]) {
      expect(
        pendingLockCreditIndeterminate({
          record: fresh,
          allowedStake: 100_000_000n,
          frontier,
          nowMs: NOW,
        }),
      ).toBe(false);
    }
  });

  it("is false on a zero or unread weight — there is no credit to attribute", () => {
    for (const allowedStake of [0n, null]) {
      expect(
        pendingLockCreditIndeterminate({ record: fresh, allowedStake, frontier: null, nowMs: NOW }),
      ).toBe(false);
    }
  });

  it("is false without a resolved lock slot — that record is timed out, not attributed", () => {
    // With no slot the clear rule is the confirm timeout, which needs no frontier, so nothing is
    // indeterminate and the overdue exit stays reachable.
    const confirming = { lockSlot: null, submittedAtMs: NOW - 10_000 };
    expect(
      pendingLockCreditIndeterminate({
        record: confirming,
        allowedStake: 100n,
        frontier: null,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("has nothing to say without a record", () => {
    expect(
      pendingLockCreditIndeterminate({
        record: null,
        allowedStake: 100n,
        frontier: null,
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});

describe("a RECOVERED record (rebuilt from chain on a second device)", () => {
  // It has no submit-time frontier and no lock slot: we know a lock exists, not when it landed.
  const recovered = { lockSlot: null, submittedAtMs: 0, recovered: true as const };

  it("clears on the credit alone, since there is no slot to compare a frontier against", () => {
    expect(
      shouldClearPendingLock({
        record: recovered,
        allowedStake: 1n,
        frontier: null,
        nowMs: 1_000,
      }),
    ).toBe(true);
  });

  it("still does not clear while the account has no weight", () => {
    expect(
      shouldClearPendingLock({ record: recovered, allowedStake: 0n, frontier: null, nowMs: 1_000 }),
    ).toBe(false);
  });

  it("does not clear on an unresolved weight read", () => {
    expect(
      shouldClearPendingLock({ record: recovered, allowedStake: null, frontier: null, nowMs: 1_000 }),
    ).toBe(false);
  });

  it("is NOT aged out by the confirm timeout the way a submit-time record is", () => {
    // `submittedAtMs` on a recovered record is when we NOTICED the lock, not when it was placed, so
    // the timeout measures nothing. A submit-time record with no slot DOES age out; this must not.
    const old = { lockSlot: null, submittedAtMs: 0 };
    const wayPastTimeout = CONFIRM_TIMEOUT_MS * 10;
    expect(
      shouldClearPendingLock({ record: old, allowedStake: 1n, frontier: null, nowMs: wayPastTimeout }),
    ).toBe(true);
    // The recovered one clears for the credit reason above, never for the age reason. With no credit
    // it stays put no matter how long it has been on screen.
    expect(
      shouldClearPendingLock({
        record: recovered,
        allowedStake: 0n,
        frontier: null,
        nowMs: wayPastTimeout,
      }),
    ).toBe(false);
  });
});
