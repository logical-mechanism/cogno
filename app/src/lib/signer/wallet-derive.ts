// Sign-to-derive: turn a Cardano wallet into the sr25519 posting key, with NOTHING stored.
//
// The wallet signs ONE fixed, domain-separated string (CIP-8). The signature underneath is Ed25519,
// which is deterministic (RFC 8032) — so the same wallet always produces the same signature, hence
// the same sr25519 key. The signature stays in memory and is never published; only the derived
// PUBLIC key (the posting account) and the posts it signs are public. Re-derive each session by
// signing again — there is no key to back up, no password, no second wallet.
//
// SECURITY (honest, matching "usable ≠ trustless"): the derived key signs POSTS ONLY. It never
// controls funds — the ADA is the Cardano wallet's, which is never derived from anything. So the
// worst case if this signature were ever phished is impersonation (post as you → revoke + re-derive),
// never theft. The message below is shown by the wallet and warns the user not to sign it elsewhere.
//
// MeshJS is browser-only, so it is imported dynamically (this module is import-safe during SSG).
import { blake2b } from "blakejs";
import { signerFromSeed } from "@/lib/signer";
import type { PostingSigner } from "@/lib/types";

// PINNED FOREVER. Changing these exact bytes changes everyone's derived posting key. No nonce, no
// genesis — the key must be stable across sessions and chains; the per-chain anti-replay lives in
// the separate CIP-8 bind payload, not here.
export const DERIVE_MESSAGE =
  "cogno-chain · derive my posting key (v1). Signing this unlocks your posting identity on this " +
  "device; the signature never leaves it. Do NOT sign this exact message in any other app.";

export interface DerivedAccount {
  signer: PostingSigner;
  /** the wallet address the posting key was derived from (its identity/stake key). */
  signingAddress: string;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Enable the wallet, have it sign the fixed message, and derive the sr25519 posting signer from the
 * signature. Deterministic: same wallet ⇒ same posting account. Throws on a script/vault address or
 * a wallet that refuses to sign.
 */
export async function deriveSignerFromWallet(walletId: string): Promise<DerivedAccount> {
  const [{ BrowserWallet }, cst] = await Promise.all([import("@meshsdk/core"), import("@meshsdk/core-cst")]);
  const wallet = await BrowserWallet.enable(walletId);
  const signingAddress = await wallet.getChangeAddress();
  const props = cst.Address.fromBech32(signingAddress).getProps();
  if (props.paymentPart?.type !== 0) {
    // Critical security boundary: a script/vault payment credential is never a user vkey we can
    // derive a posting key from. Log the credential type so a mis-connected wallet is diagnosable.
    // eslint-disable-next-line no-console
    console.error(
      `cogno: wallet "${walletId}" change address has a non-vkey payment credential (type=${props.paymentPart?.type}); refusing to derive a posting key`,
    );
    throw new Error("connect a normal wallet address (a verification key), not a script/vault address");
  }
  const sig = (await wallet.signData(DERIVE_MESSAGE, signingAddress)) as { signature: string; key: string };
  if (!sig?.signature) {
    // The wallet refused / returned nothing — log it (the identity flow is dead without a signature).
    // eslint-disable-next-line no-console
    console.error(`cogno: wallet "${walletId}" did not return a signature for the derive message`);
    throw new Error("the wallet did not return a signature");
  }
  // seed = blake2b_256 of the COSE_Sign1 signature bytes (deterministic for a given wallet+message).
  const seed = blake2b(hexToBytes(sig.signature), undefined, 32);
  const signer = signerFromSeed(seed, { label: "wallet key", kind: "derived" });
  return { signer, signingAddress };
}
