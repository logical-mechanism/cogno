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

  it("does NOT Unicode-normalize (stays byte-comparable with the node's raw scan)", () => {
    const composed = "café"; // é = U+00E9
    const decomposed = "café"; // e + combining acute
    // Both pass through unchanged, so an NFD query still byte-matches NFD-authored content.
    expect(normalizeQuery(decomposed)).toBe(decomposed);
    expect(normalizeQuery(composed)).toBe(composed);
    expect(normalizeQuery(decomposed)).not.toBe(normalizeQuery(composed));
  });

  it("maps a whitespace-only query to empty", () => {
    expect(normalizeQuery("   \t ")).toBe("");
  });
});

describe("isQueryTooShort", () => {
  it("is false for empty (that is 'no query', not 'too short')", () => {
    expect(isQueryTooShort("")).toBe(false);
  });

  it("is true for a non-empty ASCII term below the minimum", () => {
    expect(isQueryTooShort("a")).toBe(true);
    expect("a".length).toBeLessThan(MIN_QUERY_LEN);
  });

  it("is false once an ASCII term reaches the minimum", () => {
    expect(isQueryTooShort("ab")).toBe(false);
  });

  it("is false for a single non-ASCII character (CJK is a complete searchable word)", () => {
    expect(isQueryTooShort("猫")).toBe(false); // 猫
    expect(isQueryTooShort("日")).toBe(false); // 日
  });
});
