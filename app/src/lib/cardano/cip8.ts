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

/** The shape of a CIP-30 wallet object injected at `window.cardano[key]` (enumeration + probe fields). */
interface Cip30Injected {
  name?: string;
  icon?: string;
  apiVersion?: string;
  isEnabled?: () => Promise<boolean>;
  enable?: () => Promise<Cip30Api>;
}

/** The slice of the enabled CIP-30 API the identity probe needs. */
interface Cip30Api {
  getNetworkId?: () => Promise<number>;
  getChangeAddress?: () => Promise<string>;
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

/**
 * Installed CIP-30 wallets (Eternl, Lace, Nami, …). Empty if none / not a browser.
 *
 * Reads `window.cardano` DIRECTLY rather than importing MeshJS's `BrowserWallet.getInstalledWallets()`.
 * Enumerating wallets only needs the injected CIP-30 objects (name/icon/apiVersion), but importing
 * `@meshsdk/core` for it drags the entire ~5.9 MB Cardano serialization+crypto bundle onto the page.
 * That matters because AppShell's auth wall bounces every cold visitor to /welcome, which mounts
 * WalletPicker, which lists wallets on mount — so the old import loaded + executed ~1.5 s of JS on
 * EVERY first visit (the dominant PageSpeed cost / TBT). The heavy bundle now loads only when a user
 * actually connects (deriveSignerFromWallet → BrowserWallet.enable). This mirrors MeshJS's
 * getInstalledWallets() exactly — skip entries missing name/icon/apiVersion; rename nufiSnap →
 * "MetaMask" — so the rendered list is identical. Keep it a `window.cardano` read; do NOT "simplify"
 * it back to a MeshJS import.
 */
export function listCardanoWallets(): CardanoWalletInfo[] {
  if (typeof window === "undefined") return [];
  try {
    const cardano = (window as unknown as { cardano?: Record<string, Cip30Injected | undefined> }).cardano;
    if (!cardano) return [];
    const wallets: CardanoWalletInfo[] = [];
    for (const key of Object.keys(cardano)) {
      try {
        const w = cardano[key];
        // A CIP-30 wallet exposes name + icon + apiVersion; anything missing one is not an enumerable wallet.
        if (!w || w.name === undefined || w.icon === undefined || w.apiVersion === undefined) continue;
        wallets.push({ id: key, name: key === "nufiSnap" ? "MetaMask" : w.name, icon: w.icon });
      } catch {
        // a hostile/broken injected getter for THIS wallet — skip it, never let one break the list
      }
    }
    return wallets;
  } catch {
    // window.cardano itself is a throwing getter / exotic proxy — honor the "empty if none" contract so a
    // caller (WalletPicker's mount effect, ConnectWalletButton's click) never sees a throw.
    return [];
  }
}

/** The verdict of {@link probeWalletIdentity}. */
export type WalletProbe =
  /** The grant survives, the network is preprod, and the wallet's change address is `addressHex`. */
  | { ok: true; addressHex: string }
  /**
   * Could not confirm. `unavailable` = the extension is gone or this origin's grant has lapsed (or the
   * wallet is locked) — inconclusive, so a caller must NOT treat it as a mismatch. `mismatch` = the
   * wallet answered and it is a DIFFERENT account or the wrong network, which IS conclusive.
   */
  | { ok: false; kind: "unavailable" | "mismatch"; reason: string };

/**
 * Ask an already-authorized wallet, WITHOUT a popup, which account it is currently on.
 *
 * This is the guard on the restored session (lib/sessionRestore.ts). The posting key is
 * `blake2b_256(COSE_Sign1 over the wallet's change address)`, so a multi-account wallet — Eternl and
 * Lace both hold several accounts behind one extension — derives a DIFFERENT posting key after the user
 * switches account. A remembered `{walletId, ss58}` pair has no way to notice on its own: the app would
 * confidently render account #1's handle, avatar and (because the device stores are ss58-keyed) its
 * bookmarks, mutes and block list, until a write silently swapped the identity underneath. The same
 * blind spot covers the network — `deriveSignerFromWallet` refuses `getNetworkId() !== 0` precisely
 * because a mainnet-flavoured connection mints a different account, and a remembered ss58 would sail
 * straight past that check.
 *
 * NO POPUP: CIP-30 `isEnabled()` resolves without prompting, and `enable()` is silent for an origin the
 * user has already authorized — the app already depends on that (useVault's post-lock poll calls
 * `enable()` every 6s for up to 10 ticks). A locked wallet may still show its unlock UI, which is why a
 * failure here is reported as `unavailable` and left inconclusive rather than dropping the session.
 *
 * Reads `window.cardano` DIRECTLY — see the note on {@link listCardanoWallets}: importing MeshJS here
 * would drag the ~5.9 MB Cardano bundle onto every cold load, which is exactly what the restore is
 * meant to avoid. The address comes back in CIP-30's raw hex form, which is why the session record
 * keeps `walletAddressHex` alongside the bech32 one it displays.
 */
export async function probeWalletIdentity(walletId: string): Promise<WalletProbe> {
  if (typeof window === "undefined") {
    return { ok: false, kind: "unavailable", reason: "not a browser" };
  }
  try {
    const cardano = (window as unknown as { cardano?: Record<string, Cip30Injected | undefined> }).cardano;
    const w = cardano?.[walletId];
    if (!w || typeof w.isEnabled !== "function" || typeof w.enable !== "function") {
      return { ok: false, kind: "unavailable", reason: `wallet "${walletId}" is not installed` };
    }
    if (!(await w.isEnabled())) {
      return { ok: false, kind: "unavailable", reason: `wallet "${walletId}" has not authorized this site` };
    }
    const api = await w.enable();
    if (typeof api?.getNetworkId !== "function" || typeof api.getChangeAddress !== "function") {
      return { ok: false, kind: "unavailable", reason: `wallet "${walletId}" returned an incomplete API` };
    }
    // Same rule as the vault's and the derive's: 0 = preprod. A mainnet-flavoured wallet is a genuine
    // mismatch (it would derive a different posting key), not an inconclusive read.
    if ((await api.getNetworkId()) !== 0) {
      return { ok: false, kind: "mismatch", reason: "the wallet is not on preprod (testnet)" };
    }
    const addressHex = await api.getChangeAddress();
    if (typeof addressHex !== "string" || addressHex.length === 0) {
      return { ok: false, kind: "unavailable", reason: "the wallet returned no change address" };
    }
    return { ok: true, addressHex: addressHex.toLowerCase() };
  } catch (e) {
    // A throwing injected getter, a rejected enable(), a wallet mid-upgrade — all inconclusive.
    return {
      ok: false,
      kind: "unavailable",
      reason: e instanceof Error ? e.message : String(e),
    };
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
    if (!/^[0-9a-f]{64}$/.test(account)) throw new Error("Your account key looks malformed. Reconnect your wallet.");
    if (!/^[0-9a-f]{64}$/.test(genesis)) throw new Error("Got a malformed reply from the network. Try again.");

    const [{ BrowserWallet }, cst] = await Promise.all([
      import("@meshsdk/core"),
      import("@meshsdk/core-cst"),
    ]);

    const wallet = await BrowserWallet.enable(opts.walletId);
    // Belt-and-suspenders wrong-network guard (connect already blocks it): a mainnet-flavoured bind would
    // commit a PERMANENT identity under an account that preprod can't reproduce. `!== 0` = preprod.
    if ((await wallet.getNetworkId()) !== 0) {
      throw new Error("Switch your wallet to preprod (testnet), then reconnect.");
    }

    // Pick a signing address the user controls whose PAYMENT credential is a verification key (type 0) —
    // never a script-payment (vault) address. The change address is always a base
    // address the wallet controls. The on-chain verifier also rejects script/pointer/stake-only addresses.
    const signingAddress: string = await wallet.getChangeAddress();
    const props = cst.Address.fromBech32(signingAddress).getProps();
    if (props.paymentPart?.type !== 0) {
      console.error(
        `cogno: bind aborted — wallet "${opts.walletId}" change address has a non-vkey payment credential (type=${props.paymentPart?.type}); never bind from a script/vault address`,
      );
      throw new Error("That's a script payment credential. Connect a normal wallet account.");
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
        throw new Error("This wallet's extended key isn't supported. Try another wallet.");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("extended key")) throw e;
      // recovery shape varied — let the on-chain verifier be the authority.
    }

    // The on-chain args are bounded (cose_sign1 <= 512 bytes, cose_key <= 128 bytes); a blob over the
    // bound would be rejected at decode, so fail early with a clear message.
    if (hexByteLen(sig.signature) > 512) throw new Error("Your wallet's signature exceeds the size the network accepts.");
    if (hexByteLen(sig.key) > 128) throw new Error("Your wallet's key exceeds the size the network accepts.");

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
    if (!/^[0-9a-f]{64}$/.test(account)) throw new Error("Your account key looks malformed. Reconnect your wallet.");
    if (!/^[0-9a-f]{64}$/.test(genesis)) throw new Error("Got a malformed reply from the network. Try again.");

    const [{ BrowserWallet }, cst] = await Promise.all([
      import("@meshsdk/core"),
      import("@meshsdk/core-cst"),
    ]);

    const wallet = await BrowserWallet.enable(opts.walletId);
    // Belt-and-suspenders wrong-network guard (connect already blocks it): a mainnet-flavoured stake bind
    // would anchor voting power to a credential preprod can't reproduce. `!== 0` = preprod.
    if ((await wallet.getNetworkId()) !== 0) {
      throw new Error("Switch your wallet to preprod (testnet), then reconnect.");
    }

    // The wallet's REWARD (stake) address — signing over it makes the wallet sign with the STAKE key.
    const rewardAddresses: string[] = await wallet.getRewardAddresses();
    if (!rewardAddresses.length) {
      throw new Error("This wallet has no reward address. Use Eternl or Lace.");
    }
    const rewardAddress = rewardAddresses[0];

    // Parse the 29-byte reward address (header + 28-byte stake credential). Require a vkey stake reward
    // (header type 0b1110); a SCRIPT-stake reward (0b1111) is not a votable identity here.
    const rewardRaw = cst.Address.fromBech32(rewardAddress).toBytes().toString();
    if (rewardRaw.length !== 58) throw new Error("Couldn't read this wallet's reward address.");
    const addrType = parseInt(rewardRaw.slice(0, 2), 16) >> 4;
    if (addrType !== 0b1110) {
      throw new Error(`Script stake keys can't be linked (type ${addrType}). Use a wallet with a normal stake key.`);
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
        throw new Error("This wallet's extended key isn't supported. Try another wallet.");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("extended key")) throw e;
    }

    if (hexByteLen(sig.signature) > 512) throw new Error("Your wallet's signature exceeds the size the network accepts.");
    if (hexByteLen(sig.key) > 128) throw new Error("Your wallet's key exceeds the size the network accepts.");

    return { ok: true, coseSign1: sig.signature, coseKey: sig.key, signingAddress: rewardAddress, stakeCredentialHex };
  } catch (e) {
    // A declined prompt / wrong wallet password is expected — surface it in the UI, but don't log it.
    if (!isUserRejection(e)) {
      console.error(`cogno: produceBindProofStake failed for account ${account.slice(0, 8)}…:`, e instanceof Error ? e.message : String(e));
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
