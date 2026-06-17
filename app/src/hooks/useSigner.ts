"use client";

// useSigner — the active posting key in React state.
//
// M1 honesty: the sr25519 key lives ONLY in memory (or, for a dev account, is
// re-derived from the well-known DEV_PHRASE). We persist at most the CHOICE of dev
// account (a URI like "//Alice"), never secret material. Generating a session key
// surfaces its mnemonic ONCE so the user can back it up; we keep no copy on disk.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEV_ACCOUNTS,
  getDevSigner,
  generateSessionSigner,
} from "@/lib/signer";
import type { PostingSigner } from "@/lib/types";

const DEV_CHOICE_KEY = "cogno.signer.devChoice";
const DEFAULT_DEV = "//Alice";

function readDevChoice(): string {
  if (typeof window === "undefined") return DEFAULT_DEV;
  try {
    const v = window.localStorage.getItem(DEV_CHOICE_KEY);
    if (v && (DEV_ACCOUNTS as readonly string[]).includes(v)) return v;
  } catch {
    /* localStorage may be unavailable (private mode); fall through to default */
  }
  return DEFAULT_DEV;
}

function writeDevChoice(uri: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DEV_CHOICE_KEY, uri);
  } catch {
    /* best-effort; the choice is non-essential */
  }
}

export interface UseSigner {
  /** The currently active posting signer. */
  signer: PostingSigner;
  /** The dev URIs available to switch to (e.g. "//Alice"). */
  devAccounts: readonly string[];
  /** Switch to a dev account (re-derived; persisted as a non-secret choice). */
  setDevAccount: (uri: string) => void;
  /** Generate a fresh in-memory session key and become it. */
  useSessionKey: () => void;
  /** The mnemonic of the active session key, surfaced ONCE for backup (null otherwise). */
  sessionMnemonic: string | null;
  /** Dismiss the surfaced mnemonic once the user has backed it up. */
  ackSessionMnemonic: () => void;
}

export function useSigner(): UseSigner {
  // Default deterministically to //Alice so SSR/first paint matches; the persisted
  // choice is applied on the client after mount (avoids hydration mismatch).
  const [signer, setSigner] = useState<PostingSigner>(() =>
    getDevSigner(DEFAULT_DEV),
  );
  const [sessionMnemonic, setSessionMnemonic] = useState<string | null>(null);

  // Apply the persisted dev choice once, on the client only.
  const appliedChoice = useRef(false);
  useEffect(() => {
    if (appliedChoice.current) return;
    appliedChoice.current = true;
    const choice = readDevChoice();
    if (choice !== DEFAULT_DEV) {
      setSigner(getDevSigner(choice));
    }
  }, []);

  const setDevAccount = useCallback((uri: string) => {
    setSessionMnemonic(null);
    setSigner(getDevSigner(uri));
    writeDevChoice(uri);
  }, []);

  const useSessionKey = useCallback(() => {
    const { signer: s, mnemonic } = generateSessionSigner();
    setSigner(s);
    setSessionMnemonic(mnemonic);
  }, []);

  const ackSessionMnemonic = useCallback(() => {
    setSessionMnemonic(null);
  }, []);

  return {
    signer,
    devAccounts: DEV_ACCOUNTS,
    setDevAccount,
    useSessionKey,
    sessionMnemonic,
    ackSessionMnemonic,
  };
}
