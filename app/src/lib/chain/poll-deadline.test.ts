import { describe, it, expect } from "vitest";
import { resolveCloseAt, DEFAULT_POLL_CLOSE_DAYS } from "./mutations";
import { BLOCKS_PER_DAY } from "./capacity";
import type { CognoApi } from "@/lib/types";

// A fake api serving the two poll-duration constants and a chain head. The constants are what the
// runtime validates `close_at` against, so this is the whole contract under test.
function fakeApi(minPollDuration: number, maxPollDuration: number, head = 1_000) {
  return {
    constants: {
      Microblog: {
        MinPollDuration: async () => minPollDuration,
        MaxPollDuration: async () => maxPollDuration,
      },
    },
    query: { System: { Number: { getValue: async () => head } } },
  } as unknown as CognoApi;
}

// The live runtime window: 10 minutes … 90 days, in 6s blocks.
const LIVE_MIN = 100;
const LIVE_MAX = 90 * BLOCKS_PER_DAY;

describe("resolveCloseAt", () => {
  it("passes the composer's own choices through untouched inside the live window", async () => {
    const api = fakeApi(LIVE_MIN, LIVE_MAX);
    for (const days of [1, 3, 7]) {
      expect(await resolveCloseAt(api, 1_000, days)).toBe(1_000 + days * BLOCKS_PER_DAY);
    }
    // No choice at all falls back to the composer's displayed default.
    expect(await resolveCloseAt(api, 1_000)).toBe(1_000 + DEFAULT_POLL_CLOSE_DAYS * BLOCKS_PER_DAY);
  });

  it("clamps UP to the runtime's floor when a retune raises MinPollDuration past the choice", async () => {
    // A committee retune to a 5-day minimum. The composer still offers 1 day; without clamping every
    // such poll would be rejected on-chain with PollDurationTooShort and nothing would say why.
    const min = 5 * BLOCKS_PER_DAY;
    const closeAt = await resolveCloseAt(fakeApi(min, LIVE_MAX), 1_000, 1);
    expect(closeAt).toBeGreaterThan(1_000 + min);
    expect(closeAt).toBe(1_000 + min + 1);
  });

  it("clamps DOWN to the runtime's ceiling when a retune lowers MaxPollDuration under the choice", async () => {
    // A 2-day maximum against the composer's 1-week option (PollDurationTooLong, otherwise).
    const max = 2 * BLOCKS_PER_DAY;
    expect(await resolveCloseAt(fakeApi(LIVE_MIN, max), 1_000, 7)).toBe(1_000 + max);
  });

  it("reads the chain head when bestBlock has not loaded, and throws if it cannot", async () => {
    expect(await resolveCloseAt(fakeApi(LIVE_MIN, LIVE_MAX, 4_242), null, 1)).toBe(
      4_242 + BLOCKS_PER_DAY,
    );
    await expect(resolveCloseAt(fakeApi(LIVE_MIN, LIVE_MAX, 0), null, 1)).rejects.toThrow(
      /chain height/i,
    );
  });
});
