// Pure-logic tests for the read-path selector. The seam guarantee is: a configured GraphQL
// endpoint routes to the indexer reader; anything empty/whitespace falls back to the always-
// available PAPI-direct reader, so the indexer is never load-bearing. We only assert the choice
// (kind + caps) — the readers themselves are tested where their mapping logic lives.

import { describe, it, expect } from "vitest";
import { makeFeedSource } from "./index";
import type { CognoApi } from "@/lib/types";

// The selector only inspects the url; the api is never touched until a method is called.
const fakeApi = {} as unknown as CognoApi;

describe("makeFeedSource — reader selection", () => {
  it("returns the GRAPHQL source for a non-empty endpoint", () => {
    const src = makeFeedSource(fakeApi, "http://localhost:3000/");
    expect(src.kind).toBe("graphql");
    // The indexer reader honestly advertises search + pagination.
    expect(src.caps.search).toBe(true);
    expect(src.caps.pagination).toBe(true);
  });

  it("returns the PAPI source for null (no endpoint configured)", () => {
    const src = makeFeedSource(fakeApi, null);
    expect(src.kind).toBe("papi");
    // The direct-node reader cannot search or cursor-paginate, and says so.
    expect(src.caps.search).toBe(false);
    expect(src.caps.pagination).toBe(false);
    // …but it CAN do threads + revocation flagging, like the indexer.
    expect(src.caps.threads).toBe(true);
    expect(src.caps.revocation).toBe(true);
  });

  it("returns the PAPI source for an empty string", () => {
    expect(makeFeedSource(fakeApi, "").kind).toBe("papi");
  });

  it("TRIMS a whitespace-only endpoint and falls back to PAPI", () => {
    expect(makeFeedSource(fakeApi, "   ").kind).toBe("papi");
    expect(makeFeedSource(fakeApi, "\t\n ").kind).toBe("papi");
  });

  it("TRIMS surrounding whitespace off a real endpoint (still routes to graphql)", () => {
    const src = makeFeedSource(fakeApi, "  http://localhost:3000/  ");
    expect(src.kind).toBe("graphql");
  });
});
