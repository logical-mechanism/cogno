// Guards the three divergences createChainCache exists to PRESERVE. Each was a real, deliberate
// difference between the four hand-rolled caches it replaced, and each would be silently erased by a
// "cleaner" generic. These tests exercise the batching core directly, with no React — the provider is
// a thin shell over it and there is no DOM test setup in this repo (environment: "node").
//
// NOTE this file is a .tsx, which until recently vitest's `include` did not match — a test here would
// have silently never run while reporting green. See vitest.config.ts.

import { describe, expect, it, vi } from "vitest";
import { createBatcher } from "./createChainCache";
import type { CognoApi } from "@/lib/types";

const api = {} as CognoApi;

// createBatcher is the REAL core (deliberately kept outside React so it is drivable here). An earlier
// draft of this file re-implemented the flush loop in the test — which would have passed even against a
// broken factory. Never do that: test the code, not a copy of it.
describe("error policy is a PARAMETER, not drift", () => {
  it("retry: a failed key is uncommitted, so the next consumer re-reads it", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(42n);
    const h = createBatcher<string, bigint>({
      name: "t",
      toKey: (a) => a,
      read,
      onError: { mode: "retry" },
    });

    h.request("alice");
    expect(await h.flush(api)).toEqual([]); // nothing committed
    expect(h.isCommitted("alice")).toBe(false); // uncommitted → re-readable

    h.request("alice"); // a badge for alice mounts again
    expect(await h.flush(api)).toEqual([{ key: "alice", value: 42n }]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("commit: a failed key resolves to the fallback and is NEVER re-read (no thrashing)", async () => {
    const read = vi.fn().mockRejectedValue(new Error("boom"));
    const h = createBatcher<string, { displayName?: string }>({
      name: "t",
      toKey: (a) => a,
      read,
      onError: { mode: "commit", fallback: {} },
    });

    h.request("alice");
    expect(await h.flush(api)).toEqual([{ key: "alice", value: {} }]); // the ss58 fallback
    expect(h.isCommitted("alice")).toBe(true); // committed → never retried

    h.request("alice");
    expect(await h.flush(api)).toEqual([]); // nothing left queued
    expect(read).toHaveBeenCalledTimes(1); // NOT re-read
  });
});

describe("`null` is a SUCCESSFUL read, not a failure", () => {
  it("a post that quotes nothing is cached, not re-read forever (the read-storm guard)", async () => {
    // useNestedQuote's V is `bigint | null`, and null — "quotes nothing" — is true of MOST posts.
    const read = vi.fn().mockResolvedValue(null);
    const h = createBatcher<bigint, bigint | null>({
      name: "t",
      toKey: (id) => String(id),
      read,
      onError: { mode: "retry" },
    });

    h.request(7n);
    expect(await h.flush(api)).toEqual([{ key: "7", value: null }]); // a null VALUE committed
    expect(h.isCommitted(7n)).toBe(true); // NOT treated as a miss

    h.request(7n);
    await h.flush(api);
    expect(read).toHaveBeenCalledTimes(1); // would be a read storm across the timeline if re-read
  });
});

describe("keys can be FALSY", () => {
  it("post id 0n is a valid key (a truthiness guard would silently drop it)", async () => {
    const read = vi.fn().mockResolvedValue(99n);
    const h = createBatcher<bigint, bigint | null>({
      name: "t",
      toKey: (id) => String(id),
      read,
      onError: { mode: "retry" },
    });

    h.request(0n);
    expect(await h.flush(api)).toEqual([{ key: "0", value: 99n }]);
    expect(read).toHaveBeenCalledWith(api, 0n);
  });
});

describe("batching", () => {
  it("coalesces every key registered before a flush into ONE pass, and dedupes", async () => {
    const read = vi.fn(async (_a: CognoApi, k: string) => k.length);
    const h = createBatcher<string, number>({
      name: "t",
      toKey: (a) => a,
      read,
      onError: { mode: "retry" },
    });

    // A whole feed page mounting: the same author on many cards costs exactly one read.
    for (const a of ["alice", "bob", "alice", "alice", "carol"]) h.request(a);
    const got = await h.flush(api);

    expect(read).toHaveBeenCalledTimes(3); // alice deduped from 3 registrations to 1 read
    expect(got.map((g) => g.key).sort()).toEqual(["alice", "bob", "carol"]);
  });
});

describe("reset (an endpoint change) is TOTAL", () => {
  it("forgets committed keys, so the same key is re-read against the new chain", async () => {
    const read = vi.fn().mockResolvedValueOnce(1n).mockResolvedValueOnce(2n);
    const h = createBatcher<string, bigint>({
      name: "t",
      toKey: (a) => a,
      read,
      onError: { mode: "retry" },
    });

    h.request("alice");
    expect(await h.flush(api)).toEqual([{ key: "alice", value: 1n }]);
    expect(h.isCommitted("alice")).toBe(true);

    h.reset(); // the socket now speaks to a DIFFERENT chain
    expect(h.isCommitted("alice")).toBe(false);
    h.request("alice");
    expect(await h.flush(api)).toEqual([{ key: "alice", value: 2n }]);
  });

  it("DISCARDS a flush already in flight — the old chain's answer must not land after the reset", async () => {
    // The whole point of reset is "this map now describes a chain we no longer talk to". A read that was
    // already out when it fired resolves afterwards, and merging it would put exactly the values the
    // reset just dropped straight back into the cache — indistinguishable from real data.
    let release: (v: bigint) => void = () => {};
    const read = vi.fn(() => new Promise<bigint>((r) => (release = r)));
    const h = createBatcher<string, bigint>({
      name: "t",
      toKey: (a) => a,
      read,
      onError: { mode: "retry" },
    });

    h.request("alice");
    const inFlight = h.flush(api);
    h.reset();
    release(1n); // the PREVIOUS chain's answer arrives
    expect(await inFlight).toEqual([]);
  });
});
