import { describe, it, expect } from "vitest";
import { filterModerated } from "./useModeration";
import type { CognoPost } from "@/lib/types";

const post = (id: bigint, author: string): CognoPost =>
  ({ id, author, text: "", at: 0 }) as CognoPost;

const A = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

describe("filterModerated", () => {
  const posts = [post(1n, A), post(2n, B), post(3n, A)];

  it("drops every post by a blocked author", () => {
    const out = filterModerated(posts, new Set([A]), new Set());
    expect(out.map((p) => p.id)).toEqual([2n]);
  });

  it("drops one hidden post by id, keeping the author's others", () => {
    const out = filterModerated(posts, new Set(), new Set(["1"]));
    expect(out.map((p) => p.id)).toEqual([2n, 3n]);
  });

  it("applies block and hide together", () => {
    const out = filterModerated(posts, new Set([B]), new Set(["3"]));
    expect(out.map((p) => p.id)).toEqual([1n]);
  });

  it("is a no-op with empty sets", () => {
    expect(filterModerated(posts, new Set(), new Set())).toHaveLength(3);
  });
});
