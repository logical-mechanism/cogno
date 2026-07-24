// The restored-session record is the one thing this feature writes to disk, so what it ACCEPTS back off
// disk is its security-relevant surface. Whatever `parseRestoredSession` returns is fed to
// `signerFromRestored` (where `publicKeyHex` reaches `fromHex`) and used to bucket every device-local
// store — bookmarks, mutes, blocks, hidden posts, notification read-state. A truncated, hand-edited or
// wrong-typed record must therefore degrade to "no session", never to a half-built signer keyed on the
// string "undefined".

import { describe, it, expect } from "vitest";
import { parseRestoredSession, type RestoredSession } from "./sessionRestore";

const VALID: RestoredSession = {
  walletId: "eternl",
  ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  publicKeyHex: "0x" + "11".repeat(32),
  walletAddress: "addr_test1qq",
  walletAddressHex: "00deadbeef",
};

const raw = (o: unknown) => JSON.stringify(o);

describe("parseRestoredSession — accepts", () => {
  it("a complete record, unchanged", () => {
    expect(parseRestoredSession(raw(VALID))).toEqual(VALID);
  });

  it("and lowercases walletAddressHex, so hex case can never look like an account switch", () => {
    // A raw CIP-30 getChangeAddress() is what the no-popup probe compares against, and wallets differ
    // on hex case. Without normalising, a case-mismatched record would read as "different account" and
    // sign the user out on every load.
    const got = parseRestoredSession(raw({ ...VALID, walletAddressHex: "00DEADBEEF" }));
    expect(got?.walletAddressHex).toBe("00deadbeef");
  });

  it("ignores unknown extra fields rather than failing on them (forward-compatible)", () => {
    const got = parseRestoredSession(raw({ ...VALID, somethingNew: 1 }));
    expect(got).toEqual(VALID);
  });
});

describe("parseRestoredSession — rejects (→ null, i.e. a guest session)", () => {
  it.each([
    ["nothing stored", null],
    ["not JSON", "{{{"],
    ["a bare string", '"a string"'],
    ["an array", "[]"],
    ["JSON null", "null"],
    ["a number", "42"],
  ])("%s", (_label, input) => {
    expect(parseRestoredSession(input)).toBeNull();
  });

  it.each(["walletId", "ss58", "publicKeyHex", "walletAddress", "walletAddressHex"])(
    "a record missing %s",
    (field) => {
      const partial: Record<string, unknown> = { ...VALID };
      delete partial[field];
      expect(parseRestoredSession(raw(partial))).toBeNull();
    },
  );

  it("an empty ss58 or walletId — a blank key would bucket every device store under one shared name", () => {
    expect(parseRestoredSession(raw({ ...VALID, ss58: "" }))).toBeNull();
    expect(parseRestoredSession(raw({ ...VALID, walletId: "" }))).toBeNull();
  });

  it("a public key that is not 0x-hex — it is handed straight to fromHex", () => {
    expect(parseRestoredSession(raw({ ...VALID, publicKeyHex: "11".repeat(32) }))).toBeNull();
    expect(parseRestoredSession(raw({ ...VALID, publicKeyHex: "" }))).toBeNull();
  });

  it("a wrong-typed field, rather than coercing it", () => {
    expect(parseRestoredSession(raw({ ...VALID, ss58: 42 }))).toBeNull();
    expect(parseRestoredSession(raw({ ...VALID, walletId: { id: "eternl" } }))).toBeNull();
    expect(parseRestoredSession(raw({ ...VALID, walletAddressHex: null }))).toBeNull();
  });
});

describe("the hard line: what may be persisted", () => {
  it("has exactly five fields, all public", () => {
    // Three are on-chain (the ss58 is the author of every post this account has written, and the URL of
    // its own profile page); the other two are one Cardano address in two encodings. NOTHING here can
    // sign. If anyone adds a sixth field, this fails and they have to say which category it is in —
    // the COSE_Sign1 signature and its blake2b_256 seed are never allowed near this record.
    expect(Object.keys(VALID).sort()).toEqual([
      "publicKeyHex",
      "ss58",
      "walletAddress",
      "walletAddressHex",
      "walletId",
    ]);
    const parsed = parseRestoredSession(raw(VALID))!;
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(VALID).sort());
  });

  it("drops a record carrying a signature-shaped field instead of round-tripping it", () => {
    const got = parseRestoredSession(raw({ ...VALID, seed: "0xdeadbeef", signature: "0xcafe" }));
    expect(got).not.toHaveProperty("seed");
    expect(got).not.toHaveProperty("signature");
  });
});
