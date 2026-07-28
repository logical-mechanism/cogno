import { describe, it, expect } from "vitest";
import {
  parseReadState,
  serializeReadState,
  withSeen,
  withAllRead,
  countUnread,
  isUnread,
  EMPTY_READ_STATE,
  type ReadState,
} from "./notificationReadState";

describe("parseReadState", () => {
  it("returns EMPTY for null / malformed / non-number fields", () => {
    expect(parseReadState(null)).toEqual(EMPTY_READ_STATE);
    expect(parseReadState("not json")).toEqual(EMPTY_READ_STATE);
    expect(parseReadState(JSON.stringify({ readThrough: "x", firstSeen: { a: "y" } }))).toEqual(
      EMPTY_READ_STATE,
    );
  });
  it("round-trips through serialize", () => {
    const s: ReadState = { readThrough: 10, firstSeen: { a: 1, b: 2 } };
    expect(parseReadState(serializeReadState(s))).toEqual(s);
  });
});

describe("withSeen", () => {
  it("stamps first-seen for new ids only, and returns the SAME ref when nothing is new", () => {
    const s0 = EMPTY_READ_STATE;
    const s1 = withSeen(s0, ["a", "b"], 100);
    expect(s1.firstSeen).toEqual({ a: 100, b: 100 });
    // re-recording the same ids at a later time must NOT overwrite (stable order) and returns same ref.
    const s2 = withSeen(s1, ["a", "b"], 200);
    expect(s2).toBe(s1);
    expect(s2.firstSeen).toEqual({ a: 100, b: 100 });
    // a genuinely new id is added at its own time.
    const s3 = withSeen(s2, ["c"], 300);
    expect(s3.firstSeen).toEqual({ a: 100, b: 100, c: 300 });
  });
});

// F18. Eviction here is not forgetting: the fold re-derives the SAME permanent chain keys every couple
// of minutes, so whatever is dropped comes straight back and `withSeen` re-stamps it at `now`, which is
// after the read cursor by definition. That makes an evicted READ key return as UNREAD — a dismissed
// notification the reader can never make stay gone. An evicted UNREAD key returns as unread, which it
// already was. So unread entries are the ones to drop, and the code (and its comment) said the reverse.
describe("withSeen eviction prefers UNREAD entries (a dismissed item stays dismissed)", () => {
  it("drops unread entries first when over the cap, preserving every read key", () => {
    // 9600 READ entries (first-seen 100, cursor 200) + enough NEW unread to cross MAX_TRACKED (10000).
    const firstSeen: Record<string, number> = {};
    for (let i = 0; i < 9600; i++) firstSeen[`r${i}`] = 100;
    const base: ReadState = { readThrough: 200, firstSeen };
    const newUnread = Array.from({ length: 800 }, (_, i) => `u${i}`); // 9600 + 800 = 10400 → evict 400

    const next = withSeen(base, newUnread, 300);
    expect(Object.keys(next.firstSeen).length).toBe(10000); // capped
    // Every READ key survives — none were evicted.
    for (let i = 0; i < 9600; i++) expect(next.firstSeen[`r${i}`]).toBe(100);
    // The 400 evicted keys are the oldest unread ones; 400 of the 800 new items remain.
    expect(countUnread(next)).toBe(400);
  });

  it("an evicted key that comes back on the NEXT fold is not unread if it had been read", () => {
    // THE assertion. One `withSeen` call cannot see this — the defect only appears on the SECOND
    // fold, when the same permanent chain keys are re-supplied. This failed before the inversion.
    const firstSeen: Record<string, number> = {};
    for (let i = 0; i < 9600; i++) firstSeen[`r${i}`] = 100;
    const base: ReadState = { readThrough: 200, firstSeen };
    const allKeys = Object.keys(firstSeen);
    const newUnread = Array.from({ length: 800 }, (_, i) => `u${i}`);

    const afterEviction = withSeen(base, newUnread, 300);
    // The fold runs again ~2 minutes later and hands back EVERY key it derives from the chain.
    const refolded = withSeen(afterEviction, [...allKeys, ...newUnread], 400);

    for (const k of allKeys) expect(isUnread(refolded, k)).toBe(false);
  });

  it("falls back to read entries only when the unread flood alone cannot cover the overflow", () => {
    // A pathological all-unread flood: there is nothing else to reclaim, so read entries do go.
    const firstSeen: Record<string, number> = {};
    for (let i = 0; i < 500; i++) firstSeen[`r${i}`] = 100;
    const base: ReadState = { readThrough: 200, firstSeen };
    const flood = Array.from({ length: 10_000 }, (_, i) => `u${i}`); // 500 + 10000 → evict 500

    const next = withSeen(base, flood, 300);
    expect(Object.keys(next.firstSeen).length).toBe(10_000);
  });
});

describe("withAllRead + countUnread + isUnread", () => {
  it("counts items first-seen after the read cursor, and clears on markAllRead", () => {
    let s = withSeen(EMPTY_READ_STATE, ["a", "b"], 100);
    s = withSeen(s, ["c"], 300);
    expect(countUnread(s)).toBe(3); // readThrough 0 → all unread
    expect(isUnread(s, "a")).toBe(true);

    s = withAllRead(s, 200); // read through 200
    expect(countUnread(s)).toBe(1); // only c (first-seen 300) remains unread
    expect(isUnread(s, "a")).toBe(false);
    expect(isUnread(s, "c")).toBe(true);

    s = withAllRead(s, 400); // read through everything
    expect(countUnread(s)).toBe(0);
  });

  it("withAllRead returns the same ref when the cursor is already ahead", () => {
    const s = withAllRead(EMPTY_READ_STATE, 100);
    expect(withAllRead(s, 50)).toBe(s);
  });
});
