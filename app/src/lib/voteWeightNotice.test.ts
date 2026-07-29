import { describe, it, expect } from "vitest";
import { shouldWarnZeroWeight, ZERO_WEIGHT_VOTE } from "./voteWeightNotice";

const EMPTY: ReadonlySet<string> = new Set();
const SEEN: ReadonlySet<string> = new Set([ZERO_WEIGHT_VOTE]);

describe("shouldWarnZeroWeight", () => {
  it("warns a zero-power voter who has not been told yet", () => {
    expect(shouldWarnZeroWeight({ votingPower: 0n, seen: EMPTY })).toBe(true);
  });

  it("stays quiet once the account has been told (one shot, not per vote)", () => {
    expect(shouldWarnZeroWeight({ votingPower: 0n, seen: SEEN })).toBe(false);
  });

  it("stays quiet for a voter whose vote DOES carry weight", () => {
    expect(shouldWarnZeroWeight({ votingPower: 1n, seen: EMPTY })).toBe(false);
    expect(shouldWarnZeroWeight({ votingPower: 10_000_000_000n, seen: EMPTY })).toBe(false);
  });

  it("FAILS CLOSED while the power read is in flight", () => {
    // The load-bearing case. `null` is "we do not know yet", and this vote may well carry weight —
    // claiming it does not would be a false statement about the chain. Silence is the safe direction.
    expect(shouldWarnZeroWeight({ votingPower: null, seen: EMPTY })).toBe(false);
  });

  it("keys on votingPower, so a just-stake-bound account is still warned until the observer writes", () => {
    // stakeBound === true with votingPower === 0n is the GUARANTEED state for several blocks after
    // every stake bind (VotingPower is written asynchronously by the cardano-observer inherent). The
    // predicate takes no stakeBound input at all, which is what makes that unrepresentable here.
    expect(shouldWarnZeroWeight({ votingPower: 0n, seen: EMPTY })).toBe(true);
  });
});
