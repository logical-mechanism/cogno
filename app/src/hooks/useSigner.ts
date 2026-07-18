"use client";

// useSigner — the active posting key in React state.
//
// PRODUCT FLOW: the posting key is DERIVED from the connected Cardano wallet's signature
// (lib/signer/wallet-derive.ts) — nothing stored, no password, no second wallet. `connectWallet`
// signs the fixed derive-message and becomes that key; re-derive each session by connecting again.
//
// ADVANCED (hidden behind a toggle): the well-known dev accounts (//Alice…), for testing / operator
// use without a wallet. Nothing is persisted — the wallet / dev choice is re-selected each session and
// no secret is ever stored.

import { useCallback, useRef, useState } from "react";
import { DEV_ACCOUNTS, getDevSigner } from "@/lib/signer";
import { deriveSignerFromWallet } from "@/lib/signer/wallet-derive";
import { isUserRejection } from "@/lib/cardano/cip8";
import { clearPostDraft } from "@/lib/composerDraftStore";
import { recentSearchActions } from "@/lib/recentSearchStore";
import type { PostingSigner } from "@/lib/types";

const DEFAULT_DEV = "//Alice";

export interface UseSigner {
  /** The currently active posting signer (a wallet-derived key, or a dev account in advanced mode). */
  signer: PostingSigner;
  /** The active posting key is a wallet-derived key (the product flow is "connected"). */
  walletConnected: boolean;
  /** Posting is enabled: a wallet is connected OR a dev account was explicitly chosen (advanced). */
  postingEnabled: boolean;
  /** The Cardano wallet id the posting key was derived from (drives bind + vault lock/exit). */
  connectedWalletId: string | null;
  /** The connected wallet address (its identity/stake key). */
  walletAddress: string | null;
  /** A sign-to-derive is in flight. */
  deriving: boolean;
  error: string | null;
  /** Connect a CIP-30 wallet and derive the posting key from its signature. */
  connectWallet: (walletId: string) => Promise<boolean>;
  /** Drop the derived key (back to disconnected). */
  disconnect: () => void;

  // ── advanced / dev (hidden behind a toggle) ──
  devAccounts: readonly string[];
  setDevAccount: (uri: string) => void;
}

export function useSigner(): UseSigner {
  // Default deterministically to //Alice so SSR/first paint matches; the persisted dev choice and
  // last-wallet hint are applied on the client after mount (avoids a hydration mismatch).
  const [signer, setSigner] = useState<PostingSigner>(() => getDevSigner(DEFAULT_DEV));
  const [connectedWalletId, setConnectedWalletId] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The default //Alice is a BACKGROUND signer, not an active identity: posting stays disabled
  // until the user connects a wallet or explicitly chooses a dev account (advanced).
  const [devChosen, setDevChosen] = useState(false);

  // Monotonic "derive generation". A CIP-30 signData() has no abort handle, so Cancel/disconnect can't
  // stop an in-flight wallet prompt — but it CAN abandon it: bumping this invalidates the pending
  // derive so its late (or never-arriving) result is ignored and the spinner is released immediately.
  // Without this, a dismissed-but-unsettled wallet popup wedges `deriving` true forever (dead Cancel).
  const deriveGen = useRef(0);

  const connectWallet = useCallback(async (walletId: string): Promise<boolean> => {
    const gen = ++deriveGen.current;
    setDeriving(true);
    setError(null);
    try {
      const { signer: s, signingAddress } = await deriveSignerFromWallet(walletId);
      if (deriveGen.current !== gen) return false; // cancelled mid-derive — drop the stale result
      setSigner(s);
      setDevChosen(false);
      setConnectedWalletId(walletId);
      setWalletAddress(signingAddress);
      return true;
    } catch (e) {
      if (deriveGen.current !== gen) return false; // cancelled — swallow the late error too
      // A user-declined sign prompt (or a dismissed wallet popup) is an expected action, not a fault:
      // surface it in the UI (the caller classifies it into a gentle "Connection cancelled." toast) but
      // do NOT console.error it — Next's dev server mirrors the browser console to the terminal, so a
      // plain decline would print a red stack trace for a non-event. Same rule the CIP-8 binds already
      // follow. A GENUINE failure (wrong network, wallet-API error, no signature) is still logged.
      if (!isUserRejection(e)) {
        console.error(`cogno: connectWallet("${walletId}") failed:`, e);
      }
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      // Only the CURRENT derive owns the spinner; a cancelled one already released it (and a newer
      // derive may now own it), so don't stomp on that.
      if (deriveGen.current === gen) setDeriving(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    deriveGen.current++; // abandon any in-flight derive so its late resolution can't revive this session
    setDeriving(false); // release the "Check your wallet" spinner immediately (makes Cancel actually work)
    setConnectedWalletId(null);
    setWalletAddress(null);
    setError(null);
    setDevChosen(false);
    setSigner(getDevSigner(DEFAULT_DEV));
    // Device-local, identity-agnostic state that must not resurface for the NEXT account on a shared
    // device: the unsent post draft, and the recent-search terms (the set stores are per-account, but
    // recent searches are a single device-global key, so clear them explicitly here).
    clearPostDraft();
    recentSearchActions.clear();
  }, []);

  const setDevAccount = useCallback((uri: string) => {
    setError(null);
    setConnectedWalletId(null);
    setWalletAddress(null);
    setDevChosen(true);
    setSigner(getDevSigner(uri));
  }, []);

  const walletConnected = signer.kind === "derived";
  return {
    signer,
    walletConnected,
    postingEnabled: walletConnected || devChosen,
    connectedWalletId,
    walletAddress,
    deriving,
    error,
    connectWallet,
    disconnect,
    devAccounts: DEV_ACCOUNTS,
    setDevAccount,
  };
}
