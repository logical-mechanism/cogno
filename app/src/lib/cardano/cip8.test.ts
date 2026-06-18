// Pure-logic tests for the CIP-8 bind payload defense. The bind makes the user's Cardano wallet
// sign exactly ONE follower-committed string; the client refuses to sign anything that isn't a v1
// bind committing MY account + THIS chain's genesis, refuses a script/vault signing address, and
// rejects a 64-byte extended key. We mock MeshJS + fetch so the defense logic runs in isolation.

import { describe, it, expect, vi, beforeEach } from "vitest";

const fake = {
  changeAddress: "addr_test_vkey",
  paymentType: 0 as number,
  // The exact strings the follower returns for /nonce.
  nonceResponse: {} as Record<string, unknown>,
  // The verification key getPublicKeyFromCoseKey returns; "" => throw (recovery quirk).
  vkHex: "11".repeat(32), // 32-byte vkey (accepted)
  vkThrows: false,
  signDataCalls: [] as string[],
  bindBody: null as unknown,
};

vi.mock("@meshsdk/core", () => ({
  BrowserWallet: {
    enable: vi.fn(async () => ({
      getChangeAddress: async () => fake.changeAddress,
      signData: async (message: string) => {
        fake.signDataCalls.push(message);
        return { signature: "sigsig", key: "cose-key" };
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

import { bindIdentity } from "./cip8";

const FOLLOWER = "http://follower.test";
const DOMAIN = "cogno-chain/bind/v1";
const ACCOUNT = "abcdef0123456789"; // bare lowercase hex (the sr25519 pubkey)
const GENESIS = "0xgenesis";

// A correct follower payload that passes every defense check.
function goodPayload(account = ACCOUNT, genesis = GENESIS) {
  return `${DOMAIN};genesis=${genesis};account=${account};nonce=42`;
}

// Wire fetch: /nonce returns fake.nonceResponse; /bind returns { ok:true, identity_hash }.
function wireFetch(bindResponse: Record<string, unknown> = { ok: true, identity_hash: "0xhash" }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    if (String(url).includes("/nonce")) {
      return { ok: true, status: 200, json: async () => fake.nonceResponse };
    }
    if (String(url).includes("/bind")) {
      fake.bindBody = init?.body ? JSON.parse(String(init.body)) : null;
      return { ok: true, status: 200, json: async () => bindResponse };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as never);
}

beforeEach(() => {
  fake.changeAddress = "addr_test_vkey";
  fake.paymentType = 0;
  fake.nonceResponse = { payload: goodPayload(), genesis: GENESIS };
  fake.vkHex = "11".repeat(32);
  fake.vkThrows = false;
  fake.signDataCalls = [];
  fake.bindBody = null;
  vi.restoreAllMocks();
});

describe("bindIdentity — happy path", () => {
  it("signs the committed payload and returns the follower's identity hash", async () => {
    wireFetch();
    const res = await bindIdentity({ walletId: "eternl", sr25519PubkeyHex: `0x${ACCOUNT}`, followerUrl: FOLLOWER });
    expect(res.ok).toBe(true);
    expect(res.identityHash).toBe("0xhash");
    expect(res.signingAddress).toBe("addr_test_vkey");
    // It signed exactly the follower-committed payload, once.
    expect(fake.signDataCalls).toEqual([goodPayload()]);
    // The posted account is the lowercased, 0x-stripped pubkey.
    expect((fake.bindBody as { sr25519_pubkey: string }).sr25519_pubkey).toBe(ACCOUNT);
  });

  it("lowercases + strips the 0x prefix from the account before matching the payload", async () => {
    // A mixed-case hex with the canonical lowercase 0x prefix must normalize to the committed account.
    wireFetch();
    const res = await bindIdentity({ walletId: "eternl", sr25519PubkeyHex: `0x${ACCOUNT.toUpperCase()}`, followerUrl: FOLLOWER });
    expect(res.ok).toBe(true);
    expect((fake.bindBody as { sr25519_pubkey: string }).sr25519_pubkey).toBe(ACCOUNT);
  });
});

describe("bindIdentity — payload defense (refuse before signing)", () => {
  it("rejects a payload that does not start with the DOMAIN", async () => {
    fake.nonceResponse = { payload: `evil/bind/v9;genesis=${GENESIS};account=${ACCOUNT}`, genesis: GENESIS };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    wireFetch();
    const res = await bindIdentity({ walletId: "eternl", sr25519PubkeyHex: `0x${ACCOUNT}`, followerUrl: FOLLOWER });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unexpected payload/i);
    expect(fake.signDataCalls).toHaveLength(0); // NEVER signed
    expect(spy).toHaveBeenCalled();
  });

  it("rejects a payload committing a DIFFERENT account", async () => {
    fake.nonceResponse = { payload: goodPayload("deadbeefdeadbeef"), genesis: GENESIS };
    vi.spyOn(console, "error").mockImplementation(() => {});
    wireFetch();
    const res = await bindIdentity({ walletId: "eternl", sr25519PubkeyHex: `0x${ACCOUNT}`, followerUrl: FOLLOWER });
    expect(res.ok).toBe(false);
    expect(fake.signDataCalls).toHaveLength(0);
  });

  it("rejects a payload committing a DIFFERENT genesis", async () => {
    fake.nonceResponse = { payload: goodPayload(ACCOUNT, "0xWRONGCHAIN"), genesis: GENESIS };
    vi.spyOn(console, "error").mockImplementation(() => {});
    wireFetch();
    const res = await bindIdentity({ walletId: "eternl", sr25519PubkeyHex: `0x${ACCOUNT}`, followerUrl: FOLLOWER });
    expect(res.ok).toBe(false);
    expect(fake.signDataCalls).toHaveLength(0);
  });

  it("rejects a follower payload missing all the committed fields", async () => {
    fake.nonceResponse = { payload: "totally unrelated string", genesis: GENESIS };
    vi.spyOn(console, "error").mockImplementation(() => {});
    wireFetch();
    const res = await bindIdentity({ walletId: "eternl", sr25519PubkeyHex: `0x${ACCOUNT}`, followerUrl: FOLLOWER });
    expect(res.ok).toBe(false);
    expect(fake.signDataCalls).toHaveLength(0);
  });
});

describe("bindIdentity — address + key defense", () => {
  it("rejects a script/vault payment credential and logs it (never bind from a vault address)", async () => {
    fake.paymentType = 1; // script
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    wireFetch();
    const res = await bindIdentity({ walletId: "eternl", sr25519PubkeyHex: `0x${ACCOUNT}`, followerUrl: FOLLOWER });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/script payment credential/i);
    expect(fake.signDataCalls).toHaveLength(0);
    expect(spy).toHaveBeenCalled();
  });

  it("rejects a 64-byte extended verification key (only 32-byte CIP-30 keys accepted)", async () => {
    fake.vkHex = "22".repeat(64); // 64-byte extended key
    vi.spyOn(console, "error").mockImplementation(() => {});
    wireFetch();
    const res = await bindIdentity({ walletId: "eternl", sr25519PubkeyHex: `0x${ACCOUNT}`, followerUrl: FOLLOWER });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/extended key/i);
  });

  it("tolerates a vkey-recovery quirk (lets the follower be the authority) and still binds", async () => {
    fake.vkThrows = true; // recovery shape varied — must NOT block the bind
    wireFetch();
    const res = await bindIdentity({ walletId: "eternl", sr25519PubkeyHex: `0x${ACCOUNT}`, followerUrl: FOLLOWER });
    expect(res.ok).toBe(true);
    expect(res.identityHash).toBe("0xhash");
  });
});

describe("bindIdentity — follower rejection", () => {
  it("returns ok:false (and logs) when the follower rejects the bind", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    wireFetch({ ok: false, error: "signature did not verify" });
    const res = await bindIdentity({ walletId: "eternl", sr25519PubkeyHex: `0x${ACCOUNT}`, followerUrl: FOLLOWER });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/did not verify/i);
    expect(res.signingAddress).toBe("addr_test_vkey");
    expect(spy).toHaveBeenCalled();
  });
});
