// Pure-logic tests for the D1 CIP-8 bind-proof producer. The bind makes the user's Cardano wallet sign
// exactly ONE payload that the client builds IN-BROWSER — committing MY posting account + THIS chain's
// genesis + a fresh nonce — and that proof is then submitted directly on-chain (no follower). The client
// refuses to sign a malformed commitment, a script/vault signing address, or with a 64-byte extended key.
// We mock MeshJS so the defense logic runs in isolation.

import { describe, it, expect, vi, beforeEach } from "vitest";

const fake = {
  changeAddress: "addr_test_vkey",
  paymentType: 0 as number,
  vkHex: "11".repeat(32), // 32-byte vkey (accepted); "22".repeat(64) => extended (rejected)
  vkThrows: false,
  signature: "sigsig" as string,
  key: "cose-key" as string,
  signDataCalls: [] as string[],
};

vi.mock("@meshsdk/core", () => ({
  BrowserWallet: {
    enable: vi.fn(async () => ({
      getChangeAddress: async () => fake.changeAddress,
      signData: async (message: string) => {
        fake.signDataCalls.push(message);
        return { signature: fake.signature, key: fake.key };
      },
    })),
  },
}));

vi.mock("@meshsdk/core-cst", () => ({
  Address: {
    fromBech32: () => ({ getProps: () => ({ paymentPart: { type: fake.paymentType, hash: "ph" } }) }),
  },
  getPublicKeyFromCoseKey: () => {
    if (fake.vkThrows) throw new Error("recovery shape varied");
    return fake.vkHex;
  },
}));

import { produceBindProof } from "./cip8";

const DOMAIN = "cogno-chain/bind/v1";
const ACCOUNT = "ab".repeat(32); // 64-hex sr25519 pubkey
const GENESIS = "cd".repeat(32); // 64-hex block-0 hash

beforeEach(() => {
  fake.changeAddress = "addr_test_vkey";
  fake.paymentType = 0;
  fake.vkHex = "11".repeat(32);
  fake.vkThrows = false;
  fake.signature = "sigsig";
  fake.key = "cose-key";
  fake.signDataCalls = [];
  vi.restoreAllMocks();
});

describe("produceBindProof — happy path", () => {
  it("signs the in-browser payload committing my account + genesis, and returns the COSE blobs", async () => {
    const res = await produceBindProof({ walletId: "eternl", sr25519PubkeyHex: `0x${ACCOUNT}`, genesisHex: `0x${GENESIS}` });
    expect(res.ok).toBe(true);
    expect(res.coseSign1).toBe("sigsig");
    expect(res.coseKey).toBe("cose-key");
    expect(res.signingAddress).toBe("addr_test_vkey");
    // It signed exactly ONE payload, with the pinned grammar committing my account + genesis + a 32-hex nonce.
    expect(fake.signDataCalls).toHaveLength(1);
    const payload = fake.signDataCalls[0];
    expect(payload).toMatch(
      new RegExp(`^${DOMAIN};genesis=${GENESIS};account=${ACCOUNT};nonce=[0-9a-f]{32}$`),
    );
  });

  it("lowercases + strips 0x from the account and genesis before committing them", async () => {
    const res = await produceBindProof({
      walletId: "eternl",
      sr25519PubkeyHex: `0x${ACCOUNT.toUpperCase()}`,
      genesisHex: GENESIS.toUpperCase(),
    });
    expect(res.ok).toBe(true);
    expect(fake.signDataCalls[0]).toContain(`account=${ACCOUNT}`);
    expect(fake.signDataCalls[0]).toContain(`genesis=${GENESIS}`);
  });

  it("generates a distinct random nonce each call (never a fixed value)", async () => {
    await produceBindProof({ walletId: "eternl", sr25519PubkeyHex: ACCOUNT, genesisHex: GENESIS });
    await produceBindProof({ walletId: "eternl", sr25519PubkeyHex: ACCOUNT, genesisHex: GENESIS });
    const n1 = fake.signDataCalls[0].match(/nonce=([0-9a-f]{32})/)?.[1];
    const n2 = fake.signDataCalls[1].match(/nonce=([0-9a-f]{32})/)?.[1];
    expect(n1).toBeDefined();
    expect(n1).not.toBe(n2);
  });
});

describe("produceBindProof — malformed commitment (refuse before signing)", () => {
  it("rejects a non-32-byte account hex", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await produceBindProof({ walletId: "eternl", sr25519PubkeyHex: "deadbeef", genesisHex: GENESIS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/32-byte hex pubkey/i);
    expect(fake.signDataCalls).toHaveLength(0); // NEVER signed
  });

  it("rejects a non-32-byte genesis hex", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await produceBindProof({ walletId: "eternl", sr25519PubkeyHex: ACCOUNT, genesisHex: "0xnotahash" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/32-byte hex hash/i);
    expect(fake.signDataCalls).toHaveLength(0);
  });
});

describe("produceBindProof — address + key defense", () => {
  it("rejects a script/vault payment credential and logs it (never bind from a vault address)", async () => {
    fake.paymentType = 1; // script
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await produceBindProof({ walletId: "eternl", sr25519PubkeyHex: ACCOUNT, genesisHex: GENESIS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/script payment credential/i);
    expect(fake.signDataCalls).toHaveLength(0);
    expect(spy).toHaveBeenCalled();
  });

  it("rejects a 64-byte extended verification key (only 32-byte CIP-30 keys accepted)", async () => {
    fake.vkHex = "22".repeat(64); // 64-byte extended key
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await produceBindProof({ walletId: "eternl", sr25519PubkeyHex: ACCOUNT, genesisHex: GENESIS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/extended key/i);
  });

  it("tolerates a vkey-recovery quirk (lets the on-chain verifier be the authority) and still proves", async () => {
    fake.vkThrows = true; // recovery shape varied — must NOT block the proof
    const res = await produceBindProof({ walletId: "eternl", sr25519PubkeyHex: ACCOUNT, genesisHex: GENESIS });
    expect(res.ok).toBe(true);
    expect(res.coseSign1).toBe("sigsig");
  });

  it("rejects a COSE blob over the on-chain size bound (cose_sign1 > 512 bytes)", async () => {
    fake.signature = "ab".repeat(513); // 513 bytes > the 512-byte BoundedVec cap
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await produceBindProof({ walletId: "eternl", sr25519PubkeyHex: ACCOUNT, genesisHex: GENESIS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/512-byte on-chain bound/i);
  });
});
