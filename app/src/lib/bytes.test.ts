import { describe, it, expect } from "vitest";
import { utf8Bytes, clampToBytes, measureBytes } from "./bytes";

const MAX = 512; // runtime Microblog::MaxLength

describe("utf8Bytes", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("→")).toBe(3);
    // A 4-byte astral code point is ONE character but TWO .length units and FOUR bytes.
    expect("🎉".length).toBe(2);
    expect(utf8Bytes("🎉")).toBe(4);
  });
});

describe("clampToBytes", () => {
  it("fills the cap INCLUSIVE for a single-byte body", () => {
    expect(utf8Bytes(clampToBytes("a".repeat(600), MAX))).toBe(MAX);
  });

  it("never splits a multibyte code point (may land under the cap)", () => {
    // 511 ASCII + a 4-byte emoji: the emoji cannot fit in the last byte, so it is dropped whole.
    const clamped = clampToBytes("a".repeat(511) + "🎉", MAX);
    expect(utf8Bytes(clamped)).toBe(511);
    expect(clamped.endsWith("🎉")).toBe(false);
    // 2-byte chars divide 512 evenly, so this one lands exactly ON the cap.
    expect(utf8Bytes(clampToBytes("é".repeat(400), MAX))).toBe(MAX);
  });
});

describe("measureBytes", () => {
  it("is NOT over at exactly the cap — the chain's BoundedVec accepts len == bound", () => {
    const m = measureBytes("a".repeat(MAX), MAX);
    expect(m.bytes).toBe(MAX);
    expect(m.remaining).toBe(0);
    expect(m.over).toBe(false); // a full-length post must stay postable
  });

  it("is over by one byte past the cap", () => {
    const m = measureBytes("a".repeat(MAX + 1), MAX);
    expect(m.over).toBe(true);
    expect(m.remaining).toBe(-1);
  });

  it("still blocks an over-cap body (the un-clamped @mention serialization path)", () => {
    // `@alice` in the box serializes to `@<48-byte ss58>` on submit, so the posted body can exceed the
    // cap without the textarea clamp ever firing. The measure is the only guard there.
    const serialized = "a".repeat(480) + `@${"5".repeat(48)}`;
    expect(measureBytes(serialized, MAX).over).toBe(true);
  });

  it("the clamp can never produce a body the gate rejects", () => {
    // THE REGRESSION THIS FILE EXISTS FOR: clampToBytes fills to the cap inclusive, so a `>=` gate
    // greyed out the Post button on exactly the text the textarea let the user type.
    for (const s of ["a".repeat(900), "é".repeat(400), "🎉".repeat(200), "hello " + "→".repeat(300)]) {
      expect(measureBytes(clampToBytes(s, MAX), MAX).over).toBe(false);
    }
  });
});
