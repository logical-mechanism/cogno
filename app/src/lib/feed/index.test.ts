// Pure-logic test for the read-path selector. Since the all-Rust restart there is exactly ONE reader —
// the PAPI-direct node source — so `makeFeedSource` always returns it. The node serves everything the
// old SubQuery indexer did (feed / thread / profile / search / people / replies), so there is no
// GraphQL/hybrid branch left to select. We assert the reader identity + that every cap it advertises is
// node-served (search + profileReplies were the last two folded in at P8b).

import { describe, it, expect } from "vitest";
import { makeFeedSource } from "./index";
import type { CognoApi } from "@/lib/types";

// The selector never touches the api until a method is called.
const fakeApi = {} as unknown as CognoApi;

describe("makeFeedSource — the sole PAPI-direct reader", () => {
  it("returns the PAPI-direct node source", () => {
    const src = makeFeedSource(fakeApi);
    expect(src.kind).toBe("papi");
    // It exposes the NextPostId liveness signal the home feed pages off.
    expect(typeof src.liveHeadId).toBe("function");
  });

  it("advertises every capability as node-served (search + profileReplies folded in at P8b)", () => {
    const { caps } = makeFeedSource(fakeApi);
    // The two capabilities that used to be indexer-only are now node-served.
    expect(caps.search).toBe(true);
    expect(caps.profileReplies).toBe(true);
    // …alongside the rest of the node-direct surface.
    expect(caps.pagination).toBe(true);
    expect(caps.threads).toBe(true);
    expect(caps.revocation).toBe(true);
    expect(caps.tallies).toBe(true);
    expect(caps.follows).toBe(true);
    expect(caps.profiles).toBe(true);
    expect(caps.profileLikes).toBe(true);
    expect(caps.whoToFollow).toBe(true);
    // The spec-200 MicroblogApi read path (runtime-detected per node).
    expect(caps.nodeFeedApi).toBe(true);
  });
});
