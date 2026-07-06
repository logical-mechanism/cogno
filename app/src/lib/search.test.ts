import { describe, it, expect } from "vitest";
import { normalizeQuery, isQueryTooShort, MIN_QUERY_LEN } from "./search";

describe("normalizeQuery", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeQuery("  hello   world  ")).toBe("hello world");
    expect(normalizeQuery("a\t\nb")).toBe("a b");
  });

  it("is idempotent", () => {
    const once = normalizeQuery("  a   b  ");
    expect(normalizeQuery(once)).toBe(once);
  });

  it("NFC-normalizes so decomposed and composed accents match", () => {
    const composed = "café"; // é = U+00E9
    const decomposed = "café"; // e + combining acute
    expect(decomposed).not.toBe(composed);
    expect(normalizeQuery(decomposed)).toBe(normalizeQuery(composed));
  });

  it("maps a whitespace-only query to empty", () => {
    expect(normalizeQuery("   \t ")).toBe("");
  });
});

describe("isQueryTooShort", () => {
  it("is false for empty (that is 'no query', not 'too short')", () => {
    expect(isQueryTooShort("")).toBe(false);
  });

  it("is true for a non-empty term below the minimum", () => {
    expect(isQueryTooShort("a")).toBe(true);
    expect("a".length).toBeLessThan(MIN_QUERY_LEN);
  });

  it("is false once the term reaches the minimum", () => {
    expect(isQueryTooShort("ab")).toBe(false);
  });
});
