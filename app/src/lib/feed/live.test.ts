// Unit tests for the pure live-feed helpers (mergeById + partitionFresh) that the useLiveFeed hook
// wires to state. These encode the two invariants the home feed depends on: (1) folding a refreshed
// or older page never drops/dupes a row and keeps newest-first; (2) a fresh page is classified so a
// stranger's new post buffers behind the pill while the viewer's own post injects directly.

import { describe, it, expect } from "vitest";
import { mergeById, partitionFresh } from "./live";
import type { CognoPost } from "@/lib/types";

function post(id: bigint, author = "alice", score = 0n): CognoPost {
  return { id, author, text: `p${id}`, at: Number(id), score };
}

describe("mergeById", () => {
  it("unions by id, newest-first, with incoming winning a collision (fresher tally)", () => {
    const existing = [post(3n), post(1n)];
    const incoming = [post(2n), { ...post(1n), score: 9n }];
    const merged = mergeById(existing, incoming);
    expect(merged.map((p) => p.id)).toEqual([3n, 2n, 1n]); // sorted desc, no dup of id 1
    expect(merged.find((p) => p.id === 1n)?.score).toBe(9n); // incoming (fresher) won
  });

  it("appends an older page below without disturbing the head", () => {
    const head = [post(10n), post(9n)];
    const older = [post(8n), post(7n)];
    expect(mergeById(head, older).map((p) => p.id)).toEqual([10n, 9n, 8n, 7n]);
  });
});

describe("partitionFresh", () => {
  const me = "me";

  it("buffers a stranger's new post but injects the viewer's own", () => {
    const fresh = [post(5n, "me"), post(4n, "stranger")];
    const part = partitionFresh(fresh, new Set(), new Set(), me);
    expect(part.newOwn.map((p) => p.id)).toEqual([5n]); // own → inject
    expect(part.newOthers.map((p) => p.id)).toEqual([4n]); // stranger → buffer
    expect(part.refreshLoaded).toEqual([]);
    expect(part.refreshBuffered).toEqual([]);
  });

  it("refreshes an already-loaded row in place (never re-buffers it)", () => {
    const fresh = [{ ...post(4n, "stranger"), score: 3n }];
    const part = partitionFresh(fresh, new Set(["4"]), new Set(), me);
    expect(part.refreshLoaded.map((p) => p.id)).toEqual([4n]);
    expect(part.newOthers).toEqual([]);
  });

  it("keeps a still-buffered row buffered (refresh, not promote to loaded)", () => {
    const fresh = [{ ...post(4n, "stranger"), score: 3n }];
    const part = partitionFresh(fresh, new Set(), new Set(["4"]), me);
    expect(part.refreshBuffered.map((p) => p.id)).toEqual([4n]);
    expect(part.refreshLoaded).toEqual([]);
    expect(part.newOthers).toEqual([]);
  });

  it("treats every stranger post as bufferable when there is no viewer", () => {
    const fresh = [post(5n, "a"), post(4n, "b")];
    const part = partitionFresh(fresh, new Set(), new Set(), null);
    expect(part.newOwn).toEqual([]);
    expect(part.newOthers.map((p) => p.id)).toEqual([5n, 4n]);
  });
});
