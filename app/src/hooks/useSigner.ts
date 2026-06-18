"use client";

// useSigner — the active posting key in React state.
//
// Three provenances, all the same PostingSigner shape:
//   • dev account — re-derived from the well-known DEV_PHRASE; we persist only the CHOICE (a URI
//     like "//Alice"), never secret material. Public, for trying things.
//   • session key — a fresh random key kept ONLY in memory; its mnemonic is surfaced once to back
//     up, then dropped. Gone on refresh.
//   • keystore key (M8) — a durable key encrypted at rest (lib/signer/keystore.ts). Unlocking it
//     needs the password each session; only ciphertext lives on disk.
//
// A saved keystore stays LOCKED until you unlock it — the active signer falls back to a dev
// account so reads/UX still work, and the UI invites you to unlock to post as your own key.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEV_ACCOUNTS,
  getDevSigner,
  generateSessionSigner,
  freshMnemonic,
  signerFromMnemonic,
} from "@/lib/signer";
import {
  encryptMnemonic,
  decryptMnemonic,
  loadKeystore,
  saveKeystore,
  clearKeystore,
  hasKeystore,
} from "@/lib/signer/keystore";
import type { PostingSigner } from "@/lib/types";

const DEV_CHOICE_KEY = "cogno.signer.devChoice";
const DEFAULT_DEV = "//Alice";
const KEYSTORE_LABEL = "keystore key";

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
  /** The mnemonic of a freshly created key, surfaced ONCE for backup (null otherwise). */
  sessionMnemonic: string | null;
  /** Dismiss the surfaced mnemonic once the user has backed it up. */
  ackSessionMnemonic: () => void;

  // ── keystore (M8) ──
  /** A keystore blob exists on this device (may be locked). */
  hasKeystore: boolean;
  /** The active signer IS the keystore key (i.e. unlocked this session). */
  keystoreUnlocked: boolean;
  /** Create a brand-new keystore key under a password; returns its mnemonic to back up once. */
  createKeystore: (password: string) => Promise<string | null>;
  /** Import an existing recovery phrase into the keystore under a password. */
  importKeystore: (mnemonic: string, password: string) => Promise<boolean>;
  /** Unlock the saved keystore with its password and become that key. */
  unlockKeystore: (password: string) => Promise<boolean>;
  /** Drop the in-memory keystore key (keep the ciphertext) — back to a dev account. */
  lockKeystore: () => void;
  /** Wipe the keystore ciphertext entirely. */
  forgetKeystore: () => void;
  /** Last keystore error (wrong password, invalid phrase, …). */
  keystoreError: string | null;
}

export function useSigner(): UseSigner {
  // Default deterministically to //Alice so SSR/first paint matches; the persisted choice and the
  // presence of a keystore are applied on the client after mount (avoids hydration mismatch).
  const [signer, setSigner] = useState<PostingSigner>(() => getDevSigner(DEFAULT_DEV));
  const [sessionMnemonic, setSessionMnemonic] = useState<string | null>(null);
  const [hasKs, setHasKs] = useState(false);
  const [keystoreError, setKeystoreError] = useState<string | null>(null);

  const appliedChoice = useRef(false);
  useEffect(() => {
    if (appliedChoice.current) return;
    appliedChoice.current = true;
    setHasKs(hasKeystore());
    const choice = readDevChoice();
    if (choice !== DEFAULT_DEV) setSigner(getDevSigner(choice));
  }, []);

  const setDevAccount = useCallback((uri: string) => {
    setSessionMnemonic(null);
    setKeystoreError(null);
    setSigner(getDevSigner(uri));
    writeDevChoice(uri);
  }, []);

  const useSessionKey = useCallback(() => {
    setKeystoreError(null);
    const { signer: s, mnemonic } = generateSessionSigner();
    setSigner(s);
    setSessionMnemonic(mnemonic);
  }, []);

  const ackSessionMnemonic = useCallback(() => setSessionMnemonic(null), []);

  const createKeystore = useCallback(async (password: string): Promise<string | null> => {
    setKeystoreError(null);
    try {
      const mnemonic = freshMnemonic();
      const s = signerFromMnemonic(mnemonic, { label: KEYSTORE_LABEL, kind: "keystore" });
      saveKeystore(await encryptMnemonic(mnemonic, password, KEYSTORE_LABEL));
      setHasKs(true);
      setSigner(s);
      return mnemonic;
    } catch (e) {
      setKeystoreError(e instanceof Error ? e.message : "could not create the keystore");
      return null;
    }
  }, []);

  const importKeystore = useCallback(async (mnemonic: string, password: string): Promise<boolean> => {
    setKeystoreError(null);
    let s: PostingSigner;
    try {
      s = signerFromMnemonic(mnemonic, { label: KEYSTORE_LABEL, kind: "keystore" });
    } catch {
      setKeystoreError("that does not look like a valid recovery phrase");
      return false;
    }
    try {
      saveKeystore(await encryptMnemonic(mnemonic.trim(), password, KEYSTORE_LABEL));
      setHasKs(true);
      setSigner(s);
      return true;
    } catch (e) {
      setKeystoreError(e instanceof Error ? e.message : "could not save the keystore");
      return false;
    }
  }, []);

  const unlockKeystore = useCallback(async (password: string): Promise<boolean> => {
    setKeystoreError(null);
    const blob = loadKeystore();
    if (!blob) {
      setKeystoreError("no keystore on this device to unlock");
      return false;
    }
    try {
      const mnemonic = await decryptMnemonic(blob, password);
      setSigner(signerFromMnemonic(mnemonic, { label: KEYSTORE_LABEL, kind: "keystore" }));
      return true;
    } catch (e) {
      setKeystoreError(e instanceof Error ? e.message : "unlock failed");
      return false;
    }
  }, []);

  const lockKeystore = useCallback(() => {
    setKeystoreError(null);
    setSigner(getDevSigner(readDevChoice()));
  }, []);

  const forgetKeystore = useCallback(() => {
    clearKeystore();
    setHasKs(false);
    setKeystoreError(null);
    setSigner(getDevSigner(readDevChoice()));
  }, []);

  return {
    signer,
    devAccounts: DEV_ACCOUNTS,
    setDevAccount,
    useSessionKey,
    sessionMnemonic,
    ackSessionMnemonic,
    hasKeystore: hasKs,
    keystoreUnlocked: signer.kind === "keystore",
    createKeystore,
    importKeystore,
    unlockKeystore,
    lockKeystore,
    forgetKeystore,
    keystoreError,
  };
}
