import { describe, it, expect } from "vitest";
import { drepBech32 } from "./roleMeta";

// The dRep display name resolves through Blockfrost's /governance/dreps/{drep_id} endpoint, which requires
// the CIP-129 bech32 id (NOT the raw hex). This tiny local encoder replaces pulling in MeshJS, so pin it to
// a real vector: the pair Blockfrost itself returned for credential 743e34…6435f11.
const CRED = "743e345e716c2ae570bc9f3923c992dafc5523441b0d24f9d6435f11";
const DREP_ID = "drep1yf6rudz7w9kz4etshj0njg7fjtd0c4frgsds6f8e6ep47ygl6sw74";

describe("drepBech32", () => {
  it("encodes a key-based dRep credential to its CIP-129 bech32 id (validated vs Blockfrost)", () => {
    expect(drepBech32(CRED)).toBe(DREP_ID);
  });

  it("normalizes a 0x prefix + uppercase to the same id", () => {
    expect(drepBech32(`0x${CRED.toUpperCase()}`)).toBe(DREP_ID);
  });

  it("returns null for a non-28-byte input", () => {
    expect(drepBech32("abcd")).toBeNull();
    expect(drepBech32("")).toBeNull();
    expect(drepBech32("zz".repeat(28))).toBeNull(); // 56 chars but not hex
  });
});
