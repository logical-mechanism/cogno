// The posting-key adapter (sr25519).
//
// Every consumer only ever touches `{ ss58, publicKeyHex, label, signer, kind }`. In the product
// flow the key is DERIVED from a connected Cardano wallet's signature (signerFromSeed, kind
// "derived"; see lib/signer/wallet-derive.ts) — nothing stored. The dev accounts below are the
// advanced/testing fallback. The Cardano wallet that derives this key is also the identity it binds
// to (the M2 CIP-8 bind) and the owner that locks the L1 vault.

import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  mnemonicToEntropy,
  ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import { toHex } from "@polkadot-api/utils";
import type { PostingSigner } from "@/lib/types";

/** Well-known dev accounts, derived from the standard dev mnemonic. */
export const DEV_ACCOUNTS = [
  "//Alice",
  "//Bob",
  "//Charlie",
  "//Dave",
  "//Eve",
] as const;

/** The cogno-chain SS58 prefix (read from metadata elsewhere; 42 is the dev-chain value). */
const SS58_PREFIX = 42;

/** An sr25519 keypair as produced by `sr25519CreateDerive(...)(path)`. */
interface Sr25519KeyPair {
  publicKey: Uint8Array;
  sign: (message: Uint8Array) => Uint8Array;
}

/** Wrap a raw sr25519 keypair into the shared PostingSigner adapter shape. */
function toPostingSigner(
  kp: Sr25519KeyPair,
  label: string,
  kind: PostingSigner["kind"],
): PostingSigner {
  return {
    ss58: ss58Address(kp.publicKey, SS58_PREFIX),
    publicKeyHex: toHex(kp.publicKey),
    label,
    signer: getPolkadotSigner(kp.publicKey, "Sr25519", kp.sign),
    kind,
  };
}

/**
 * A dev-account signer (default `//Alice`), derived from the standard dev mnemonic.
 * These accounts are funded on the dev chain; the key is NOT a secret.
 */
export function getDevSigner(uri: string = "//Alice"): PostingSigner {
  const derive = sr25519CreateDerive(
    entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE)),
  );
  const kp = derive(uri) as Sr25519KeyPair;
  return toPostingSigner(kp, `${uri} (dev)`, "dev");
}

/**
 * Build a signer directly from a 32-byte seed (mini-secret) — the sign-to-derive path: the seed is
 * `blake2b_256` of a Cardano wallet's deterministic CIP-8 signature, so the same wallet always
 * reproduces the same posting key with nothing stored (lib/signer/wallet-derive.ts).
 */
export function signerFromSeed(
  seed: Uint8Array,
  opts: { path?: string; label?: string; kind?: PostingSigner["kind"] } = {},
): PostingSigner {
  const { path = "", label = "wallet key", kind = "derived" } = opts;
  const kp = sr25519CreateDerive(seed)(path) as Sr25519KeyPair;
  return toPostingSigner(kp, label, kind);
}
