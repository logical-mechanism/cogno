import { describe, it, expect, vi, afterEach } from "vitest";
import { proposalHttpUrl, parseProposalDoc, resolveProposal } from "./proposalMeta";

describe("proposalHttpUrl", () => {
  it("passes https through", () => {
    expect(proposalHttpUrl("https://raw.githubusercontent.com/x/y/z.json")).toBe(
      "https://raw.githubusercontent.com/x/y/z.json",
    );
  });
  it("maps ipfs:// to a gateway", () => {
    expect(proposalHttpUrl("ipfs://bafyCID")).toBe("https://ipfs.io/ipfs/bafyCID");
    expect(proposalHttpUrl("ipfs://bafyCID/doc.json")).toBe("https://ipfs.io/ipfs/bafyCID/doc.json");
  });
  it("handles the ipfs://ipfs/<cid> variant", () => {
    expect(proposalHttpUrl("ipfs://ipfs/bafyCID")).toBe("https://ipfs.io/ipfs/bafyCID");
  });
  it("refuses http (mixed-content), data:, javascript:, and junk", () => {
    expect(proposalHttpUrl("http://example.com/x.json")).toBeNull();
    expect(proposalHttpUrl("data:application/json,{}")).toBeNull();
    expect(proposalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(proposalHttpUrl("not a url")).toBeNull();
    expect(proposalHttpUrl("")).toBeNull();
    expect(proposalHttpUrl("ipfs://")).toBeNull();
  });
});

describe("parseProposalDoc", () => {
  it("extracts CIP-108 body fields", () => {
    const doc = {
      "@context": {},
      hashAlgorithm: "blake2b-256",
      body: {
        title: "Lower minPoolCost",
        abstract: "This proposal lowers the parameter.",
        motivation: "Because it is too high.",
        rationale: "Analysis shows small pools suffer.",
      },
    };
    expect(parseProposalDoc(doc)).toEqual({
      title: "Lower minPoolCost",
      abstract: "This proposal lowers the parameter.",
      motivation: "Because it is too high.",
      rationale: "Analysis shows small pools suffer.",
    });
  });

  it("reads JSON-LD { @value } wrapping", () => {
    const doc = { body: { title: { "@value": "Wrapped title" }, abstract: { "@value": "Wrapped abstract" } } };
    const m = parseProposalDoc(doc)!;
    expect(m.title).toBe("Wrapped title");
    expect(m.abstract).toBe("Wrapped abstract");
  });

  it("tolerates fields at the top level (no body)", () => {
    expect(parseProposalDoc({ title: "Top-level title" })?.title).toBe("Top-level title");
  });

  it("keeps prose line breaks but flattens the title to one line", () => {
    const m = parseProposalDoc({ body: { title: "a\nb", abstract: "para1\n\npara2" } })!;
    expect(m.title).toBe("a b"); // sanitizeInline collapses newlines
    expect(m.abstract).toBe("para1\n\npara2"); // sanitizeText keeps them
  });

  it("hardens attacker-controlled text (strips invisible / bidi controls)", () => {
    // A right-to-left override + a zero-width space embedded in the title must not survive to the DOM.
    const m = parseProposalDoc({ body: { title: "safe‮evil​" } })!;
    expect(m.title).not.toContain("‮");
    expect(m.title).not.toContain("​");
  });

  it("returns null when nothing usable is present", () => {
    expect(parseProposalDoc({})).toBeNull();
    expect(parseProposalDoc({ body: {} })).toBeNull();
    expect(parseProposalDoc({ body: { title: "   " } })).toBeNull();
    expect(parseProposalDoc(null)).toBeNull();
    expect(parseProposalDoc("nope")).toBeNull();
    expect(parseProposalDoc(42)).toBeNull();
  });

  it("caps an over-long field", () => {
    const huge = "x".repeat(5000);
    const m = parseProposalDoc({ body: { abstract: huge } })!;
    expect(m.abstract!.length).toBeLessThanOrEqual(1200);
  });
});

// A hand-rolled Response so the streaming `readCapped` path runs deterministically, independent of the
// environment's global Response/fetch implementation.
function fakeResponse(bodyStr: string, status = 200): Response {
  const bytes = new TextEncoder().encode(bodyStr);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? String(bytes.byteLength) : null) },
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {},
        };
      },
    },
    async text() {
      return bodyStr;
    },
  } as unknown as Response;
}

describe("resolveProposal caching (terminal vs transient)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("does NOT cache a transient failure — a later call retries and can succeed", async () => {
    const url = "https://gov.example/retry-after-transient.json";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline")) // no response arrived → transient
      .mockResolvedValueOnce(fakeResponse(JSON.stringify({ body: { title: "Recovered" } })));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await resolveProposal(url)).toBeNull(); // transient failure → null, must not be cached
    expect((await resolveProposal(url))?.title).toBe("Recovered"); // retry hits the network again
    expect(fetchMock).toHaveBeenCalledTimes(2); // proves the transient result was not cached
  });

  it("DOES cache a terminal failure (404) — a later call is served from cache, no re-fetch", async () => {
    const url = "https://gov.example/terminal-404.json";
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse("", 404));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await resolveProposal(url)).toBeNull();
    expect(await resolveProposal(url)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // a settled 404 is not re-fetched
  });

  it("caches malformed JSON as terminal — a later call does not re-fetch", async () => {
    const url = "https://gov.example/bad-json.json";
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse("{ not valid json"));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await resolveProposal(url)).toBeNull();
    expect(await resolveProposal(url)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // a response arrived; bad JSON won't improve on retry
  });

  it("DOES cache a terminal success — a later call is served from cache", async () => {
    const url = "https://gov.example/terminal-ok.json";
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(JSON.stringify({ body: { title: "Cached" } })));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect((await resolveProposal(url))?.title).toBe("Cached");
    expect((await resolveProposal(url))?.title).toBe("Cached");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
