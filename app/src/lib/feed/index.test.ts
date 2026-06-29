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
    // It serves its own GraphQL pages — it does NOT route through the node's spec-120 MicroblogApi.
    expect(src.caps.nodeFeedApi).toBe(false);
  });

  it("returns the PAPI source for null (no endpoint configured)", () => {
    const src = makeFeedSource(fakeApi, null);
    expect(src.kind).toBe("papi");
    // The direct-node reader cannot SEARCH (no indexer), and says so…
    expect(src.caps.search).toBe(false);
    // …but it now CURSOR-PAGINATES node-direct (spec-119: the feed pages by post id), and does
    // threads + revocation flagging like the indexer.
    expect(src.caps.pagination).toBe(true);
    expect(src.caps.threads).toBe(true);
    expect(src.caps.revocation).toBe(true);
    // It CAN serve the spec-120 node-served reads (per-call runtime-detected against the live node).
    expect(src.caps.nodeFeedApi).toBe(true);
    // It also exposes the NextPostId liveness signal the home feed pages off.
    expect(typeof src.liveHeadId).toBe("function");
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
