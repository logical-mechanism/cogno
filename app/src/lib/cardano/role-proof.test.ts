import { describe, it, expect } from "vitest";
import { bech32 } from "bech32";
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
    const { credentialHex, fromKeyHash } = deriveRoleCredential(PUBKEY, "spo");
    expect(credentialHex).toMatch(/^[0-9a-f]{56}$/);
    expect(fromKeyHash).toBe(false);
  });

  it("derives the SAME credential from the raw key, its 0x form, its cborHex, and a .vkey JSON", () => {
    const fromRaw = deriveRoleCredential(PUBKEY, "spo").credentialHex;
    expect(deriveRoleCredential(`0x${PUBKEY}`, "spo").credentialHex).toBe(fromRaw);
    expect(deriveRoleCredential(CBORHEX, "spo").credentialHex).toBe(fromRaw);
    expect(deriveRoleCredential(VKEY_JSON, "spo").credentialHex).toBe(fromRaw);
  });

  it("passes a bare 28-byte key hash through unchanged (fromKeyHash)", () => {
    const { credentialHex, fromKeyHash } = deriveRoleCredential(KEYHASH, "spo");
    expect(credentialHex).toBe(KEYHASH);
    expect(fromKeyHash).toBe(true);
    // a 0x prefix and mixed case normalize to the same bare lowercase hash
    expect(deriveRoleCredential(`0x${KEYHASH.toUpperCase()}`, "spo").credentialHex).toBe(KEYHASH);
  });

  it("is deterministic", () => {
    expect(deriveRoleCredential(PUBKEY, "spo").credentialHex).toBe(
      deriveRoleCredential(PUBKEY, "spo").credentialHex,
    );
  });

  it("rejects empty / non-hex / wrong-length input", () => {
    expect(() => deriveRoleCredential("", "spo")).toThrow();
    expect(() => deriveRoleCredential("   ", "spo")).toThrow();
    expect(() => deriveRoleCredential("nothex!!", "spo")).toThrow();
    expect(() => deriveRoleCredential("abcd", "spo")).toThrow(); // 2 bytes — neither a key nor a hash
    expect(() => deriveRoleCredential("aa".repeat(20), "spo")).toThrow(); // 20 bytes
  });

  it("names the role in the error copy (dRep card must not say Calidus)", () => {
    expect(() => deriveRoleCredential("nothex!!", "drep")).toThrow(/dRep/);
    expect(() => deriveRoleCredential("nothex!!", "spo")).toThrow(/Calidus/);
  });
});

describe("deriveRoleCredential — bech32 (wallet-facing) forms", () => {
  // The exact CIP-129 dRep id an Eternl user pastes (header 0x22 = key-based dRep + its 28-byte credential).
  const DREP_ID = "drep1ytah77nvma8thq037ynn9sqf59rpsjfpnq2a0rtltfnyvjchvqhux";
  const DREP_CRED = "fb7f7a6cdf4ebb81f1f12732c009a1461849219815d78d7f5a66464b";

  it("decodes a CIP-129 drep1… id to its 28-byte credential (fromKeyHash)", () => {
    const { credentialHex, fromKeyHash } = deriveRoleCredential(DREP_ID, "drep");
    expect(credentialHex).toBe(DREP_CRED);
    expect(fromKeyHash).toBe(true);
  });

  it("tolerates surrounding whitespace on a pasted id", () => {
    expect(deriveRoleCredential(`  ${DREP_ID}\n`, "drep").credentialHex).toBe(DREP_CRED);
  });

  it("rejects a foreign HRP pasted into the wrong field (an addr/pool/stake key)", () => {
    // A valid-checksum bech32 with a foreign HRP (a 29-byte stake-cred shape): right length, wrong thing —
    // must be NAMED, not silently mis-derived into the payment credential. Built via the lib so it's valid.
    const stakeLike = bech32.encode(
      "stake",
      bech32.toWords(Uint8Array.from(`e1${DREP_CRED}`.match(/../g)!.map((b) => parseInt(b, 16)))),
      128,
    );
    expect(() => deriveRoleCredential(stakeLike, "drep")).toThrow(/not a dRep key/);
  });

  it("rejects a drep1… pasted into the SPO (Calidus) field", () => {
    expect(() => deriveRoleCredential(DREP_ID, "spo")).toThrow(/not a Calidus key/);
  });
});
