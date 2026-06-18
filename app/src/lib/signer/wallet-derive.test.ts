// Pure-logic tests for the sign-to-derive path: a Cardano wallet's deterministic CIP-8 signature
// becomes the sr25519 posting key with NOTHING stored. We mock ONLY the browser-only MeshJS
// surface (BrowserWallet + Address) and feed a FIXED signature hex, so the test is deterministic.
// The real blakejs + real @polkadot-labs/hdkd run underneath — that is the point: same signature
// in => same blake2b-256 seed => same sr25519 keypair out.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mock the browser-only MeshJS deps the module dynamically imports ──────────────────────────
// A controllable fake wallet: tests set the change address + the signature it returns.
const fake = {
  changeAddress: "addr_test_vkey",
  // paymentPart.type: 0 = vkey (accepted), 1 = script (rejected).
  paymentType: 0 as number,
  signature: "aa".repeat(32), // 32-byte COSE signature hex (deterministic stand-in)
  signDataCalls: [] as Array<{ message: string; address: string }>,
};

vi.mock("@meshsdk/core", () => ({
  BrowserWallet: {
    enable: vi.fn(async (_id: string) => ({
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
    }),
  },
}));

import { deriveSignerFromWallet, DERIVE_MESSAGE } from "./wallet-derive";

beforeEach(() => {
  fake.changeAddress = "addr_test_vkey";
  fake.paymentType = 0;
  fake.signature = "aa".repeat(32);
  fake.signDataCalls = [];
});

describe("deriveSignerFromWallet — determinism (no storage)", () => {
  it("derives a stable sr25519 keypair from a fixed signature", async () => {
    const a = await deriveSignerFromWallet("eternl");
    expect(a.signer.kind).toBe("derived");
    expect(a.signer.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.signingAddress).toBe("addr_test_vkey");
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

describe("deriveSignerFromWallet — defensive rejections (with logging)", () => {
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
