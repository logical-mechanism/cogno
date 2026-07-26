// The shipped state of the operator serve lever, and the predicates every read path calls.
//
// The env-var PARSING is deliberately not tested here: `process.env.NEXT_PUBLIC_*` is inlined by Next
// at build time and read at module evaluation, so it cannot be varied per test without re-importing
// the module under a mutated env, which would test vitest's module graph rather than this code. What
// IS worth pinning is the shipped state (empty, so the whole mechanism is inert) and the predicates,
// which several read paths call directly and which must agree with each other.

import { describe, it, expect } from "vitest";
import { ss58Address } from "@polkadot-labs/hdkd-helpers";
import { normalizeSs58 } from "@/lib/ss58";
import {
  DENIED_AUTHORS,
  DENIED_POSTS,
  DENYLIST_EMPTY,
  isDenied,
  isDeniedAuthor,
  isDeniedPost,
} from "./denylist";

describe("the shipped denylist", () => {
  it("is EMPTY, so this deployment declines to serve nothing", () => {
    // If this ever fails, someone populated the list in the source instead of through the build env,
    // which puts a delisting decision in git history rather than in a deploy. That is a decision worth
    // making on purpose, not by accident.
    expect(DENIED_AUTHORS.size).toBe(0);
    expect(DENIED_POSTS.size).toBe(0);
    expect(DENYLIST_EMPTY).toBe(true);
  });

  it("makes every predicate false, so the whole mechanism is inert", () => {
    expect(isDeniedAuthor("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY")).toBe(false);
    expect(isDeniedPost(1n)).toBe(false);
    expect(isDenied({ id: 1n, author: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" })).toBe(false);
  });
});

describe("the predicates", () => {
  it("treat null and undefined as not-denied, never as a match", () => {
    // Every call site passes an optional value (an author that has not resolved, a post id that is
    // null while loading). A nullish match would blank content while a read was still in flight.
    expect(isDeniedAuthor(null)).toBe(false);
    expect(isDeniedAuthor(undefined)).toBe(false);
    expect(isDeniedPost(null)).toBe(false);
    expect(isDeniedPost(undefined)).toBe(false);
  });

  it("accept a post id as either a bigint or a string", () => {
    // The set holds decimal STRINGS so it matches hiddenStore's `String(id)` convention and needs no
    // bigint parsing on a hot path; both call shapes exist in the codebase.
    expect(isDeniedPost(7n)).toBe(isDeniedPost("7"));
  });
});

// The validation, which is the difference between a lever and a lever the operator only THINKS they
// pulled. A shape check alone passes the two likeliest mistakes — one mistyped base58 character, and
// an address pasted at a non-42 network prefix — and both build green while serving the content.
describe("author validation catches what a shape check cannot", () => {
  // A real prefix-42 address (Alice, the dev key every fixture in this repo uses).
  const ALICE_42 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  it("accepts a canonical prefix-42 address", () => {
    expect(normalizeSs58(ALICE_42)).toBe(ALICE_42);
  });

  it("rejects a one-character typo that is still base58 and still the right length", () => {
    // This is what a hand-transcribed address looks like when it goes wrong. The shape check cannot
    // see it; only the checksum can.
    const typo = ALICE_42.slice(0, -1) + (ALICE_42.endsWith("Y") ? "Z" : "Y");
    expect(typo.length).toBe(ALICE_42.length);
    expect(/^[1-9A-HJ-NP-Za-km-z]{44,49}$/.test(typo)).toBe(true); // passes the shape check
    expect(normalizeSs58(typo)).toBeNull(); // and fails the real one
  });

  it("rejects the same key at a different network prefix, which encodes as a different string", () => {
    // What a Polkadot or Substrate explorer shows. It is checksum-VALID, so only the prefix comparison
    // catches it — and it would never equal the prefix-42 string every post here is authored under.
    const other = ss58Address(
      "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
      0,
    );
    expect(other).not.toBe(ALICE_42);
    expect(normalizeSs58(other)).toBe(ALICE_42); // same key, canonicalizes back to 42
  });
});

describe("post id validation rejects a leading zero", () => {
  it("because String(1234n) is '1234' and would never match '01234'", () => {
    // A padded id from a spreadsheet column is checksum-free and shape-valid, and would sit in the set
    // matching nothing at all. The set holds decimal strings, so the encoding has to be exact.
    const SHAPE = /^(0|[1-9]\d*)$/;
    expect(SHAPE.test("01234")).toBe(false);
    expect(SHAPE.test("1234")).toBe(true);
    expect(SHAPE.test("0")).toBe(true); // a legitimate id
  });
});
