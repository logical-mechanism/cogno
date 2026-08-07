// Mint a CIP-8 (COSE_Sign1) bind proof from a locally generated Cardano key — the DEV-ONLY equivalent
// of what a CIP-30 wallet's `signData` returns in the browser.
//
// This exists so `seed-fixtures.mjs` can bind an identity on a `--dev` chain with no wallet. The trusted
// `FollowerOrigin` bind was removed (cogno-gate `call_index(0)` is permanently vacant), so a real proof
// is the ONLY way an account gets a Capacity row — and with no row, `current_capacity` returns 0 and
// every post fails `ExhaustsResources` no matter how much genesis weight the account holds.
//
// ⚠ DEV KEYS ONLY. The keys here are derived from a fixed seed and are not secret. This mints proofs; it
// verifies nothing. The runtime (pallets/cogno-gate/src/cip8.rs) is the authoritative verifier and the
// Python oracle in ci/cip8-oracle is the independent second implementation — this is a third thing, a
// test-fixture generator, and must never be treated as either.
//
// Built from Node's native Ed25519 plus hand-rolled CBOR rather than @meshsdk/core-cst on purpose:
// core-cst needs an async libsodium init AND redirects stdio on import, which would silently swallow the
// seeder's own progress output. The encodings below mirror the verifier's parser exactly — see
// `parse_protected` / `parse_cose_key` / `sig_structure` there before changing a byte.

import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import blake from "blakejs";

/** The signed payload grammar, pinned by the runtime: any deviation is rejected. */
const DOMAIN = "cogno-chain/bind/v1";

// ── minimal CBOR (only the shapes COSE needs) ──────────────────────────────────────────────────────

/** A CBOR head: major type in the top 3 bits, argument in the low 5 (with 1/2/4-byte extensions). */
function head(major, arg) {
  const m = major << 5;
  if (arg < 24) return Buffer.from([m | arg]);
  if (arg < 0x100) return Buffer.from([m | 24, arg]);
  if (arg < 0x10000) return Buffer.from([m | 25, arg >> 8, arg & 0xff]);
  throw new Error(`cbor arg too large: ${arg}`);
}
const uint = (n) => head(0, n);
/** A negative integer: CBOR encodes -1-arg, so alg EdDSA (-8) is major 1 with arg 7. */
const nint = (n) => head(1, -1 - n);
const bstr = (b) => Buffer.concat([head(2, b.length), Buffer.from(b)]);
const tstr = (s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([head(3, b.length), b]);
};
const map = (n) => head(5, n);
const array = (n) => head(4, n);

// ── keys and addresses ─────────────────────────────────────────────────────────────────────────────

/** PKCS8 DER prefix for a raw Ed25519 seed — lets Node build a private key from 32 deterministic bytes. */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** A deterministic Ed25519 keypair from a 32-byte seed. Deterministic so a re-run rebinds the SAME
 *  identity rather than minting a second one for the same account. */
function keypairFromSeed(seed32) {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed32)]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(key)
    .export({ format: "der", type: "spki" })
    .subarray(-32); // strip the SPKI header; the raw point is the last 32 bytes
  return { key, publicKey };
}

/** Cardano key hash: blake2b-224 of the raw 32-byte public key. */
const keyHash = (pubkey) => Buffer.from(blake.blake2b(pubkey, undefined, 28));

/**
 * A Cardano BASE address: `header ++ payment_key_hash(28) ++ stake_key_hash(28)`.
 *
 * The header's high nibble 0 is "payment=key, stake=key" — the only combination the verifier accepts on
 * the payment side (script, pointer and stake-only payment credentials are all rejected), and the low
 * nibble is the network. `network` must match the runtime's `CardanoNetwork` (0 = testnet) or the proof
 * is refused as cross-network.
 */
function baseAddress(paymentHash, stakeHash, network) {
  return Buffer.concat([Buffer.from([(0 << 4) | (network & 0x0f)]), paymentHash, stakeHash]);
}

// ── the proof ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Mint a bind proof committing `accountHex` on the chain whose block-0 hash is `genesisHex`.
 *
 * Returns `{ coseSign1, coseKey }` as 0x-hex, the same pair a wallet's `signData` hands back and the
 * same pair `CognoGate.link_identity_signed` takes.
 */
export function mintBindProof({ seed, accountHex, genesisHex, network = 0, nonceHex }) {
  const account = accountHex.replace(/^0x/, "").toLowerCase();
  const genesis = genesisHex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(account)) throw new Error(`account must be 64 hex: ${account}`);
  if (!/^[0-9a-f]{64}$/.test(genesis)) throw new Error(`genesis must be 64 hex: ${genesis}`);
  // The nonce is format-checked on chain (32 hex) and otherwise unused — replay is prevented by the 1:1
  // maps and the permanent tombstone, not by nonce bookkeeping. Derive it so a re-run is reproducible.
  const nonce = (nonceHex ?? Buffer.from(blake.blake2b(Buffer.from(account, "hex"), undefined, 16)).toString("hex")).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error(`nonce must be 32 hex: ${nonce}`);

  const { key, publicKey } = keypairFromSeed(seed);
  const address = baseAddress(keyHash(publicKey), keyHash(publicKey), network);

  const payload = Buffer.from(`${DOMAIN};genesis=${genesis};account=${account};nonce=${nonce}`, "utf8");

  // Protected header: {1: -8 (EdDSA), 4: <pubkey>, "address": <address>}. The verifier accepts these
  // three labels and rejects any other, so do not add one.
  const protectedMap = Buffer.concat([
    map(3),
    uint(1), nint(-8),
    uint(4), bstr(publicKey),
    tstr("address"), bstr(address),
  ]);

  // Sig_structure = ["Signature1", protected, h'', payload] — protected and payload are spliced as the
  // exact bstr wire bytes that end up in the COSE_Sign1, which is what makes the signature verify there.
  const protectedRaw = bstr(protectedMap);
  const payloadRaw = bstr(payload);
  const sigStructure = Buffer.concat([
    array(4),
    tstr("Signature1"),
    protectedRaw,
    bstr(Buffer.alloc(0)), // empty external_aad — CIP-30 always uses this
    payloadRaw,
  ]);

  const signature = sign(null, sigStructure, key);

  const coseSign1 = Buffer.concat([array(4), protectedRaw, map(0), payloadRaw, bstr(signature)]);
  // COSE_Key: {1: OKP(1), 3: EdDSA(-8), -1: Ed25519(6), -2: <pubkey>}
  const coseKey = Buffer.concat([
    map(4),
    uint(1), uint(1),
    uint(3), nint(-8),
    nint(-1), uint(6),
    nint(-2), bstr(publicKey),
  ]);

  if (coseSign1.length > 512) throw new Error(`cose_sign1 ${coseSign1.length}B exceeds the 512 bound`);
  if (coseKey.length > 128) throw new Error(`cose_key ${coseKey.length}B exceeds the 128 bound`);

  return { coseSign1: `0x${coseSign1.toString("hex")}`, coseKey: `0x${coseKey.toString("hex")}` };
}
