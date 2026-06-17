// The posting-key adapter (sr25519).
//
// In M1 this is a SIMPLE in-session/dev key — but the returned shape is exactly the future
// hardened Model-B keystore signer (L5-M2), so when that lands NO call-site changes: every
// consumer only ever touches `{ ss58, publicKeyHex, label, signer, kind }`. The Cardano
// identity half does not exist in M1.

import { getPolkadotSigner } from "polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  mnemonicToEntropy,
  mnemonicToMiniSecret,
  generateMnemonic,
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
 * Generate a fresh random sr25519 session key. Returns both the signer and its mnemonic so
 * the UI can show / let the user back up the phrase. In M1 this lives only in memory/session
 * (the hardened encrypted keystore is L5-M2); the adapter shape is already final.
 */
export function generateSessionSigner(): {
  signer: PostingSigner;
  mnemonic: string;
} {
  const mnemonic = generateMnemonic();
  const kp = sr25519CreateDerive(
    mnemonicToMiniSecret(mnemonic),
  )("//0") as Sr25519KeyPair;
  return { signer: toPostingSigner(kp, "session key", "session"), mnemonic };
}

/**
 * Rebuild a signer from a user-supplied mnemonic (default derivation path `//0`).
 * Lets a user restore the same key across sessions until the real keystore exists.
 */
export function signerFromMnemonic(
  mnemonic: string,
  path: string = "//0",
): PostingSigner {
  const kp = sr25519CreateDerive(
    mnemonicToMiniSecret(mnemonic),
  )(path) as Sr25519KeyPair;
  return toPostingSigner(kp, "imported key", "mnemonic");
}
