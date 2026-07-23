import { describe, it, expect } from "vitest";
import { proposalHttpUrl, parseProposalDoc } from "./proposalMeta";

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
