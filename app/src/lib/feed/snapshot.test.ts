// The feed snapshot is a hand-off between two mounts of the same surface. Its whole correctness story
// is in the key and in the consuming read: a feed page carries the VIEWER'S OWN `myVote` overlay baked
// into every row, so replaying it under a different account would show them someone else's filled
// hearts, and replaying it twice would let a third mount paint a page that is two navigations stale.

import { describe, it, expect, beforeEach } from "vitest";
import {
  clearFeedSnapshot,
  feedSnapshotKey,
  saveFeedSnapshot,
  takeFeedSnapshot,
} from "./snapshot";
import type { CognoPost } from "@/lib/types";

const post = (id: bigint): CognoPost => ({ id, author: "5Alice", text: `p${id}`, at: 1 });
const snap = (ids: bigint[], cursor: string | null = "10", scrollY = 0, head: bigint | null = 99n) => ({
  posts: ids.map(post),
  cursor,
  scrollY,
  head,
});

const ME = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

beforeEach(() => {
  clearFeedSnapshot();
});

describe("feedSnapshotKey", () => {
  it("separates viewers — a page is stamped with ITS viewer's myVote overlay", () => {
    expect(feedSnapshotKey("forYou", ME)).not.toBe(feedSnapshotKey("forYou", OTHER));
  });

  it("gives signed-out browsing its own bucket rather than colliding with an account", () => {
    expect(feedSnapshotKey("forYou", null)).toBe("forYou|anon");
    expect(feedSnapshotKey("forYou", null)).not.toBe(feedSnapshotKey("forYou", ME));
  });

  it("separates tabs — the following feed is a different list of posts", () => {
    expect(feedSnapshotKey("forYou", ME)).not.toBe(feedSnapshotKey("following", ME));
  });
});

describe("save / take", () => {
  it("hands the page, cursor, scroll position and head to the next mount", () => {
    const k = feedSnapshotKey("forYou", ME);
    saveFeedSnapshot(k, snap([3n, 2n, 1n], "1", 1200, 4321n));
    const got = takeFeedSnapshot(k);
    expect(got?.posts.map((p) => p.id)).toEqual([3n, 2n, 1n]);
    expect(got?.cursor).toBe("1");
    expect(got?.scrollY).toBe(1200);
    // The head is what lets the restoring mount bridge the REAL gap. Without it, useLiveFeed's head
    // handler falls through to a hard-coded one-page catch-up and SILENTLY skips everything older than
    // the newest page — then marks itself current, so those posts never arrive.
    expect(got?.head).toBe(4321n);
  });

  it("round-trips a null head (a feed that never saw an emission), distinct from a missing one", () => {
    const k = feedSnapshotKey("forYou", ME);
    saveFeedSnapshot(k, snap([1n], "1", 0, null));
    expect(takeFeedSnapshot(k)?.head).toBeNull();
  });

  it("is CONSUMING: a second take gets nothing, so a third mount cannot replay a stale page", () => {
    const k = feedSnapshotKey("forYou", ME);
    saveFeedSnapshot(k, snap([1n]));
    expect(takeFeedSnapshot(k)).not.toBeNull();
    expect(takeFeedSnapshot(k)).toBeNull();
  });

  it("never serves one viewer's page to another", () => {
    saveFeedSnapshot(feedSnapshotKey("forYou", ME), snap([1n]));
    expect(takeFeedSnapshot(feedSnapshotKey("forYou", OTHER))).toBeNull();
    expect(takeFeedSnapshot(feedSnapshotKey("forYou", null))).toBeNull();
  });

  it("holds ONE slot — a newer save replaces the older, it does not accumulate", () => {
    saveFeedSnapshot(feedSnapshotKey("forYou", ME), snap([1n]));
    saveFeedSnapshot(feedSnapshotKey("following", ME), snap([2n]));
    expect(takeFeedSnapshot(feedSnapshotKey("forYou", ME))).toBeNull();
    expect(takeFeedSnapshot(feedSnapshotKey("following", ME))?.posts).toHaveLength(1);
  });

  it("refuses to hold an EMPTY page — restoring one would paint 'no posts' where 'not loaded yet' is true", () => {
    const k = feedSnapshotKey("forYou", ME);
    saveFeedSnapshot(k, snap([]));
    expect(takeFeedSnapshot(k)).toBeNull();
  });

  it("clear() drops it — the sign-out path", () => {
    const k = feedSnapshotKey("forYou", ME);
    saveFeedSnapshot(k, snap([1n]));
    clearFeedSnapshot();
    expect(takeFeedSnapshot(k)).toBeNull();
  });
});
