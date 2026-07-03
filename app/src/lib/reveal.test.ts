import { describe, it, expect } from "vitest";
import { reveal, unreveal, isRevealed } from "./reveal";

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

  it("unreveal() re-covers a revealed key (the inverse of reveal), idempotently", () => {
    reveal("u1");
    expect(isRevealed("u1")).toBe(true);
    unreveal("u1");
    expect(isRevealed("u1")).toBe(false);
    // idempotent + a no-op on a key that was never revealed
    unreveal("u1");
    unreveal("never");
    expect(isRevealed("u1")).toBe(false);
    // re-covering then revealing again works (round-trip)
    reveal("u1");
    expect(isRevealed("u1")).toBe(true);
  });
});
