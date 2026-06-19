// The Cardano CIP-8 bind flow (D1 — trustless identity). Connect a CIP-30 wallet, build the pinned
// bind payload IN-BROWSER over THIS chain's live genesis, run the client-side pre-flight gate, and sign
// it ONCE. The signed proof (COSE_Sign1 + COSE_Key) is then submitted DIRECTLY on-chain via
// `cognoGate.link_identity_signed` (see lib/chain/identity.ts) — the RUNTIME verifies the signature, so
// there is no trusted follower in the bind path. MeshJS is browser-only, so every dependency is
// dynamically imported INSIDE the async functions — this module is import-safe during the static export.
//
// The dual-key discipline: the Cardano wallet signs CIP-8 exactly ONCE, here, at bind. It NEVER signs a
// post — posting uses the separate sr25519 key. This module never sees a private key.

/** The domain separator the runtime verifier pins; the payload grammar is shared with cip8.rs/payload.py. */
const DOMAIN = "cogno-chain/bind/v1";

export interface CardanoWalletInfo {
  id: string;
  name: string;
  icon?: string;
}

/** A signed bind proof, ready to submit via `cognoGate.link_identity_signed` (hex COSE blobs). */
export interface BindProof {
  ok: boolean;
  /** the wallet's `signData` signature = the COSE_Sign1 blob (hex). */
  coseSign1?: string;
  /** the wallet's `signData` key = the COSE_Key blob (hex). */
  coseKey?: string;
  /** the Cardano address the proof was signed from (for display). */
  signingAddress?: string;
  error?: string;
}

/** Installed CIP-30 wallets (Eternl, Lace, Nami, …). Empty if none / not a browser. */
export async function listCardanoWallets(): Promise<CardanoWalletInfo[]> {
  try {
    const { BrowserWallet } = await import("@meshsdk/core");
    return BrowserWallet.getInstalledWallets().map((w: { id: string; name: string; icon?: string }) => ({
      id: w.id,
      name: w.name,
      icon: w.icon,
    }));
  } catch {
    return [];
  }
}

/** Crypto-random 16-byte nonce as 32 lowercase-hex chars (matches the pinned payload grammar). */
function randomNonceHex(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const hexByteLen = (h: string) => h.replace(/^0x/, "").length / 2;

/**
 * Produce a CIP-8 bind self-proof: enable the wallet → pick a vkey-payment signing address → build the
 * pinned payload IN-BROWSER (committing MY posting account + THIS chain's genesis + a fresh nonce) →
 * client pre-flight (vkey-payment address, 32-byte key, on-chain size bounds) → sign it ONCE. Returns a
 * structured outcome (never throws). The caller submits the returned proof via
 * {@link import("@/lib/chain/identity").submitLinkIdentitySigned}; the runtime is the authoritative verifier.
 */
export async function produceBindProof(opts: {
  walletId: string;
  /** the sr25519 posting account the proof commits (0x-prefixed or bare hex). */
  sr25519PubkeyHex: string;
  /** THIS chain's block-0 (genesis) hash, read via PAPI (0x-prefixed or bare hex) — anti-cross-chain. */
  genesisHex: string;
}): Promise<BindProof> {
  const account = opts.sr25519PubkeyHex.replace(/^0x/, "").toLowerCase();
  const genesis = opts.genesisHex.replace(/^0x/, "").toLowerCase();
  try {
    // The payload grammar pins 64-hex genesis + 64-hex account; refuse to sign a malformed commitment.
    if (!/^[0-9a-f]{64}$/.test(account)) throw new Error("posting account is not a 32-byte hex pubkey");
    if (!/^[0-9a-f]{64}$/.test(genesis)) throw new Error("chain genesis is not a 32-byte hex hash");

    const [{ BrowserWallet }, cst] = await Promise.all([
      import("@meshsdk/core"),
      import("@meshsdk/core-cst"),
    ]);

    const wallet = await BrowserWallet.enable(opts.walletId);

    // Pick a signing address the user controls whose PAYMENT credential is a verification key (type 0) —
    // never a script-payment (vault) address (L5 §5.6 / L2 §7.4). The change address is always a base
    // address the wallet controls. The on-chain verifier also rejects script/pointer/stake-only addresses.
    const signingAddress: string = await wallet.getChangeAddress();
    const props = cst.Address.fromBech32(signingAddress).getProps();
    if (props.paymentPart?.type !== 0) {
      // eslint-disable-next-line no-console
      console.error(
        `cogno: bind aborted — wallet "${opts.walletId}" change address has a non-vkey payment credential (type=${props.paymentPart?.type}); never bind from a script/vault address`,
      );
      throw new Error("signing address has a script payment credential — bind from a normal wallet address, never a script/vault address");
    }

    // Build the EXACT payload IN-BROWSER (no follower): the nonce is client-generated and on-chain it is
    // format-checked only (replay is prevented by the pallet's 1:1 maps + permanent tombstone, not a nonce).
    const nonce = randomNonceHex();
    const payload = `${DOMAIN};genesis=${genesis};account=${account};nonce=${nonce}`;

    // Sign ONCE with the Cardano wallet (the only CIP-8 signature in the whole app).
    const sig = (await wallet.signData(payload, signingAddress)) as { signature: string; key: string };

    // Client pre-flight: recover the verification key and reject 64-byte extended keys — only 32-byte
    // CIP-30 keys are accepted (L5 §5.6, matched by the on-chain verifier). Best-effort: the runtime is
    // the authoritative verifier, so a recovery quirk doesn't block, but a clear extended key does.
    try {
      const vk = cst.getPublicKeyFromCoseKey(sig.key);
      const vkHex = typeof vk === "string" ? vk : (vk as { hex?: () => string }).hex?.() ?? String(vk);
      const vkLen = vkHex.replace(/^0x/, "").length / 2;
      if (vkLen === 64) {
        throw new Error("signing key is a 64-byte extended key — only 32-byte CIP-30 keys are accepted");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("extended key")) throw e;
      // recovery shape varied — let the on-chain verifier be the authority.
    }

    // The on-chain args are bounded (cose_sign1 <= 512 bytes, cose_key <= 128 bytes); a blob over the
    // bound would be rejected at decode, so fail early with a clear message.
    if (hexByteLen(sig.signature) > 512) throw new Error("CIP-8 signature exceeds the 512-byte on-chain bound");
    if (hexByteLen(sig.key) > 128) throw new Error("CIP-8 key exceeds the 128-byte on-chain bound");

    return { ok: true, coseSign1: sig.signature, coseKey: sig.key, signingAddress };
  } catch (e) {
    // The whole proof is best-effort and returns a structured outcome, but a swallowed error is a silent
    // identity-flow failure — log it with the account for diagnosis.
    // eslint-disable-next-line no-console
    console.error(`cogno: produceBindProof failed for account ${account.slice(0, 8)}…:`, e instanceof Error ? e.message : String(e));
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
