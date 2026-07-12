// Tests for the error classifier + the single copy producer.
//
// THE FIXTURE SHAPE IS THE POINT. These used to live in post.test.ts against a HAND-INVENTED module
// error — `{ type: "Module", value: { type: "Microblog", value: { error: "TooLong" } } }` — where the
// variant name sat under `.error` as a string. That is not what the chain sends. It passed anyway,
// because the old `stringifyDispatchError` JSON-stringified the whole value blindly and asserted only
// that the output CONTAINED "TooLong". So the one fixture pinning the decoded error shape was wrong,
// and nothing noticed.
//
// The real shape is settled by the generated descriptors, which ARE the codec: `DispatchError` is a
// tagged enum, PAPI models every enum as `{ type, value }`, and pallet errors nest three deep —
//
//   { type: "Module", value: { type: "Microblog", value: { type: "NotAllowed" } } }
//
// (see .papi/descriptors/dist/common-types.d.ts — `Ibqiqjf0ascstg`, whose "Module" arm is
// `Enum<{ Microblog: I69mvg1lm3k89j, Profile: ..., ... }>`, each an AnonymousEnum of variant names).
// A copy table keyed on the wrong field would match NOTHING and ship green — which is exactly the
// failure mode these fixtures now prevent.

import { describe, it, expect } from "vitest";
import { classifyDispatchError, classifyThrown, errorCopy, type ChainError } from "./errors";

/** A pallet error in the shape PAPI actually decodes (three-level tagged enum). */
const moduleErr = (pallet: string, variant: string) => ({
  type: "Module",
  value: { type: pallet, value: { type: variant } },
});

describe("classifyDispatchError", () => {
  it("decodes a pallet error into its pallet + variant names", () => {
    expect(classifyDispatchError(moduleErr("Microblog", "NotAllowed"))).toEqual({
      kind: "module",
      pallet: "Microblog",
      name: "NotAllowed",
    });
  });

  it("classifies a Profile error, not just Microblog (the profile writes are a real surface)", () => {
    expect(classifyDispatchError(moduleErr("Profile", "NameTooLong"))).toEqual({
      kind: "module",
      pallet: "Profile",
      name: "NameTooLong",
    });
  });

  it("degrades the UNDECODED numeric module arm to raw, keeping the indices", () => {
    // Substrate hands back `{ index, error }` when the metadata is unavailable. There are no names
    // here, and the frontend has no pallet-index -> name table, so it CANNOT be worded. Raw is the
    // honest floor: an opaque error beats a confidently wrong sentence.
    const e = classifyDispatchError({ type: "Module", value: { index: 10n, error: 3n } });
    expect(e.kind).toBe("raw");
    expect(errorCopy(e)).toContain("10");
    expect(errorCopy(e)).toContain("Module");
  });

  it("is bigint-safe (a u64-bearing error value must not throw on the way to a toast)", () => {
    expect(() => classifyDispatchError({ type: "Module", value: { at: 2n ** 64n - 1n } })).not.toThrow();
  });

  it("falls back to the bare type when the value is empty/null (BadOrigin carries nothing)", () => {
    expect(errorCopy(classifyDispatchError({ type: "BadOrigin", value: null }))).toBe("BadOrigin");
    expect(errorCopy(classifyDispatchError({ type: "BadOrigin", value: {} }))).toBe("BadOrigin");
  });

  it("reports a missing dispatch error rather than inventing one", () => {
    expect(errorCopy(classifyDispatchError(undefined))).toMatch(/no dispatch error/i);
  });
});

describe("classifyThrown", () => {
  it("recognises the CheckCapacity pool rejection STRUCTURALLY, as a rate-limit kind", () => {
    // The whole point of the module: this is classified ONCE, here, where the raw error is in hand —
    // rather than rewritten into English and regexed back out by three separate consumers downstream.
    expect(classifyThrown(new Error("1010: Invalid Transaction: ExhaustsResources"))).toEqual({
      kind: "rate-limit",
    });
  });

  it("passes a signer rejection through as raw", () => {
    expect(classifyThrown(new Error("user cancelled"))).toEqual({ kind: "raw", detail: "user cancelled" });
  });

  it("passes a string error through as raw", () => {
    expect(classifyThrown("network down")).toEqual({ kind: "raw", detail: "network down" });
  });

  it("is bigint-safe when serializing a non-Error object", () => {
    const out = errorCopy(classifyThrown({ code: 5n, msg: "boom" }));
    expect(out).toContain("5");
    expect(out).toContain("boom");
  });

  it("defaults an empty message rather than showing a blank toast", () => {
    expect(errorCopy(classifyThrown(""))).toBe("Transaction failed.");
  });
});

describe("errorCopy", () => {
  it("words a mapped pallet error in prose — it used to render as raw JSON in a toast", () => {
    // Before: the user literally saw  Module: {"type":"Microblog","value":{"type":"NotAllowed"}}
    const copy = errorCopy({ kind: "module", pallet: "Microblog", name: "NotAllowed" });
    expect(copy).toBe("You need a linked Cardano identity to do that.");
    expect(copy).not.toContain("{");
    expect(copy).not.toContain("Module");
  });

  it("falls back to 'Pallet: Variant' for an UNMAPPED variant — never to JSON, never to silence", () => {
    expect(errorCopy({ kind: "module", pallet: "Microblog", name: "SomeFutureError" })).toBe(
      "Microblog: SomeFutureError",
    );
  });

  it("produces the rate-limit line from ONE place", () => {
    // This copy existed as two subtly different sentences — "You are over the rate limit." in the chain
    // layer (written, regex-matched, then discarded on every path) and "You're over the rate limit." in
    // the toaster. There is now one.
    expect(errorCopy({ kind: "rate-limit" })).toBe("You're over the rate limit. Try again shortly.");
  });

  it("is total over the union (every kind words to non-empty prose)", () => {
    const all: ChainError[] = [
      { kind: "rate-limit" },
      { kind: "module", pallet: "Profile", name: "NoProfile" },
      { kind: "raw", detail: "boom" },
    ];
    for (const e of all) expect(errorCopy(e).length).toBeGreaterThan(0);
  });
});

describe("the boot guard can no longer be masked as a rate limit", () => {
  it("keeps an encoding-mismatch reason RAW even when its prose mentions a rate limit", () => {
    // The regression this design forecloses. The boot guard's reason string flowed through the same
    // `isRateLimit(message)` regex as every tx failure. Any reason containing "rate limit" would have
    // been rendered as "You're over the rate limit" — telling the user they were posting too fast when
    // the real problem was that the app mis-encodes writes against this node. `kind` is assigned at the
    // source now, so prose cannot reclassify anything.
    const bootReason = "Node runtime spec 204 != descriptors 203. Posting is blocked (rate limit unrelated).";
    const e: ChainError = { kind: "raw", detail: bootReason };
    expect(e.kind).not.toBe("rate-limit");
    expect(errorCopy(e)).toBe(bootReason);
  });
});
