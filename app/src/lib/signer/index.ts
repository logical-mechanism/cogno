// The posting-key adapter (sr25519).
//
// Every consumer only ever touches `{ ss58, publicKeyHex, label, signer, kind }`. The key can be a
// well-known dev account, a memory-only session key, or — since M8 — a durable key restored from
// the hardened encrypted keystore (lib/signer/keystore.ts). The Cardano identity is a SEPARATE key
// (a connected CIP-30 wallet), bound 1:1 to this posting key by the M2 CIP-8 bind.

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

/** Generate a fresh sr25519 mnemonic (12 words). The caller decides whether to keep it in memory
 *  (a session key) or encrypt it into the keystore. */
export function freshMnemonic(): string {
  return generateMnemonic();
}

/**
 * Generate a fresh random sr25519 session key. Returns both the signer and its mnemonic so the UI
 * can let the user back up the phrase. A session key lives only in memory (gone on refresh) — the
 * durable option is to save it to the encrypted keystore instead.
 */
export function generateSessionSigner(): {
  signer: PostingSigner;
  mnemonic: string;
} {
  const mnemonic = freshMnemonic();
  const kp = sr25519CreateDerive(
    mnemonicToMiniSecret(mnemonic),
  )("//0") as Sr25519KeyPair;
  return { signer: toPostingSigner(kp, "session key", "session"), mnemonic };
}

/**
 * Rebuild a signer from a mnemonic (default derivation path `//0`). Used both to import a phrase
 * and to restore the key after the encrypted keystore is unlocked. Throws on an invalid phrase.
 */
export function signerFromMnemonic(
  mnemonic: string,
  opts: { path?: string; label?: string; kind?: PostingSigner["kind"] } = {},
): PostingSigner {
  const { path = "//0", label = "imported key", kind = "mnemonic" } = opts;
  const kp = sr25519CreateDerive(
    mnemonicToMiniSecret(mnemonic.trim()),
  )(path) as Sr25519KeyPair;
  return toPostingSigner(kp, label, kind);
}
