import { describe, it, expect } from "vitest";
import { drepBech32, poolBech32, roleExplorerUrl } from "./roleMeta";
import { isBlankRoleId, mapObservedRolePairs } from "@/lib/chain/roles";

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

// The SPO "verify on-chain" link needs the CIP-5 bech32 pool id (`pool1…`) — plain bech32, hrp "pool",
// NO CIP-129 header byte. Pin it to real (hex → view) pairs read straight from db-sync's pool_hash table.
const POOL_HEX = "a57cbcb8ecdf24f469928da924b5bc6e4cbc3b57859577211a0daf6f";
const POOL_ID = "pool1547tew8vmuj0g6vj3k5jfddudextcw6hsk2hwgg6pkhk7lwphe6";
const POOL_HEX_2 = "f576ef654ff68f93b2554cce4d0691d4ce3b0a0e8742e5ba71a55b8b";
const POOL_ID_2 = "pool174mw7e20768e8vj4fn8y6p536n8rkzswsapwtwn354dckpjqzr8";

describe("poolBech32", () => {
  it("encodes a 28-byte pool hash to its CIP-5 bech32 id (validated vs db-sync pool_hash.view)", () => {
    expect(poolBech32(POOL_HEX)).toBe(POOL_ID);
    expect(poolBech32(POOL_HEX_2)).toBe(POOL_ID_2);
  });

  it("normalizes a 0x prefix + uppercase", () => {
    expect(poolBech32(`0x${POOL_HEX.toUpperCase()}`)).toBe(POOL_ID);
  });

  it("returns null for a non-28-byte input", () => {
    expect(poolBech32("abcd")).toBeNull();
    expect(poolBech32("zz".repeat(28))).toBeNull();
  });
});

describe("roleExplorerUrl", () => {
  it("builds a cexplorer pool URL for an SPO badge (default preprod network)", () => {
    expect(roleExplorerUrl("Spo", POOL_HEX)).toBe(`https://preprod.cexplorer.io/pool/${POOL_ID}`);
  });

  it("builds a cexplorer drep URL for a dRep badge", () => {
    expect(roleExplorerUrl("DRep", CRED)).toBe(`https://preprod.cexplorer.io/drep/${DREP_ID}`);
  });

  it("has no explorer page for a CC badge or a malformed id", () => {
    expect(roleExplorerUrl("Committee", POOL_HEX)).toBeNull();
    expect(roleExplorerUrl("Spo", "abcd")).toBeNull();
  });

  it("has no explorer page for a blank (Calidus) SPO id — it names no pool", () => {
    const BLANK = `0x${"0".repeat(56)}`;
    expect(roleExplorerUrl("Spo", BLANK)).toBeNull();
    expect(roleExplorerUrl("Spo", "0".repeat(56))).toBeNull();
  });
});

describe("isBlankRoleId", () => {
  it("is true only for an all-zero id (the Calidus 'no pool' marker)", () => {
    expect(isBlankRoleId(`0x${"0".repeat(56)}`)).toBe(true);
    expect(isBlankRoleId("0".repeat(56))).toBe(true);
    expect(isBlankRoleId("0x00")).toBe(true); // any all-zero hex
    expect(isBlankRoleId(`0x${POOL_HEX}`)).toBe(false); // a real pool id
    expect(isBlankRoleId(POOL_HEX)).toBe(false);
    expect(isBlankRoleId("")).toBe(false);
  });
});

describe("mapObservedRolePairs", () => {
  it("maps primitive (kind_index, id) pairs to ObservedRoleView, skipping unknown kinds", () => {
    expect(
      mapObservedRolePairs([
        [0, "0xaa"],
        [1, "0xbb"],
        [2, "0xcc"],
        [7, "0xdd"], // unknown kind index → skipped
      ]),
    ).toEqual([
      { kind: "Spo", id: "0xaa" },
      { kind: "DRep", id: "0xbb" },
      { kind: "Committee", id: "0xcc" },
    ]);
  });

  it("returns [] for empty / null input", () => {
    expect(mapObservedRolePairs([])).toEqual([]);
    expect(mapObservedRolePairs(undefined)).toEqual([]);
    expect(mapObservedRolePairs(null)).toEqual([]);
  });

  it("coerces a FixedSizeBinary-shaped id via asHex()", () => {
    const bin = { asHex: () => "0xdeadbeef" };
    expect(mapObservedRolePairs([[0, bin]])).toEqual([{ kind: "Spo", id: "0xdeadbeef" }]);
  });
});
