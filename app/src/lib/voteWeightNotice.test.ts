import { describe, it, expect } from "vitest";
import { shouldWarnZeroWeight, ZERO_WEIGHT_MESSAGE } from "./voteWeightNotice";

describe("shouldWarnZeroWeight", () => {
  it("warns a zero-power voter", () => {
    expect(shouldWarnZeroWeight({ votingPower: 0n })).toBe(true);
  });

  it("keeps warning, every time, until they bind", () => {
    // Deliberately NOT a one-shot. Each of these votes really did count for nothing, so falling
    // silent after the first would leave every later vote quietly worthless with no signal. The
    // onboarding step is what should prevent this state; this is the disclosure for whoever skipped it.
    for (let i = 0; i < 5; i++) expect(shouldWarnZeroWeight({ votingPower: 0n })).toBe(true);
  });

  it("stays quiet for a voter whose vote DOES carry weight", () => {
    expect(shouldWarnZeroWeight({ votingPower: 1n })).toBe(false);
    expect(shouldWarnZeroWeight({ votingPower: 10_000_000_000n })).toBe(false);
  });

  it("FAILS CLOSED while the power read is in flight", () => {
    // The load-bearing case. `null` is "we do not know yet", and this vote may well carry weight, so
    // claiming otherwise would be a false statement about the chain. Silence is the safe direction.
    expect(shouldWarnZeroWeight({ votingPower: null })).toBe(false);
  });

  it("takes no stakeBound input, so the post-bind lag cannot be misreported", () => {
    // stakeBound === true with votingPower === 0n is GUARANTEED for several blocks after every stake
    // bind (VotingPower is written asynchronously by the observer inherent). Keying on votingPower
    // means that account is still, correctly, told its vote weighs nothing right now.
    expect(shouldWarnZeroWeight({ votingPower: 0n })).toBe(true);
  });

  it("carries no em dashes, per the copy rule", () => {
    expect(ZERO_WEIGHT_MESSAGE).not.toContain("\u2014");
  });
});
