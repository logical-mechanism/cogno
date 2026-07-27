import { describe, it, expect } from "vitest";
import { compareNotifs, loadNotifications, MAX_MY_POSTS, orderNotifs, type Notif } from "./notifications";
import type { Ss58 } from "@/lib/types";

const like = (actor: string, key = `like:1:${actor}`): Notif => ({ key, kind: "like", actor });
const reply = (actor: string, at: number, id: string): Notif => ({
  key: `reply:${id}`,
  kind: "reply",
  actor,
  postId: BigInt(id),
  at,
});

describe("compareNotifs", () => {
  it("orders newer first-seen first", () => {
    const a = like("A", "like:1:A");
    const b = like("B", "like:1:B");
    const seen = { "like:1:A": 100, "like:1:B": 200 };
    expect([a, b].sort((x, y) => compareNotifs(x, y, seen))).toEqual([b, a]);
  });

  it("within one fold (equal first-seen), post-based signals sort by at desc, above edges", () => {
    const r1 = reply("X", 10, "10");
    const r2 = reply("Y", 20, "20");
    const l = like("Z", "like:1:Z");
    const seen = { "reply:10": 500, "reply:20": 500, "like:1:Z": 500 };
    const ordered = [r1, l, r2].sort((x, y) => compareNotifs(x, y, seen));
    // r2 (at 20) before r1 (at 10) before the timeless like.
    expect(ordered).toEqual([r2, r1, l]);
  });
});

describe("orderNotifs", () => {
  it("drops muted actors and sorts newest-first", () => {
    const a = like("A", "like:1:A");
    const muted = like("M", "like:1:M");
    const seen = { "like:1:A": 100, "like:1:M": 999 };
    const out = orderNotifs([a, muted], seen, new Set(["M"]));
    expect(out).toEqual([a]); // muted M dropped despite a newer first-seen
  });
});

// ── the viewer's own post-id read (spec 212) ────────────────────────────────────────────────────
//
// `ByAuthor` went from one `BoundedVec` blob per author to a seq-keyed double map beside a
// `ByAuthorCount` counter, so this reader had to change shape. What it must keep is the property the
// blob read gave for free: the scan examines the viewer's NEWEST posts, and `truncated` is honest.
// Pinned here because nothing else exercises it, and the failure is silent — a wrong seq window
// scans the viewer's OLDEST posts and their notifications tab quietly goes empty.

const emptyEntries = () => Promise.resolve([]);

/** A minimal api whose only populated read is the viewer's post index. */
function apiWithPostIds(ids: bigint[]) {
  const reads: Array<[string, bigint]> = [];
  return {
    api: {
      query: {
        Microblog: {
          ByAuthorCount: { getValue: () => Promise.resolve(BigInt(ids.length)) },
          ByAuthor: {
            getValues: (keys: ReadonlyArray<readonly [string, bigint]>) => {
              keys.forEach((k) => reads.push([k[0], k[1]]));
              return Promise.resolve(keys.map(([, seq]) => ids[Number(seq)]));
            },
          },
          Votes: { getEntries: emptyEntries },
          RepliesByParent: { getEntries: emptyEntries },
          PollVotes: { getEntries: emptyEntries },
          AccountVotes: { getEntries: emptyEntries },
          Followers: { getEntries: emptyEntries },
        },
      },
    } as any,
    reads,
  };
}

describe("loadNotifications — the viewer's post-id window", () => {
  it("reads every post when the viewer is under the cap", async () => {
    const { api, reads } = apiWithPostIds([10n, 11n, 12n]);
    const out = await loadNotifications(api, null, "me" as Ss58);
    expect(out.truncated).toBe(false);
    expect(reads.map(([, seq]) => Number(seq))).toEqual([0, 1, 2]);
  });

  it("reads the NEWEST MAX_MY_POSTS seqs, not the oldest, and reports truncation", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => BigInt(i));
    const { api, reads } = apiWithPostIds(ids);
    const out = await loadNotifications(api, null, "me" as Ss58);
    expect(out.truncated).toBe(true);
    const seqs = reads.map(([, seq]) => Number(seq));
    expect(seqs).toHaveLength(MAX_MY_POSTS);
    // The window is the TOP of the sequence — seq is assigned in append order over ascending post
    // ids, so the highest seqs are the newest posts.
    expect(seqs[0]).toBe(200 - MAX_MY_POSTS);
    expect(seqs[seqs.length - 1]).toBe(199);
  });

  it("degrades to an empty scan rather than throwing when the counter read fails", async () => {
    const api = {
      query: {
        Microblog: {
          ByAuthorCount: { getValue: () => Promise.reject(new Error("node down")) },
          ByAuthor: { getValues: () => Promise.resolve([]) },
          Votes: { getEntries: emptyEntries },
          RepliesByParent: { getEntries: emptyEntries },
          PollVotes: { getEntries: emptyEntries },
          AccountVotes: { getEntries: emptyEntries },
          Followers: { getEntries: emptyEntries },
        },
      },
    } as any;
    const out = await loadNotifications(api, null, "me" as Ss58);
    expect(out.notifs).toEqual([]);
    expect(out.truncated).toBe(false);
  });
});
