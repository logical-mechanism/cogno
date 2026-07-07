import { describe, it, expect } from "vitest";
import { ss58Address, ss58Encode } from "@polkadot-labs/hdkd-helpers";
import { isPlausibleSs58, profileRouteForQuery, truncateSs58, handleOf } from "./ss58";

// A deterministic 32-byte AccountId32 (Alice's well-known public key), encoded at the chain prefix 42.
const ALICE_PK = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
const ALICE_42 = ss58Address(ALICE_PK, 42);

describe("truncateSs58 / handleOf", () => {
  it("middle-ellipsizes a long address and prefixes the handle", () => {
    expect(truncateSs58(ALICE_42)).toBe(`${ALICE_42.slice(0, 4)}…${ALICE_42.slice(-4)}`);
    expect(handleOf(ALICE_42)).toBe(`@${truncateSs58(ALICE_42)}`);
  });
});

describe("profileRouteForQuery", () => {
  it("returns the profile route for a valid AccountId32 address", () => {
    expect(profileRouteForQuery(ALICE_42)).toBe(`/u/${ALICE_42}/`);
  });

  it("trims surrounding whitespace before decoding", () => {
    expect(profileRouteForQuery(`  ${ALICE_42}  `)).toBe(`/u/${ALICE_42}/`);
  });

  it("normalizes a same-account address from another prefix to the chain prefix", () => {
    const alice0 = ss58Encode(ALICE_PK, 0); // same 32 bytes, Polkadot prefix 0
    expect(alice0).not.toBe(ALICE_42);
    expect(profileRouteForQuery(alice0)).toBe(`/u/${ALICE_42}/`);
  });

  it("rejects a partial / mistyped address (fails the checksum decode)", () => {
    expect(profileRouteForQuery(ALICE_42.slice(0, ALICE_42.length - 1))).toBeNull();
    expect(profileRouteForQuery(`${ALICE_42}x`)).toBeNull();
  });

  it("rejects free-text search terms, hashtags, and empty input", () => {
    expect(profileRouteForQuery("hello world")).toBeNull();
    expect(profileRouteForQuery("#cardano")).toBeNull();
    expect(profileRouteForQuery("")).toBeNull();
    expect(profileRouteForQuery("   ")).toBeNull();
    expect(profileRouteForQuery(null)).toBeNull();
    expect(profileRouteForQuery(undefined)).toBeNull();
  });

  it("agrees with isPlausibleSs58 on the happy path but is strictly tighter", () => {
    // A base58 string that passes the loose length regex but is not a valid checksum.
    const bogus = "5".repeat(48);
    expect(isPlausibleSs58(bogus)).toBe(true);
    expect(profileRouteForQuery(bogus)).toBeNull();
  });
});
