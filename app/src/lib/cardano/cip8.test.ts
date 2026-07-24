// Pure-logic tests for the D1 CIP-8 bind-proof producer. The bind makes the user's Cardano wallet sign
// exactly ONE payload that the client builds IN-BROWSER — committing MY posting account + THIS chain's
// genesis + a fresh nonce — and that proof is then submitted directly on-chain (no follower). The client
// refuses to sign a malformed commitment, a script/vault signing address, or with a 64-byte extended key.
// We mock MeshJS so the defense logic runs in isolation.

import { describe, it, expect, vi, beforeEach } from "vitest";

// A testnet vkey reward address: header 0xe0 (type 0b1110) + 28-byte stake credential = 29 bytes / 58 hex.
const STAKE_CRED = "c1".repeat(28);
const VKEY_REWARD_RAW = `e0${STAKE_CRED}`; // 0xe0 >> 4 = 0b1110 (vkey stake)

const fake = {
  changeAddress: "addr_test_vkey",
  paymentType: 0 as number,
  networkId: 0 as number, // 0 = preprod (accepted); 1 = mainnet (rejected before signing)
  vkHex: "11".repeat(32), // 32-byte vkey (accepted); "22".repeat(64) => extended (rejected)
  vkThrows: false,
  signature: "sigsig" as string,
  key: "cose-key" as string,
  signDataCalls: [] as string[],
  signDataAddrs: [] as string[],
  rewardAddresses: ["stake_test_reward"] as string[],
  rewardRaw: VKEY_REWARD_RAW as string, // bech32→bytes hex for the reward address (header + stake cred)
};

vi.mock("@meshsdk/core", () => ({
  BrowserWallet: {
    enable: vi.fn(async () => ({
      getNetworkId: async () => fake.networkId,
      getChangeAddress: async () => fake.changeAddress,
      getRewardAddresses: async () => fake.rewardAddresses,
      signData: async (message: string, addr?: string) => {
        fake.signDataCalls.push(message);
        if (addr !== undefined) fake.signDataAddrs.push(addr);
        return { signature: fake.signature, key: fake.key };
      },
    })),
  },
}));

vi.mock("@meshsdk/core-cst", () => ({
  Address: {
    fromBech32: () => ({
      getProps: () => ({ paymentPart: { type: fake.paymentType, hash: "ph" } }),
      toBytes: () => ({ toString: () => fake.rewardRaw }),
    }),
  },
  getPublicKeyFromCoseKey: () => {
    if (fake.vkThrows) throw new Error("recovery shape varied");
    return fake.vkHex;
  },
}));

import { produceBindProof, produceBindProofStake } from "./cip8";

const DOMAIN = "cogno-chain/bind/v1";
const ACCOUNT = "ab".repeat(32); // 64-hex sr25519 pubkey
const GENESIS = "cd".repeat(32); // 64-hex block-0 hash

beforeEach(() => {
  fake.changeAddress = "addr_test_vkey";
  fake.paymentType = 0;
  fake.networkId = 0;
  fake.vkHex = "11".repeat(32);
  fake.vkThrows = false;
  fake.signature = "sigsig";
  fake.key = "cose-key";
  fake.signDataCalls = [];
  fake.signDataAddrs = [];
  fake.rewardAddresses = ["stake_test_reward"];
  fake.rewardRaw = VKEY_REWARD_RAW;
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
    expect(res.error).toMatch(/account key looks malformed/i);
    expect(fake.signDataCalls).toHaveLength(0); // NEVER signed
  });

  it("rejects a non-32-byte genesis hex", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await produceBindProof({ walletId: "eternl", sr25519PubkeyHex: ACCOUNT, genesisHex: "0xnotahash" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/malformed reply from the network/i);
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
    expect(res.error).toMatch(/signature exceeds the size/i);
  });
});

describe("produceBindProofStake — happy path (voting-power bind)", () => {
  it("signs over the REWARD address with the stake key and returns the proven 28-byte stake credential", async () => {
    const res = await produceBindProofStake({ walletId: "eternl", sr25519PubkeyHex: `0x${ACCOUNT}`, genesisHex: `0x${GENESIS}` });
    expect(res.ok).toBe(true);
    expect(res.coseSign1).toBe("sigsig");
    expect(res.coseKey).toBe("cose-key");
    // The signature is taken over the wallet's REWARD address (⇒ signed with the stake key).
    expect(res.signingAddress).toBe("stake_test_reward");
    expect(fake.signDataAddrs).toEqual(["stake_test_reward"]);
    // The stake credential is the 28 bytes AFTER the 1-byte header (vkey reward).
    expect(res.stakeCredentialHex).toBe(STAKE_CRED);
    // It signed exactly ONE payload, the pinned grammar committing my account + genesis + a 32-hex nonce.
    expect(fake.signDataCalls).toHaveLength(1);
    expect(fake.signDataCalls[0]).toMatch(
      new RegExp(`^${DOMAIN};genesis=${GENESIS};account=${ACCOUNT};nonce=[0-9a-f]{32}$`),
    );
  });
});

describe("produceBindProofStake — reward-address defense (refuse before signing)", () => {
  it("rejects a wallet that exposes no reward address (no stake key to prove)", async () => {
    fake.rewardAddresses = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await produceBindProofStake({ walletId: "nami", sr25519PubkeyHex: ACCOUNT, genesisHex: GENESIS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no reward address/i);
    expect(fake.signDataCalls).toHaveLength(0); // NEVER signed
  });

  it("rejects a SCRIPT-stake reward address (header 0b1111) — only vkey stake keys can bind", async () => {
    fake.rewardRaw = `f0${STAKE_CRED}`; // 0xf0 >> 4 = 0b1111 (script stake)
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await produceBindProofStake({ walletId: "eternl", sr25519PubkeyHex: ACCOUNT, genesisHex: GENESIS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/script stake keys can't be linked/i);
    expect(fake.signDataCalls).toHaveLength(0);
  });

  it("rejects a malformed (non-29-byte) reward address shape", async () => {
    fake.rewardRaw = "e0dead"; // far too short to be a 29-byte reward address
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await produceBindProofStake({ walletId: "eternl", sr25519PubkeyHex: ACCOUNT, genesisHex: GENESIS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/couldn't read this wallet's reward address/i);
    expect(fake.signDataCalls).toHaveLength(0);
  });

  it("rejects a non-32-byte account hex before touching the wallet", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await produceBindProofStake({ walletId: "eternl", sr25519PubkeyHex: "deadbeef", genesisHex: GENESIS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/account key looks malformed/i);
    expect(fake.signDataCalls).toHaveLength(0);
  });
});

describe("produceBindProofStake — key + size defense", () => {
  it("rejects a 64-byte extended verification key", async () => {
    fake.vkHex = "22".repeat(64);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await produceBindProofStake({ walletId: "eternl", sr25519PubkeyHex: ACCOUNT, genesisHex: GENESIS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/extended key/i);
  });

  it("rejects a COSE signature over the 512-byte on-chain bound", async () => {
    fake.signature = "ab".repeat(513);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await produceBindProofStake({ walletId: "eternl", sr25519PubkeyHex: ACCOUNT, genesisHex: GENESIS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/signature exceeds the size/i);
  });
});
