import { describe, it, expect } from "vitest";
import { compareNotifs, orderNotifs, type Notif } from "./notifications";

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
