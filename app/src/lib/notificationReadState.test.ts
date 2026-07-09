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

describe("withSeen eviction prefers READ entries (never re-flips unread items)", () => {
  it("drops read entries first when over the cap, preserving all unread keys", () => {
    // 9600 READ entries (first-seen 100, cursor 200) + enough NEW unread to cross MAX_TRACKED (10000).
    const firstSeen: Record<string, number> = {};
    for (let i = 0; i < 9600; i++) firstSeen[`r${i}`] = 100;
    const base: ReadState = { readThrough: 200, firstSeen };
    const newUnread = Array.from({ length: 800 }, (_, i) => `u${i}`); // 9600 + 800 = 10400 → evict 400

    const next = withSeen(base, newUnread, 300);
    const keys = Object.keys(next.firstSeen);
    expect(keys.length).toBe(10000); // capped
    // Every newly-seen (unread) key survives — none were evicted.
    for (const u of newUnread) expect(next.firstSeen[u]).toBe(300);
    // The 400 evicted keys are all READ ones; unread count is exactly the 800 new items.
    expect(countUnread(next)).toBe(800);
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
