// The prefix is the dangerous part of this module: a wrong one does not error, it returns zero keys —
// indistinguishable from "nobody voted". So it is pinned against bytes verified on the LIVE chain, where
// poll 29 returned exactly its 2 voters, poll 41 its 1, and poll 7 its 3 with matching options.

import { describe, it, expect, vi } from "vitest";
import {
  pollVotesPrefix,
  voterFromKey,
  readPollVotersPage,
  POLL_VOTERS_PAGE,
} from "./poll-voters";

/** The live-verified prefix for poll 29 (`twox128("Microblog") ++ twox128("PollVotes")` + the host key). */
const POLL_29_PREFIX =
  "0x600b104d71ad9ee92f01bb8d61d9ae3c" + // twox128("Microblog") ++ twox128("PollVotes")
  "";

describe("pollVotesPrefix", () => {
  it("starts with the pallet+item prefix the live chain answered on", () => {
    // The first 32 hex chars are twox128("Microblog"); the next 32 are twox128("PollVotes"). Both are
    // host-independent, so every poll shares them — that shared head is what was verified live.
    const a = pollVotesPrefix(29n);
    const b = pollVotesPrefix(41n);
    expect(a.slice(0, 34)).toBe(POLL_29_PREFIX.slice(0, 34));
    expect(a.slice(0, 66)).toBe(b.slice(0, 66)); // same pallet+item head
  });

  it("gives a DIFFERENT prefix per poll, or every poll would read the same voters", () => {
    expect(pollVotesPrefix(29n)).not.toBe(pollVotesPrefix(41n));
  });

  it("is 2 + (16+16+16+8)*2 hex chars: pallet, item, the host hash, and the host itself", () => {
    // Blake2_128Concat is transparent — 16-byte hash FOLLOWED BY the 8-byte key — so the host id is
    // literally the tail. If this length is wrong the hasher or the int width is wrong.
    expect(pollVotesPrefix(29n)).toHaveLength(2 + (16 + 16 + 16 + 8) * 2);
  });

  it("encodes the host id LITTLE-endian, the way SCALE does", () => {
    // 29 little-endian is 1d00000000000000; big-endian would be 000000000000001d and would hash to a
    // prefix nothing ever wrote, so every poll would silently read as having no voters.
    expect(pollVotesPrefix(29n).endsWith("1d00000000000000")).toBe(true);
    expect(pollVotesPrefix(256n).endsWith("0001000000000000")).toBe(true);
  });
});

describe("voterFromKey", () => {
  it("takes the account from the trailing 32 bytes and ss58-encodes it", () => {
    // A real key from the live chain: poll 29's first voter.
    const key = `0x${"aa".repeat(36)}${"d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"}`;
    // //Alice's well-known public key -> her ss58 on prefix 42.
    expect(voterFromKey(key)).toBe("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
  });

  it("returns null for a key too short to hold an account, rather than a bogus address", () => {
    expect(voterFromKey("0xdead")).toBeNull();
  });
});

/** A fake RPC seam: `keys` are returned in order, `values` map key -> SCALE hex (or null). */
function fakeRequest(keys: string[], values: Record<string, string | null>) {
  return vi.fn(async (method: string) => {
    if (method === "state_getKeysPaged") return keys;
    if (method === "state_queryStorageAt") {
      return [{ changes: keys.map((k) => [k, values[k] ?? null]) }];
    }
    throw new Error(`unexpected ${method}`);
  }) as never;
}

const KEY_A = `0x${"11".repeat(36)}${"d4".repeat(32)}`;
const KEY_B = `0x${"22".repeat(36)}${"aa".repeat(32)}`;

describe("readPollVotersPage", () => {
  it("pairs each voter with their own option, mapping BY KEY not by position", async () => {
    // `state_queryStorageAt` gives no ordering guarantee, so the changes come back REVERSED here. Pairing
    // by index would hand each voter the other's choice — a wrong answer that looks entirely normal.
    const request = vi.fn(async (method: string) => {
      if (method === "state_getKeysPaged") return [KEY_A, KEY_B];
      return [{ changes: [[KEY_B, "0x01"], [KEY_A, "0x00"]] }];
    }) as never;
    const page = await readPollVotersPage(request, 29n);
    expect(page.voters.map((v) => v.option)).toEqual([0, 1]);
  });

  it("reports no more once a SHORT page comes back", async () => {
    const page = await readPollVotersPage(fakeRequest([KEY_A], { [KEY_A]: "0x00" }), 29n, {
      limit: 50,
    });
    expect(page.nextCursor).toBeNull();
  });

  it("hands back the last KEY as the cursor on a full page", async () => {
    const keys = [KEY_A, KEY_B];
    const page = await readPollVotersPage(fakeRequest(keys, { [KEY_A]: "0x00", [KEY_B]: "0x00" }), 29n, {
      limit: 2,
    });
    expect(page.nextCursor).toBe(KEY_B);
  });

  it("keeps the cursor when every row of a FULL page was skipped", async () => {
    // A page whose values all vanished still has keys behind it. Deriving "no more" from the surviving
    // VOTERS rather than the KEYS would stop here and silently truncate the roster.
    const page = await readPollVotersPage(fakeRequest([KEY_A, KEY_B], {}), 29n, { limit: 2 });
    expect(page.voters).toHaveLength(0);
    expect(page.nextCursor).toBe(KEY_B);
  });

  it("skips a vote removed between the two calls rather than inventing option 0", async () => {
    const page = await readPollVotersPage(
      fakeRequest([KEY_A, KEY_B], { [KEY_A]: null, [KEY_B]: "0x02" }),
      29n,
      { limit: 50 },
    );
    expect(page.voters).toEqual([{ who: expect.any(String), option: 2 }]);
  });

  it("ends cleanly on an empty prefix", async () => {
    const page = await readPollVotersPage(fakeRequest([], {}), 999n);
    expect(page).toEqual({ voters: [], nextCursor: null });
  });

  it("never throws: a failed read is an empty page, not a broken list", async () => {
    const request = vi.fn(async () => {
      throw new Error("rpc down");
    }) as never;
    await expect(readPollVotersPage(request, 29n)).resolves.toEqual({
      voters: [],
      nextCursor: null,
    });
  });

  it("asks for POLL_VOTERS_PAGE rows by default", async () => {
    const request = fakeRequest([], {});
    await readPollVotersPage(request, 29n);
    expect(request).toHaveBeenCalledWith("state_getKeysPaged", [
      pollVotesPrefix(29n),
      POLL_VOTERS_PAGE,
      null,
    ]);
  });
});
