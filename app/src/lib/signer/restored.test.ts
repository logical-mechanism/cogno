// signerFromRestored — the seedless signer a page refresh comes back as.
//
// What has to be true for the whole restore to be safe:
//   1. It carries the REAL public key and ss58, so every read, every ss58-keyed device store, and
//      every tx PAPI builds around `signer.publicKey` is for the right account.
//   2. It holds NO secret and cannot produce a signature on its own — the seed arrives only via
//      `unlock`, which is what makes the wallet prompt appear at the moment of write intent.
//   3. `unlock` is called LAZILY. Building the signer must not prompt; only signing may.

import { describe, it, expect, vi } from "vitest";
import { signerFromRestored, signerFromSeed } from "./index";
import type { PostingSigner } from "@/lib/types";

/** A real derived signer, standing in for what `unlock()` returns after the wallet signs. */
const realSigner = (): PostingSigner => signerFromSeed(new Uint8Array(32).fill(7));

const REC = { ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", publicKeyHex: "0x" + "11".repeat(32) };

describe("signerFromRestored", () => {
  it("carries the real identity and is labelled `restored`", () => {
    const s = signerFromRestored(REC, async () => realSigner());
    expect(s.kind).toBe("restored");
    expect(s.ss58).toBe(REC.ss58);
    expect(s.publicKeyHex).toBe(REC.publicKeyHex);
  });

  it("exposes the public key as bytes — this is what PAPI builds and encodes a tx around", () => {
    const s = signerFromRestored(REC, async () => realSigner());
    expect(s.signer.publicKey).toBeInstanceOf(Uint8Array);
    expect(s.signer.publicKey).toHaveLength(32);
    expect(s.signer.publicKey.every((b) => b === 0x11)).toBe(true);
  });

  it("does NOT unlock at construction — building a session must never open a wallet prompt", () => {
    const unlock = vi.fn(async () => realSigner());
    signerFromRestored(REC, unlock);
    expect(unlock).not.toHaveBeenCalled();
  });

  it("unlocks on signBytes and delegates to the derived key", async () => {
    // Assert DELEGATION, not signature equality: sr25519 (Schnorrkel) signing is randomized, so
    // signing the same bytes twice legitimately yields two different signatures.
    const signBytes = vi.fn(async () => new Uint8Array([0xbb]));
    const delegate = { ...realSigner(), signer: { ...realSigner().signer, signBytes } };
    const unlock = vi.fn(async () => delegate);
    const s = signerFromRestored(REC, unlock);

    const data = new Uint8Array([1, 2, 3]);
    expect(await s.signer.signBytes(data)).toEqual(new Uint8Array([0xbb]));
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(signBytes).toHaveBeenCalledWith(data);
  });

  it("unlocks on signTx and hands the delegate every argument verbatim", async () => {
    const signTx = vi.fn(async () => new Uint8Array([0xaa]));
    const delegate = { ...realSigner(), signer: { ...realSigner().signer, signTx } };
    const s = signerFromRestored(REC, async () => delegate);

    const callData = new Uint8Array([9]);
    const extensions = {};
    const metadata = new Uint8Array([8]);
    const out = await s.signer.signTx(callData, extensions, metadata, 42);

    expect(out).toEqual(new Uint8Array([0xaa]));
    expect(signTx).toHaveBeenCalledWith(callData, extensions, metadata, 42);
  });

  it("propagates a declined prompt, so the tx stream fails and the optimistic card rolls back", async () => {
    const s = signerFromRestored(REC, async () => {
      throw new Error("user declined");
    });
    await expect(s.signer.signTx(new Uint8Array(), {}, new Uint8Array(), 1)).rejects.toThrow(
      /declined/,
    );
  });

  it("holds no secret: nothing on it can sign without calling unlock", async () => {
    // The only way to a signature is through the injected unlock. If someone ever "helpfully" caches a
    // seed on the returned object, the never-unlock case below starts succeeding and this fails.
    const s = signerFromRestored(REC, async () => {
      throw new Error("no seed available");
    });
    await expect(s.signer.signBytes(new Uint8Array([1]))).rejects.toThrow();
    expect(JSON.stringify(s)).not.toContain("seed");
  });
});
