"use client";

// useSigner — the active posting key in React state.
//
// PRODUCT FLOW: the posting key is DERIVED from the connected Cardano wallet's signature
// (lib/signer/wallet-derive.ts) — nothing stored, no password, no second wallet. `connectWallet`
// signs the fixed derive-message and becomes that key; re-derive each session by connecting again.
//
// ADVANCED (hidden behind a toggle): the well-known dev accounts (//Alice…), for testing / operator
// use without a wallet. We persist only the dev CHOICE (a URI), never any secret.

import { useCallback, useEffect, useRef, useState } from "react";
import { DEV_ACCOUNTS, getDevSigner } from "@/lib/signer";
import { deriveSignerFromWallet } from "@/lib/signer/wallet-derive";
import type { PostingSigner } from "@/lib/types";

const DEV_CHOICE_KEY = "cogno.signer.devChoice";
const DEFAULT_DEV = "//Alice";
const LAST_WALLET_KEY = "cogno.wallet.last"; // non-secret: the wallet id, to offer a one-click reconnect

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
  /** A previously-connected wallet id, surfaced to offer a one-click reconnect. */
  lastWalletId: string | null;
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
  const [lastWalletId, setLastWalletId] = useState<string | null>(null);
  // The default //Alice is a BACKGROUND signer, not an active identity: posting stays disabled
  // until the user connects a wallet or explicitly chooses a dev account (advanced).
  const [devChosen, setDevChosen] = useState(false);

  const init = useRef(false);
  useEffect(() => {
    if (init.current) return;
    init.current = true;
    try {
      const w = window.localStorage.getItem(LAST_WALLET_KEY);
      if (w) setLastWalletId(w);
    } catch {
      /* localStorage may be unavailable (private mode); ignore */
    }
  }, []);

  const connectWallet = useCallback(async (walletId: string): Promise<boolean> => {
    setDeriving(true);
    setError(null);
    try {
      const { signer: s, signingAddress } = await deriveSignerFromWallet(walletId);
      setSigner(s);
      setDevChosen(false);
      setConnectedWalletId(walletId);
      setWalletAddress(signingAddress);
      try {
        window.localStorage.setItem(LAST_WALLET_KEY, walletId);
        setLastWalletId(walletId);
      } catch {
        /* best-effort */
      }
      return true;
    } catch (e) {
      // Surface the real failure — previously every connect error (wrong network, wallet-API failure,
      // signData decline, etc.) was masked as a single generic "cancelled" toast with nothing logged,
      // making it undiagnosable. Log the actual error so the cause is visible.
      // eslint-disable-next-line no-console
      console.error(`cogno: connectWallet("${walletId}") failed:`, e);
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setDeriving(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setConnectedWalletId(null);
    setWalletAddress(null);
    setError(null);
    setDevChosen(false);
    setSigner(getDevSigner(DEFAULT_DEV));
  }, []);

  const setDevAccount = useCallback((uri: string) => {
    setError(null);
    setConnectedWalletId(null);
    setWalletAddress(null);
    setDevChosen(true);
    setSigner(getDevSigner(uri));
    try {
      window.localStorage.setItem(DEV_CHOICE_KEY, uri);
    } catch {
      /* best-effort; the choice is non-essential */
    }
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
    lastWalletId,
    connectWallet,
    disconnect,
    devAccounts: DEV_ACCOUNTS,
    setDevAccount,
  };
}
