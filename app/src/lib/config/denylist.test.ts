// The shipped state of the operator serve lever, and the predicates every read path calls.
//
// The env-var PARSING is deliberately not tested here: `process.env.NEXT_PUBLIC_*` is inlined by Next
// at build time and read at module evaluation, so it cannot be varied per test without re-importing
// the module under a mutated env, which would test vitest's module graph rather than this code. What
// IS worth pinning is the shipped state (empty, so the whole mechanism is inert) and the predicates,
// which several read paths call directly and which must agree with each other.

import { describe, it, expect } from "vitest";
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
