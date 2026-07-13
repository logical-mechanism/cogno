import { describe, it, expect } from "vitest";
import { rebaseAccountVote, ZERO_BASE, type AccountVoteBase, type AccountVoteIntent } from "./accountVote";

const W = 1_000n; // the viewer's voting power

const base = (over: Partial<AccountVoteBase> = {}): AccountVoteBase => ({ ...ZERO_BASE, ...over });
const intent = (over: Partial<AccountVoteIntent> = {}): AccountVoteIntent => ({
  myVote: "Up",
  weight: W,
  inFlight: 1,
  ...over,
});

describe("rebaseAccountVote", () => {
  it("with no intent, renders the chain's base verbatim", () => {
    const b = base({ myVote: "Down", upWeight: 500n, downWeight: 200n, upCount: 2, downCount: 1 });
    expect(rebaseAccountVote(b, undefined)).toEqual({
      myVote: "Down",
      score: 300n,
      upCount: 2,
      downCount: 1,
    });
  });

  it("applies a fresh up-vote optimistically over a base that has not caught up", () => {
    expect(rebaseAccountVote(ZERO_BASE, intent({ myVote: "Up" }))).toEqual({
      myVote: "Up",
      score: W,
      upCount: 1,
      downCount: 0,
    });
  });

  it("applies a fresh down-vote as a NEGATIVE score (the score may go below zero)", () => {
    expect(rebaseAccountVote(ZERO_BASE, intent({ myVote: "Down" }))).toEqual({
      myVote: "Down",
      score: -W,
      upCount: 0,
      downCount: 1,
    });
  });

  // THE identity that replaces the old "settle-on-agreement" rule + its TTL. Once the chain carries the
  // vote, the rebase is a no-op — so a live intent over a caught-up base cannot double-count.
  it("is a NO-OP once the base already carries the intent (settling is arithmetic, not a rule)", () => {
    const caughtUp = base({ myVote: "Up", upWeight: W, upCount: 1 });
    expect(rebaseAccountVote(caughtUp, intent({ myVote: "Up" }))).toEqual(
      rebaseAccountVote(caughtUp, undefined),
    );
  });

  // The case a COMPOSED delta gets wrong, and the reason this is an intent and not a delta. The viewer
  // votes Up, the read catches up to Up, and they switch to Down before the second tx confirms. Rebasing
  // against the caught-up base nets −W. A stored delta composed against the OLD (empty) base would not.
  it("re-votes correctly against a base that moved underneath it (Up → Down nets −W, not 0 and not −2W)", () => {
    const caughtUp = base({ myVote: "Up", upWeight: W, upCount: 1 });
    expect(rebaseAccountVote(caughtUp, intent({ myVote: "Down" }))).toEqual({
      myVote: "Down",
      score: -W,
      upCount: 0,
      downCount: 1,
    });
  });

  it("clears correctly against a caught-up base (back to nothing, not to a phantom)", () => {
    const caughtUp = base({ myVote: "Up", upWeight: W, upCount: 1 });
    expect(rebaseAccountVote(caughtUp, intent({ myVote: null }))).toEqual({
      myVote: null,
      score: 0n,
      upCount: 0,
      downCount: 0,
    });
  });

  it("preserves OTHER voters' weight when the viewer reverses their own vote", () => {
    // Someone else already put 5000 of up-weight on this account; the viewer's own Up is 1000 of it.
    const b = base({ myVote: "Up", upWeight: 5_000n + W, upCount: 3 });
    expect(rebaseAccountVote(b, intent({ myVote: "Down" }))).toEqual({
      myVote: "Down",
      score: 5_000n - W,
      upCount: 2,
      downCount: 1,
    });
  });

  // A vote cast while VotingPower was still loading records weight 0; reversing it later at the real
  // weight would otherwise drive the shown tally negative. The chain saturates; so do we.
  it("floors weights and counts at zero, like the chain's saturating_sub", () => {
    const thin = base({ myVote: "Up", upWeight: 10n, upCount: 1 });
    const out = rebaseAccountVote(thin, intent({ myVote: null, weight: 999_999n }));
    expect(out.score).toBe(0n); // NOT -999_989n
    expect(out.upCount).toBe(0); // NOT -1
  });

  it("a zero-weight voter still registers a vote and a count, adding no weight", () => {
    expect(rebaseAccountVote(ZERO_BASE, intent({ myVote: "Up", weight: 0n }))).toEqual({
      myVote: "Up",
      score: 0n,
      upCount: 1,
      downCount: 0,
    });
  });

  // THE TORN BASE. This is why the tally and the viewer's own vote are read together and committed as
  // one value (useAccountVoteState) instead of coming from two caches. If `myVote` were to lag the
  // weights by even one render — the tally already carrying your vote while myVote still said null —
  // the rebase would apply your weight a SECOND time. Pinning the arithmetic here so that the day
  // someone splits the read back apart to save a round-trip, this fails and says why.
  it("double-counts if myVote lags the weights — the reason the base must be ONE snapshot", () => {
    const torn = base({ myVote: null, upWeight: 5_000n + W, upCount: 4 }); // tally landed, myVote did not
    const wrong = rebaseAccountVote(torn, intent({ myVote: "Up" }));
    expect(wrong.score).toBe(5_000n + 2n * W); // the viewer's weight, applied twice
    expect(wrong.upCount).toBe(5);

    const whole = base({ myVote: "Up", upWeight: 5_000n + W, upCount: 4 }); // both halves, one snapshot
    const right = rebaseAccountVote(whole, intent({ myVote: "Up" }));
    expect(right.score).toBe(5_000n + W); // counted once
    expect(right.upCount).toBe(4);
  });
});
