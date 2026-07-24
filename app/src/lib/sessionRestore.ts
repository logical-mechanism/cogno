"use client";

// sessionRestore — the device-local record of WHICH ACCOUNT is signed in. Public values only.
//
// WHY THIS EXISTS. The posting key is derived from a Cardano wallet signature and held in memory, so
// before this every page refresh threw the whole session away: the auth wall bounced you off
// /settings, /notifications and /bookmarks, and on the public surfaces you silently became a guest.
// The worst of it was not convenience — every device-local store is keyed by ss58 (`cg-blocked:<ss58>`,
// `cg-muted:…`, `cg-hidden:…`, `cg-bookmarks:…`, `cg-notif-read:…`) and `viewer.address` was
// `undefined` after a reload, so `stringSetStore` routed the reads to its separate `anon` bucket: your
// block list was still on disk and simply not read. A refresh un-blocked everyone you had blocked.
//
// THE LINE THIS DOES NOT CROSS. The five fields below are the whole record, and none of them is a
// secret. `ss58` is the `author` field on every post you have written, the key in
// `CognoGate.AccountOf`, and the URL of your own profile page; `publicKeyHex` is that same account as
// bytes; `walletId` is a CIP-30 extension name. Only the wallet address (carried in two encodings,
// bech32 for display and CIP-30 hex for the no-popup probe) is not published on cogno-chain — it is
// public on the CARDANO ledger, but the chain stores only the 32-byte identity hash and the 28-byte
// stake credential. It is here so a restore can detect an in-wallet account switch, and it is cleared
// on sign-out.
//
// NEVER PUT HERE: the COSE_Sign1 signature, its blake2b_256 (which IS the sr25519 mini-secret), or the
// PolkadotSigner. Every "nothing is stored" claim in the repo — lib/signer/wallet-derive.ts,
// hooks/useSigner.ts, app/README.md, and most bindingly the DERIVE_MESSAGE the user reads inside their
// own wallet popup — is about exactly those, and they stay true. A leaked seed here would be
// unrecoverable, not inconvenient: the key is a pure function of (wallet, DERIVE_MESSAGE) with no
// nonce and no rotation, and the only remedy is a committee `CognoGate::revoke`, which tombstones both
// the identity AND the stake credential permanently.

import { useSyncExternalStore } from "react";
import { createPersistentStore } from "./persistentStore";
import type { Ss58 } from "./types";

const KEY = "cg-session";

/** The signed-in account, as public data. */
export interface RestoredSession {
  /** the CIP-30 wallet id the posting key was derived from (drives the re-sign + the identity probe). */
  walletId: string;
  /** the posting account (SS58, prefix 42) — the key every device-local store is bucketed by. */
  ss58: Ss58;
  /** that account's 0x-prefixed sr25519 public key — enough to ENCODE a tx, never to sign one. */
  publicKeyHex: string;
  /** the Cardano address the key was derived from, bech32 — shown in Settings → Account. */
  walletAddress: string;
  /**
   * The SAME address in CIP-30's raw hex form. Two encodings of one public value, kept because the
   * no-popup probe (`probeWalletIdentity`) can only read the hex one without importing the ~5.9 MB
   * MeshJS bundle, while Settings displays the bech32 one.
   */
  walletAddressHex: string;
}

/**
 * Parse a raw localStorage value into a record, or null.
 *
 * Exported for its test: this is the security-relevant surface of the whole feature. Whatever comes
 * back is fed to `signerFromRestored` (so `publicKeyHex` reaches `fromHex`) and used to bucket every
 * device-local store, so a truncated, hand-edited or wrong-typed record MUST degrade to "no session" —
 * today's guest behaviour — rather than to a half-built signer keyed on `undefined`.
 */
export function parseRestoredSession(raw: string | null): RestoredSession | null {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return null; // TOTAL by contract. The store's own try/catch would cover a throw, but a parser that
    // can throw is a footgun for the next caller — and "no session" is the only correct answer here.
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  // Validate every field on the READ path: a hand-edited or half-written record must degrade to "no
  // session" (today's guest behaviour), never to a half-built signer with an undefined ss58.
  if (
    typeof r.walletId !== "string" ||
    typeof r.ss58 !== "string" ||
    typeof r.publicKeyHex !== "string" ||
    typeof r.walletAddress !== "string" ||
    typeof r.walletAddressHex !== "string" ||
    !r.walletId ||
    !r.ss58 ||
    !r.publicKeyHex.startsWith("0x")
  ) {
    return null;
  }
  return {
    walletId: r.walletId,
    ss58: r.ss58 as Ss58,
    publicKeyHex: r.publicKeyHex,
    walletAddress: r.walletAddress,
    walletAddressHex: r.walletAddressHex.toLowerCase(),
  };
}

const store = createPersistentStore<RestoredSession | null>({
  key: KEY,
  empty: null,
  parse: parseRestoredSession,
  serialize: (v) => JSON.stringify(v),
  // Sign out in one tab and the others must follow — otherwise a "signed out" browser still has a tab
  // rendering the previous account's handle, avatar and moderation lists.
  crossTab: true,
});

/** Non-React read (the mount-time restore + the unlock path). */
export function readRestoredSession(): RestoredSession | null {
  return store.read();
}

/** Remember the signed-in account. Called on a successful connect and refreshed by an unlock. */
export function saveRestoredSession(rec: RestoredSession): void {
  store.commit(rec);
}

/** Forget it — sign-out, and the fail-closed arm of every restore check. */
export function clearRestoredSession(): void {
  if (store.read() === null) return;
  store.commit(null);
}

/**
 * The remembered account, or `null` when there is none — AND on the hydration render.
 *
 * `getServerSnapshot` returns null deliberately. Under `output: 'export'` the HTML on disk was built
 * with no session, so a localStorage read during the first client render is a #418 hydration mismatch
 * (this is the same constraint lib/routeSegment.ts documents at length for the dynamic segment).
 * React re-renders with the real snapshot immediately after hydration, so the restore lands one render
 * later — which is why {@link useHydrated} exists: `null` on that first render means "not known yet",
 * not "signed out", and the auth wall must be able to tell those apart.
 */
export function useRestoredSession(): RestoredSession | null {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

const subscribeNever = () => () => {};

/**
 * false during SSG + the hydration render, true from the first client render onward.
 *
 * The auth wall reads this: its redirect is a post-paint effect, so without it the wall would fire on
 * the pre-hydration commit — when no session can possibly be known yet — and `router.replace` the URL
 * to /welcome before the restore had a chance to land.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true, // client
    () => false, // server / the hydration render
  );
}
