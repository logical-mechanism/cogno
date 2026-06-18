// The Cardano CIP-8 bind flow (M2, L5 §5.5/§5.6). Connect a CIP-30 wallet, sign the follower's
// committed payload ONCE, run the client-side pre-flight gate, and POST the proof to the
// Cogno-Follower (the authoritative verifier). MeshJS is browser-only, so every dependency is
// dynamically imported INSIDE the async functions — this module is import-safe during the static
// export (no `window`/`document` at module-evaluation time).
//
// The dual-key discipline: the Cardano wallet signs CIP-8 exactly ONCE, here, at bind. It NEVER
// signs a post — posting uses the separate sr25519 key. This module never sees a private key.

import { getFollowerUrl } from "@/lib/config/endpoints";

/** The domain separator the follower commits — we re-check the follower's payload against it. */
const DOMAIN = "cogno-chain/bind/v1";

export interface CardanoWalletInfo {
  id: string;
  name: string;
  icon?: string;
}

export interface BindOutcome {
  ok: boolean;
  identityHash?: string;
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

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const r = await fetch(url, init);
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error((body.error as string) || `follower ${r.status}`);
  return body;
}

/**
 * The full bind: enable the wallet → fetch a nonce + the exact payload → sign it → client
 * pre-flight (vkey-payment address, 32-byte key) → POST to the follower. Returns a structured
 * outcome (never throws). The AccountOf readback is the caller's (the hook), so the bind is
 * "complete" only once the chain confirms it.
 */
export async function bindIdentity(opts: {
  walletId: string;
  /** the sr25519 posting account (0x-prefixed or bare hex). */
  sr25519PubkeyHex: string;
  followerUrl?: string;
}): Promise<BindOutcome> {
  const account = opts.sr25519PubkeyHex.replace(/^0x/, "").toLowerCase();
  const followerUrl = opts.followerUrl ?? getFollowerUrl();
  try {
    const [{ BrowserWallet }, cst] = await Promise.all([
      import("@meshsdk/core"),
      import("@meshsdk/core-cst"),
    ]);

    const wallet = await BrowserWallet.enable(opts.walletId);

    // Pick a signing address the user controls whose PAYMENT credential is a verification key
    // (type 0) — never a script-payment (vault) address (L5 §5.6 / L2 §7.4). The change address
    // is always a base address the wallet controls.
    const signingAddress: string = await wallet.getChangeAddress();
    const props = cst.Address.fromBech32(signingAddress).getProps();
    if (props.paymentPart?.type !== 0) {
      // eslint-disable-next-line no-console
      console.error(
        `cogno: bind aborted — wallet "${opts.walletId}" change address has a non-vkey payment credential (type=${props.paymentPart?.type}); never bind from a script/vault address`,
      );
      throw new Error("signing address has a script payment credential — bind from a normal wallet address, never a script/vault address");
    }

    // (1) fetch the nonce + the EXACT payload to sign.
    const nres = await fetchJson(`${followerUrl}/nonce?account=${account}`);
    const payload = nres.payload as string;
    const genesis = nres.genesis as string;
    // Defense in depth: refuse to sign anything that isn't a v1 bind committing MY account + this
    // chain's genesis (a malicious follower must not get us to sign something else).
    if (
      typeof payload !== "string" ||
      !payload.startsWith(`${DOMAIN};`) ||
      !payload.includes(`account=${account}`) ||
      !payload.includes(`genesis=${genesis}`)
    ) {
      // A malicious / mis-configured follower must never get us to sign something off-domain.
      // eslint-disable-next-line no-console
      console.error(
        `cogno: bind aborted — follower payload failed domain/account/genesis check for account ${account.slice(0, 8)}…; refusing to sign`,
      );
      throw new Error("follower returned an unexpected payload — refusing to sign");
    }

    // (2) sign ONCE with the Cardano wallet (the only CIP-8 signature in the whole app).
    const sig = (await wallet.signData(payload, signingAddress)) as { signature: string; key: string };

    // (3) client pre-flight: recover the verification key and reject 64-byte extended keys —
    //     only 32-byte CIP-30 keys are accepted (L5 §5.6). Best-effort: the follower is the
    //     authoritative verifier, so a recovery quirk doesn't block, but a clear extended key does.
    try {
      const vk = cst.getPublicKeyFromCoseKey(sig.key);
      const vkHex = typeof vk === "string" ? vk : (vk as { hex?: () => string }).hex?.() ?? String(vk);
      const vkLen = vkHex.replace(/^0x/, "").length / 2;
      if (vkLen === 64) {
        throw new Error("signing key is a 64-byte extended key — only 32-byte CIP-30 keys are accepted");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("extended key")) throw e;
      // recovery shape varied — let the follower (pycardano) be the authority.
    }

    // (4) POST the proof to the follower (it verifies the CIP-8 + submits link_identity).
    const bres = await fetchJson(`${followerUrl}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signature: sig.signature,
        key: sig.key,
        signing_address: signingAddress,
        sr25519_pubkey: account,
      }),
    });
    if (bres.ok !== true) {
      // eslint-disable-next-line no-console
      console.warn(
        `cogno: follower rejected the bind for account ${account.slice(0, 8)}…:`,
        (bres.error as string) || "(no reason given)",
      );
      return { ok: false, signingAddress, error: (bres.error as string) || "follower rejected the bind" };
    }
    return { ok: true, identityHash: bres.identity_hash as string, signingAddress };
  } catch (e) {
    // The whole bind is best-effort and returns a structured outcome, but a swallowed error is
    // a silent identity-flow failure — log it with the account for diagnosis.
    // eslint-disable-next-line no-console
    console.error(`cogno: bindIdentity failed for account ${account.slice(0, 8)}…:`, e instanceof Error ? e.message : String(e));
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
