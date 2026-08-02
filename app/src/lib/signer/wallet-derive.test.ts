// Pure-logic tests for the sign-to-derive path: a Cardano wallet's deterministic CIP-8 signature
// becomes the sr25519 posting key with NOTHING stored. We mock ONLY the browser-only MeshJS
// surface (BrowserWallet + Address) and feed a FIXED signature hex, so the test is deterministic.
// The real blakejs + real @polkadot-labs/hdkd run underneath — that is the point: same signature
// in => same blake2b-256 seed => same sr25519 keypair out.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { seedCardanoNetwork } from "@/lib/cardano/network.fixture";

// ── mock the browser-only MeshJS deps the module dynamically imports ─────────────────────────────
// A controllable fake wallet: tests set the change address + the signature it returns.
const fake = {
  changeAddress: "addr_test_vkey",
  // The SAME address in CIP-30's raw hex form. Address.toBytes() returns a HexBlob (a branded string),
  // which is why the module stringifies it — the mock mirrors that.
  changeAddressHex: "00DEADBEEF",
  // paymentPart.type: 0 = vkey (accepted), 1 = script (rejected).
  paymentType: 0 as number,
  // 0 = preprod/testnet (accepted); 1 = mainnet (rejected before any derive).
  networkId: 0 as number,
  signature: "aa".repeat(32), // 32-byte COSE signature hex (deterministic stand-in)
  signDataCalls: [] as Array<{ message: string; address: string }>,
};

vi.mock("@meshsdk/core", () => ({
  BrowserWallet: {
    enable: vi.fn(async (_id: string) => ({
      getNetworkId: async () => fake.networkId,
      getChangeAddress: async () => fake.changeAddress,
      signData: async (message: string, address: string) => {
        fake.signDataCalls.push({ message, address });
        if (!fake.signature) return { signature: "", key: "kk" };
        return { signature: fake.signature, key: "cose-key-hex" };
      },
    })),
  },
}));

vi.mock("@meshsdk/core-cst", () => ({
  Address: {
    fromBech32: (_a: string) => ({
      getProps: () => ({ paymentPart: { type: fake.paymentType, hash: "ph" } }),
      toBytes: () => fake.changeAddressHex,
    }),
  },
}));

import { deriveSignerFromWallet, DERIVE_MESSAGE } from "./wallet-derive";

beforeEach(async () => {
  fake.changeAddress = "addr_test_vkey";
  fake.changeAddressHex = "00DEADBEEF";
  fake.paymentType = 0;
  fake.networkId = 0;
  fake.signature = "aa".repeat(32);
  fake.signDataCalls = [];
  await seedCardanoNetwork(0);
});

describe("deriveSignerFromWallet — determinism (no storage)", () => {
  it("derives a stable sr25519 keypair from a fixed signature", async () => {
    const a = await deriveSignerFromWallet("eternl");
    expect(a.signer.kind).toBe("derived");
    expect(a.signer.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.signingAddress).toBe("addr_test_vkey");
    // The hex encoding is what the no-popup restore probe compares against (a raw CIP-30
    // `getChangeAddress()` returns hex, not bech32), and wallets differ on hex case — so it must come
    // back lowercased or every restore would look like an account switch.
    expect(a.signingAddressHex).toBe("00deadbeef");
  });

  it("SAME signature => SAME posting key (the 'derive each session, store nothing' claim)", async () => {
    const a = await deriveSignerFromWallet("eternl");
    const b = await deriveSignerFromWallet("eternl");
    expect(b.signer.publicKeyHex).toBe(a.signer.publicKeyHex);
    expect(b.signer.ss58).toBe(a.signer.ss58);
  });

  it("DIFFERENT signature => DIFFERENT posting key (the seed is the signature hash)", async () => {
    const a = await deriveSignerFromWallet("eternl");
    fake.signature = "bb".repeat(32); // a different wallet/signature
    const b = await deriveSignerFromWallet("eternl");
    expect(b.signer.publicKeyHex).not.toBe(a.signer.publicKeyHex);
  });

  it("signs the PINNED derive message verbatim (changing it would re-key everyone)", async () => {
    await deriveSignerFromWallet("eternl");
    expect(fake.signDataCalls).toHaveLength(1);
    expect(fake.signDataCalls[0].message).toBe(DERIVE_MESSAGE);
    expect(fake.signDataCalls[0].address).toBe("addr_test_vkey");
  });
});

