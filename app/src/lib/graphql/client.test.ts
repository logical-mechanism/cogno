// Pure-logic tests for the tiny GraphQL client's error taxonomy. The error `kind`
// (network|http|graphql) is observable so the feed source can retry transient network blips
// but surface persistent indexer errors — so each branch must produce the right kind.

import { describe, it, expect, vi, afterEach } from "vitest";
import { gqlRequest, GraphqlError } from "./client";

afterEach(() => {
  vi.restoreAllMocks();
});

const mockFetch = (impl: (...a: unknown[]) => unknown) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(impl as never);

/** Run a request that is expected to reject and return the thrown value (typed for assertions). */
async function rejected(p: Promise<unknown>): Promise<GraphqlError & { name: string }> {
  return p.then(
    () => {
      throw new Error("expected gqlRequest to reject, but it resolved");
    },
    (e: unknown) => e as GraphqlError & { name: string },
  );
}

describe("gqlRequest", () => {
  it("returns data on a 2xx with a valid envelope", async () => {
    mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: { value: 42 } }) }));
    await expect(gqlRequest("http://x/", "query {}")).resolves.toEqual({ value: 42 });
  });

  it("throws GraphqlError kind='network' when fetch itself rejects (unreachable/CORS/DNS)", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = await rejected(gqlRequest("http://x/", "q"));
    expect(err).toBeInstanceOf(GraphqlError);
    expect(err.kind).toBe("network");
    expect(err.message).toContain("http://x/");
  });

  it("re-throws an AbortError verbatim (a poll abort is not a GraphqlError)", async () => {
    mockFetch(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const err = await rejected(gqlRequest("http://x/", "q"));
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(GraphqlError);
  });

  it("throws GraphqlError kind='http' with the status on a non-2xx response", async () => {
    mockFetch(async () => ({ ok: false, status: 503, statusText: "Service Unavailable", json: async () => ({}) }));
    const err = await rejected(gqlRequest("http://x/", "q"));
    expect(err).toBeInstanceOf(GraphqlError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(503);
  });

  it("throws GraphqlError kind='http' when the body is not JSON", async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }));
    const err = await rejected(gqlRequest("http://x/", "q"));
    expect(err).toBeInstanceOf(GraphqlError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(200);
  });

  it("throws GraphqlError kind='graphql' when the envelope carries errors", async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: "field foo not found" }, { message: "and bar" }] }),
    }));
    const err = await rejected(gqlRequest("http://x/", "q"));
    expect(err).toBeInstanceOf(GraphqlError);
    expect(err.kind).toBe("graphql");
    expect(err.message).toContain("field foo not found");
    expect(err.message).toContain("and bar");
  });

  it("throws GraphqlError kind='graphql' when data is missing/null (no errors array)", async () => {
    mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: null }) }));
    const err = await rejected(gqlRequest("http://x/", "q"));
    expect(err).toBeInstanceOf(GraphqlError);
    expect(err.kind).toBe("graphql");
  });
});
