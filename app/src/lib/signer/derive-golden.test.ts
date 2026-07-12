// Golden vectors for the sr25519 posting-key derivation.
//
// The posting key is DERIVED, never stored: seed = blake2b_256(the wallet's CIP-8 signature), then
// sr25519 on top (lib/signer/index.ts). So the derivation function IS the account. If a dependency
// bump ever changes how @polkadot-labs/hdkd turns a seed into a keypair, every existing user quietly
// lands on a different posting account — their posts, follows and bound identity all belong to an
// address they can no longer reach.
//
// wallet-derive.test.ts cannot catch that. It asserts derivation is self-consistent (same signature
// in => same key out), which stays true even if the whole function changes underneath. These vectors
// are the missing half: they pin the derivation to KNOWN addresses. //Alice is the canonical
// well-known dev account, so it also cross-checks the vectors against the wider Substrate ecosystem
// rather than against our own past output.
//
// If a bump makes this file fail, the bump re-keys users. That is not a test to update — it is a
// bump to reject.

import { describe, it, expect } from "vitest";
import { blake2b } from "blakejs";
import { getDevSigner, signerFromSeed } from "./index";

/** The product path: a fixed COSE_Sign1 signature -> blake2b_256 seed -> sr25519, exactly as wallet-derive.ts does it. */
function seedFromSignatureHex(hex: string): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  return blake2b(bytes, undefined, 32);
}

describe("sr25519 derivation — golden vectors (a bump that moves these re-keys every user)", () => {
  it("derives the pinned account from a fixed wallet signature", () => {
    const signer = signerFromSeed(seedFromSignatureHex("aa".repeat(32)));

    expect(signer.ss58).toBe("5CDrV6ENfvCvLfaxzmuEs7bj1GUsGbJLhVH4WHUYm7ta8MUU");
    expect(signer.publicKeyHex).toBe(
      "0x06fa40c2f135f8f8d0603152246ce2c0b251f466a1ba02cf79c710dfce0cd471",
    );
  });

  it("derives the pinned account from a second, different signature", () => {
    const signer = signerFromSeed(seedFromSignatureHex("bb".repeat(32)));

    expect(signer.ss58).toBe("5HK93uxFLmK3o6ZT6DuZVBbqHcTAxpGGuBgYunH1WFiDEZA2");
    expect(signer.publicKeyHex).toBe(
      "0xe82f69c002809a2fa80bd848dd599bb8575b684717f86784630e13a5a2ceae00",
    );
  });

  // The dev accounts go through the same hdkd derive, but via the standard dev mnemonic and a hard
  // path. These addresses are fixed by the ecosystem, not by us — if they drift, hdkd is broken, not
  // merely changed.
  it.each([
    ["//Alice", "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"],
    ["//Bob", "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"],
    ["//Charlie", "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y"],
  ])("derives the well-known dev account %s", (uri, ss58) => {
    expect(getDevSigner(uri).ss58).toBe(ss58);
  });
});
