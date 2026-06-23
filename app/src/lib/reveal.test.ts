import { describe, it, expect } from "vitest";
import { reveal, isRevealed } from "./reveal";

// The store is a module singleton, so each test uses a distinct key (state accumulates within a file,
// but vitest isolates modules per test file).
describe("reveal store — session reveal memory", () => {
  it("a key is not revealed until reveal() is called", () => {
    expect(isRevealed("https://x/a.png")).toBe(false);
    reveal("https://x/a.png");
    expect(isRevealed("https://x/a.png")).toBe(true);
  });

  it("reveal() is idempotent and scoped to the exact key", () => {
    reveal("k1");
    reveal("k1");
    expect(isRevealed("k1")).toBe(true);
    expect(isRevealed("k2")).toBe(false);
  });
});
