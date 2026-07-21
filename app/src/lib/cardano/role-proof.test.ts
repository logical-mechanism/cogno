import { describe, it, expect } from "vitest";
import { deriveRoleCredential } from "./role-proof";

// deriveRoleCredential is the pure, MeshJS-free half of the role-proof flow (blakejs only): it turns an
// operator's entered Calidus key into the 28-byte credential the synthetic address commits. A bug here
// silently mis-derives the address → an on-chain AddressKeyMismatch, so pin its behaviour. (The full
// COSE pre-flight needs a real cardano-signer fixture — that lands with Task 3.)

// A 32-byte Ed25519 verification key (arbitrary but fixed) and its equivalent encodings.
const PUBKEY = "1122334455667788990011223344556677889900112233445566778899001122";
const CBORHEX = `5820${PUBKEY}`; // CBOR bstr(32) header + the key
const VKEY_JSON = JSON.stringify({ type: "CalidusVKey", description: "", cborHex: CBORHEX });
// A bare 28-byte (56-hex) key hash / credential.
const KEYHASH = "0123456789abcdef0123456789abcdef0123456789abcdef01234567";

describe("deriveRoleCredential", () => {
  it("hashes a 32-byte verification key to a 28-byte (56-hex) credential", () => {
    const { credentialHex, fromKeyHash } = deriveRoleCredential(PUBKEY);
    expect(credentialHex).toMatch(/^[0-9a-f]{56}$/);
    expect(fromKeyHash).toBe(false);
  });

  it("derives the SAME credential from the raw key, its 0x form, its cborHex, and a .vkey JSON", () => {
    const fromRaw = deriveRoleCredential(PUBKEY).credentialHex;
    expect(deriveRoleCredential(`0x${PUBKEY}`).credentialHex).toBe(fromRaw);
    expect(deriveRoleCredential(CBORHEX).credentialHex).toBe(fromRaw);
    expect(deriveRoleCredential(VKEY_JSON).credentialHex).toBe(fromRaw);
  });

  it("passes a bare 28-byte key hash through unchanged (fromKeyHash)", () => {
    const { credentialHex, fromKeyHash } = deriveRoleCredential(KEYHASH);
    expect(credentialHex).toBe(KEYHASH);
    expect(fromKeyHash).toBe(true);
    // a 0x prefix and mixed case normalize to the same bare lowercase hash
    expect(deriveRoleCredential(`0x${KEYHASH.toUpperCase()}`).credentialHex).toBe(KEYHASH);
  });

  it("is deterministic", () => {
    expect(deriveRoleCredential(PUBKEY).credentialHex).toBe(deriveRoleCredential(PUBKEY).credentialHex);
  });

  it("rejects empty / non-hex / wrong-length input", () => {
    expect(() => deriveRoleCredential("")).toThrow();
    expect(() => deriveRoleCredential("   ")).toThrow();
    expect(() => deriveRoleCredential("nothex!!")).toThrow();
    expect(() => deriveRoleCredential("abcd")).toThrow(); // 2 bytes — neither a key nor a hash
    expect(() => deriveRoleCredential("aa".repeat(20))).toThrow(); // 20 bytes
  });
});
