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
  /** for a STAKE proof: the 28-byte stake credential the reward address proved (the voting anchor). */
  stakeCredentialHex?: string;
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
 * True for the *expected* wallet outcomes — the user dismissed the CIP-8 sign prompt or mistyped the
 * wallet password. These are user actions, not app faults: still surface them in the UI, but don't
 * `console.error` them. Next's dev server mirrors the browser console to the terminal, so a plain
 * decline would otherwise print a red stack trace for a non-event.
 */
export function isUserRejection(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("declined") ||
    msg.includes("rejected") ||
    msg.includes("denied") ||
    msg.includes("cancel") ||
    msg.includes("wrong password")
  );
}

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
    // never a script-payment (vault) address. The change address is always a base
    // address the wallet controls. The on-chain verifier also rejects script/pointer/stake-only addresses.
    const signingAddress: string = await wallet.getChangeAddress();
    const props = cst.Address.fromBech32(signingAddress).getProps();
    if (props.paymentPart?.type !== 0) {
      console.error(
        `cogno: bind aborted — wallet "${opts.walletId}" change address has a non-vkey payment credential (type=${props.paymentPart?.type}); never bind from a script/vault address`,
      );
      throw new Error("signing address has a script payment credential; bind from a normal wallet address, never a script/vault address");
    }

    // Build the EXACT payload IN-BROWSER (no follower): the nonce is client-generated and on-chain it is
    // format-checked only (replay is prevented by the pallet's 1:1 maps + permanent tombstone, not a nonce).
    const nonce = randomNonceHex();
    const payload = `${DOMAIN};genesis=${genesis};account=${account};nonce=${nonce}`;

    // Sign ONCE with the Cardano wallet (the only CIP-8 signature in the whole app).
    const sig = (await wallet.signData(payload, signingAddress)) as { signature: string; key: string };

    // Client pre-flight: recover the verification key and reject 64-byte extended keys — only 32-byte
    // CIP-30 keys are accepted (matched by the on-chain verifier). Best-effort: the runtime is
    // the authoritative verifier, so a recovery quirk doesn't block, but a clear extended key does.
    try {
      const vk = cst.getPublicKeyFromCoseKey(sig.key);
      const vkHex = typeof vk === "string" ? vk : (vk as { hex?: () => string }).hex?.() ?? String(vk);
      const vkLen = vkHex.replace(/^0x/, "").length / 2;
      if (vkLen === 64) {
        throw new Error("signing key is a 64-byte extended key; only 32-byte CIP-30 keys are accepted");
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
    // The whole proof is best-effort and returns a structured outcome, but a swallowed *genuine* error is
    // a silent identity-flow failure — log it with the account for diagnosis. A user-declined prompt or a
    // wrong wallet password is expected, not a fault: pass it through to the UI without console noise.
    if (!isUserRejection(e)) {
      console.error(`cogno: produceBindProof failed for account ${account.slice(0, 8)}…:`, e instanceof Error ? e.message : String(e));
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Produce a CIP-8 STAKE-key bind self-proof (spec 114 — voting power): enable the wallet → take its
 * REWARD address → build the same pinned payload IN-BROWSER → sign it ONCE WITH THE STAKE KEY (CIP-30
 * `signData` over the reward address). The proven 28-byte stake credential becomes the account's 1:1
 * voting-power anchor (its votes/polls then weight by the total Cardano stake of that credential). The
 * caller submits the returned proof via `cognoGate.link_stake_signed`; the runtime
 * ({@link import("../../../pallets/cogno-gate/src/cip8").verify_bind_proof_stake}) is the authoritative
 * verifier. Requires a wallet that signs over a reward address (Eternl, Lace); returns a structured
 * error otherwise (never throws). The posting account must already be payment-bound.
 */
export async function produceBindProofStake(opts: {
  walletId: string;
  /** the sr25519 posting account the proof commits (0x-prefixed or bare hex). */
  sr25519PubkeyHex: string;
  /** THIS chain's block-0 (genesis) hash, read via PAPI (0x-prefixed or bare hex) — anti-cross-chain. */
  genesisHex: string;
}): Promise<BindProof> {
  const account = opts.sr25519PubkeyHex.replace(/^0x/, "").toLowerCase();
  const genesis = opts.genesisHex.replace(/^0x/, "").toLowerCase();
  try {
    if (!/^[0-9a-f]{64}$/.test(account)) throw new Error("posting account is not a 32-byte hex pubkey");
    if (!/^[0-9a-f]{64}$/.test(genesis)) throw new Error("chain genesis is not a 32-byte hex hash");

    const [{ BrowserWallet }, cst] = await Promise.all([
      import("@meshsdk/core"),
      import("@meshsdk/core-cst"),
    ]);

    const wallet = await BrowserWallet.enable(opts.walletId);

    // The wallet's REWARD (stake) address — signing over it makes the wallet sign with the STAKE key.
    const rewardAddresses: string[] = await wallet.getRewardAddresses();
    if (!rewardAddresses.length) {
      throw new Error("wallet exposes no reward address; use Eternl (a base address with a stake key)");
    }
    const rewardAddress = rewardAddresses[0];

    // Parse the 29-byte reward address (header + 28-byte stake credential). Require a vkey stake reward
    // (header type 0b1110); a SCRIPT-stake reward (0b1111) is not a votable identity here.
    const rewardRaw = cst.Address.fromBech32(rewardAddress).toBytes().toString();
    if (rewardRaw.length !== 58) throw new Error("reward address is not 29 bytes; unexpected address shape");
    const addrType = parseInt(rewardRaw.slice(0, 2), 16) >> 4;
    if (addrType !== 0b1110) {
      throw new Error(`reward address has a script stake credential (type ${addrType}); only vkey stake keys can bind`);
    }
    const stakeCredentialHex = rewardRaw.slice(2);

    const nonce = randomNonceHex();
    const payload = `${DOMAIN};genesis=${genesis};account=${account};nonce=${nonce}`;

    // Sign ONCE over the reward address → a stake-key COSE_Sign1 (Eternl/Lace support this).
    const sig = (await wallet.signData(payload, rewardAddress)) as { signature: string; key: string };

    // Client pre-flight: reject 64-byte extended keys (only 32-byte CIP-30 keys verify on-chain).
    try {
      const vk = cst.getPublicKeyFromCoseKey(sig.key);
      const vkHex = typeof vk === "string" ? vk : (vk as { hex?: () => string }).hex?.() ?? String(vk);
      if (vkHex.replace(/^0x/, "").length / 2 === 64) {
        throw new Error("signing key is a 64-byte extended key; only 32-byte CIP-30 keys are accepted");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("extended key")) throw e;
    }

    if (hexByteLen(sig.signature) > 512) throw new Error("CIP-8 signature exceeds the 512-byte on-chain bound");
    if (hexByteLen(sig.key) > 128) throw new Error("CIP-8 key exceeds the 128-byte on-chain bound");

    return { ok: true, coseSign1: sig.signature, coseKey: sig.key, signingAddress: rewardAddress, stakeCredentialHex };
  } catch (e) {
    // A declined prompt / wrong wallet password is expected — surface it in the UI, but don't log it.
    if (!isUserRejection(e)) {
      console.error(`cogno: produceBindProofStake failed for account ${account.slice(0, 8)}…:`, e instanceof Error ? e.message : String(e));
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
