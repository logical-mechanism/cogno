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
import { fromHex, toHex } from "@polkadot-api/utils";
import type { PolkadotSigner } from "polkadot-api/signer";
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

/**
 * Rebuild a signer from the PUBLIC half alone (lib/sessionRestore.ts), deferring the seed until a write
 * actually needs it. This is what makes a page refresh stop logging the user out.
 *
 * WHY A LAZY SIGNER AND NOT A THROWING STUB PLUS A `canSign` FLAG. A `PolkadotSigner` needs the public
 * key to BUILD and encode an extrinsic and the secret only to SIGN one — and we have the public key.
 * So the restored signer is a real signer whose `signTx` awaits `unlock()` (one CIP-8 wallet prompt)
 * and then delegates to the freshly-derived key. Every existing write path is untouched: the two call
 * sites that ever materialize `.signer` (lib/chain/post.ts's submit funnel and `unclaim_role`) neither
 * know nor care, and a declined prompt rejects `signTx`, which the tx stream already turns into the
 * same rollback-and-toast a failed post takes.
 *
 * The alternative — a stub that throws, plus a `canSign` term ANDed into `viewer.writeReady` — would
 * have had to thread through 48 `writeReady` references, and every write affordance routes a
 * not-writeReady user to /welcome, whose step machine reads `sessionState` alone and bounces a
 * fully-set-up account straight back: a loop with no signature prompt in it. This shape has no such
 * failure mode because a restored session IS writeReady; the popup simply arrives at submit time.
 *
 * `unlock` MUST verify that the key it derives reproduces this exact ss58 before returning — a
 * multi-account wallet (Eternl, Lace) switched to a different account derives a DIFFERENT posting key,
 * and signing a tx built for one account with another account's key is not a recoverable state.
 */
export function signerFromRestored(
  rec: { ss58: string; publicKeyHex: string },
  unlock: () => Promise<PostingSigner>,
): PostingSigner {
  const publicKey = fromHex(rec.publicKeyHex);
  return {
    ss58: rec.ss58 as PostingSigner["ss58"],
    publicKeyHex: rec.publicKeyHex,
    label: "wallet key",
    kind: "restored",
    signer: {
      publicKey,
      signTx: async (...args: Parameters<PolkadotSigner["signTx"]>) =>
        (await unlock()).signer.signTx(...args),
      signBytes: async (data: Uint8Array) => (await unlock()).signer.signBytes(data),
    },
  };
}
