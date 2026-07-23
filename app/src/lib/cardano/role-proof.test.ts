import { describe, it, expect } from "vitest";
import { bech32 } from "bech32";
import { deriveRoleCredential, encodeDrepId, paymentCredFromAddress } from "./role-proof";

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

  it("encodeDrepId re-encodes a credential to the exact CIP-129 drep1… id (round-trips)", () => {
    // Used to hand a CIP-95 wallet a well-formed drep1… when the user pasted a non-bech32 form.
    expect(encodeDrepId(DREP_CRED)).toBe(DREP_ID);
    expect(encodeDrepId(`0x${DREP_CRED}`)).toBe(DREP_ID);
    expect(deriveRoleCredential(encodeDrepId(DREP_CRED), "drep").credentialHex).toBe(DREP_CRED);
  });

  it("encodeDrepId rejects a non-28-byte credential", () => {
    expect(() => encodeDrepId("abcd")).toThrow();
  });
});

describe("paymentCredFromAddress — the wallet pre-flight's runtime-mirror address check", () => {
  const CRED = "fb7f7a6cdf4ebb81f1f12732c009a1461849219815d78d7f5a66464b";
  const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  const STAKE = "00".repeat(28);

  it("accepts an enterprise vkey-payment address on the expected network (type-6, 29 bytes)", () => {
    // header 0x60 = enterprise(0b0110) + network 0. This is exactly the synthetic address the client builds.
    expect(paymentCredFromAddress(bytes(`60${CRED}`), 0)).toBe(CRED);
  });

  it("accepts a base vkey-payment address (type-0 / type-2, 57 bytes)", () => {
    expect(paymentCredFromAddress(bytes(`00${CRED}${STAKE}`), 0)).toBe(CRED); // vkey stake
    expect(paymentCredFromAddress(bytes(`20${CRED}${STAKE}`), 0)).toBe(CRED); // script stake
  });

  it("rejects the wrong network (mirrors the runtime's WrongNetwork)", () => {
    expect(paymentCredFromAddress(bytes(`61${CRED}`), 0)).toBeNull(); // enterprise on network 1
    expect(paymentCredFromAddress(bytes(`60${CRED}`), 1)).toBeNull(); // expected network 1
  });

  it("rejects script-payment, pointer, and reward/stake-only addresses (unsupported types)", () => {
    expect(paymentCredFromAddress(bytes(`70${CRED}`), 0)).toBeNull(); // enterprise SCRIPT payment
    expect(paymentCredFromAddress(bytes(`e0${CRED}`), 0)).toBeNull(); // reward (stake-only)
    expect(paymentCredFromAddress(bytes(`40${CRED}${STAKE}`), 0)).toBeNull(); // pointer/base-ish type 4
  });

  it("rejects a wrong-length body for the claimed type", () => {
    expect(paymentCredFromAddress(bytes(`60${CRED}00`), 0)).toBeNull(); // enterprise must be 29 bytes
    expect(paymentCredFromAddress(bytes(`00${CRED}`), 0)).toBeNull(); // base must be 57 bytes
    expect(paymentCredFromAddress(bytes("60"), 0)).toBeNull(); // too short
  });
});