// The message BYTES, pinned as a literal.
//
// The assertion above compares what was signed against `DERIVE_MESSAGE` — which is the right check
// for "the module signs the constant and not something it built on the fly", but it is a comparison
// with itself: edit the constant and it still passes, in both places, together. Nothing in the repo
// noticed if these bytes moved, and they are the highest-consequence bytes in the frontend.
//
// The account is a pure function of the wallet's signature over this exact string, so a single
// changed character silently mints a DIFFERENT account for every existing user. Their real account
// is still on chain and still bound 1:1 to their Cardano identity; `CognoGate::revoke` is
// committee-only and writes a permanent tombstone, so there is no path back and no way to re-bind.
// A user would simply arrive one day as a stranger with no posts, no follows and no posting power.
//
// docs/TRUSTLESS-IDENTITY.md specifies this normatively for third-party clients. If you change
// anything here, that document is wrong too — and every other client is now minting foreign accounts.
describe("DERIVE_MESSAGE is pinned forever", () => {
  it("is byte-for-byte what every existing account was derived from", () => {
    expect(DERIVE_MESSAGE).toBe(
      "cogno-chain · derive my posting key (v1). Signing this unlocks your posting identity on this " +
        "device; the signature never leaves it. Do NOT sign this exact message in any other app.",
    );
  });

  it("carries the separator as U+00B7 MIDDLE DOT, not a hyphen or a bullet", () => {
    // The character most likely to be silently "corrected" by an editor, a linter, or a round trip
    // through something that normalizes punctuation. It is 2 bytes in UTF-8, so a swap for an ASCII
    // hyphen changes the byte length as well as the content.
    expect(DERIVE_MESSAGE).toContain("·");
    expect(DERIVE_MESSAGE.startsWith("cogno-chain · derive")).toBe(true);
    // U+00B7 is the ONLY non-ASCII character in the string, so its presence is exactly one extra
    // UTF-8 byte over the code-unit count. Swapping it for an ASCII hyphen collapses them.
    expect(new TextEncoder().encode(DERIVE_MESSAGE)).toHaveLength(DERIVE_MESSAGE.length + 1);
  });

  it("still tells the user not to sign it anywhere else", () => {
    // Not cosmetic, and not a nice-to-have. The derived key CANNOT be rotated — there is no nonce, so
    // re-deriving returns the same key — which makes this sentence, displayed by the wallet, the
    // entire mitigation for a phished signature. Dropping it to shorten the prompt removes the only
    // defence there is.
    expect(DERIVE_MESSAGE).toContain("Do NOT sign this exact message in any other app");
  });
});

describe("deriveSignerFromWallet — defensive rejections (with logging)", () => {
  it("rejects a wrong-network (mainnet) wallet BEFORE deriving, so no key is minted and no sign is asked", async () => {
    fake.networkId = 1; // mainnet
    await expect(deriveSignerFromWallet("eternl")).rejects.toThrow(/wrong network|preprod/i);
    expect(fake.signDataCalls).toHaveLength(0);
  });

  it("rejects a script/vault payment credential (type !== 0) and logs the credential type", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.paymentType = 1; // script
    await expect(deriveSignerFromWallet("eternl")).rejects.toThrow(/script\/vault/i);
    // It must NOT have asked the wallet to sign once it saw a non-vkey address.
    expect(fake.signDataCalls).toHaveLength(0);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0].join(" ")).toContain("eternl");
    spy.mockRestore();
  });

  it("rejects a wallet that returns no signature and logs it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.signature = ""; // wallet refused
    await expect(deriveSignerFromWallet("lace")).rejects.toThrow(/did not return a signature/i);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0].join(" ")).toContain("lace");
    spy.mockRestore();
  });
});
