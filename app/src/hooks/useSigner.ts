"use client";

// useSigner — the active posting key in React state.
//
// PRODUCT FLOW: the posting key is DERIVED from the connected Cardano wallet's signature
// (lib/signer/wallet-derive.ts) — no password, no second wallet, and the SECRET is never stored.
// `connectWallet` signs the fixed derive-message and becomes that key.
//
// A REFRESH NO LONGER LOGS YOU OUT. What survives is the public half only — which account you are
// (lib/sessionRestore.ts: ss58, public key, wallet id, wallet address). That is enough for every READ
// and for every device-local store to find its ss58-keyed bucket, so a reload lands you back on the
// same page as yourself with your bookmarks, mutes and block list intact and no wallet popup. It is not
// enough to SIGN: the restored signer derives the seed lazily, so the first write opens exactly one
// sign prompt and then promotes the session to a normal derived one. The COSE signature and its
// blake2b_256 seed are still never written anywhere — see the header on lib/sessionRestore.ts for why
// that line is where it is.
//
// ADVANCED (hidden behind a toggle): the well-known dev accounts (//Alice…), for testing / operator
// use without a wallet. The dev choice is NOT persisted — it is re-selected each session.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEV_ACCOUNTS, getDevSigner, signerFromRestored } from "@/lib/signer";
import { deriveSignerFromWallet } from "@/lib/signer/wallet-derive";
import { isUserRejection, probeWalletIdentity } from "@/lib/cardano/cip8";
import { clearPostDraft } from "@/lib/composerDraftStore";
import { recentSearchActions } from "@/lib/recentSearchStore";
import { clearFeedSnapshot } from "@/lib/feed/snapshot";
import {
  clearRestoredSession,
  saveRestoredSession,
  useHydrated,
  useRestoredSession,
  type RestoredSession,
} from "@/lib/sessionRestore";
import type { PostingSigner } from "@/lib/types";

const DEFAULT_DEV = "//Alice";

/** How long the auth wall waits on the no-popup identity probe before treating it as inconclusive. */
const PROBE_TIMEOUT_MS = 3_000;

export interface UseSigner {
  /** The currently active posting signer (a wallet-derived key, a restored session, or a dev account). */
  signer: PostingSigner;
  /** The active posting key can sign RIGHT NOW (a seed is in memory). False for a restored session. */
  canSign: boolean;
  /**
   * The active posting key is a wallet-derived key with its SEED IN MEMORY.
   *
   * Narrower than it used to be: a restored session is backed by the same wallet but is not
   * `walletConnected`, because it cannot sign until it unlocks. Most callers asking "is a Cardano
   * wallet behind this session?" want {@link UseSigner.walletSession} instead — this one means
   * "can sign right now", and getting the two confused makes a surface tell a returning user to
   * connect a wallet they are already connected to.
   */
  walletConnected: boolean;
  /**
   * A Cardano wallet backs this session — derived OR restored. This is the gate for anything the
   * WALLET does rather than the posting key: the vault lock/exit (which uses `wallet.signTx`, a
   * Cardano key the posting seed cannot produce), the CIP-8 binds and role claims (bare unsigned
   * extrinsics that need no posting key at all), and any surface that just displays the connection.
   */
  walletSession: boolean;
  /** Posting is enabled: a wallet is connected or restored, OR a dev account was chosen (advanced). */
  postingEnabled: boolean;
  /**
   * The session was rebuilt from the device-local record and has no seed yet: reads are fully live, and
   * the first write will ask for one signature. Drives the "Sign to post" chip.
   */
  restored: boolean;
  /**
   * The restore is still being decided (the hydration render, or the wallet probe is in flight). The
   * auth wall MUST wait on this — otherwise it redirects to /welcome before the session comes back.
   */
  restoring: boolean;
  /** The Cardano wallet id the posting key was derived from (drives bind + vault lock/exit). */
  connectedWalletId: string | null;
  /** The connected wallet address (its identity/stake key). */
  walletAddress: string | null;
  /**
   * A fresh CONNECT is in flight — there is no active identity yet and the app is waiting on a wallet
   * signature to mint one. `deriveSessionState` reads this as "connecting", which collapses
   * `viewer.status` to "not-connected", so it must NEVER be raised for a session that already knows
   * who it is. See {@link UseSigner.unlocking}.
   */
  deriving: boolean;
  /**
   * An UNLOCK is in flight: a restored session already has its identity and is re-deriving the seed so
   * it can sign. Deliberately a separate flag from {@link UseSigner.deriving} — sharing one collapsed
   * `sessionState` to "connecting" mid-prompt, which made the auth wall redirect the user to /welcome
   * while their wallet popup was still open, and made the account chip's own "Check your wallet…"
   * label unreachable.
   */
  unlocking: boolean;
  error: string | null;
  /** Connect a CIP-30 wallet and derive the posting key from its signature. */
  connectWallet: (walletId: string) => Promise<boolean>;
  /**
   * Re-derive the seed for a RESTORED session (one wallet prompt) and promote it to a normal derived
   * session. Idempotent and single-flight; a no-op that resolves immediately when a seed is already in
   * memory. The restored signer calls this itself at signing time, so a write path never has to.
   */
  unlock: () => Promise<PostingSigner>;
  /** Sign out: drop the key AND forget which account this device was signed in as. */
  disconnect: () => void;

  // ── advanced / dev (hidden behind a toggle) ──
  devAccounts: readonly string[];
  setDevAccount: (uri: string) => void;
}

export function useSigner(): UseSigner {
  // An EXPLICIT choice this session — a fresh wallet connect, an unlock, or a dev account. Null means
  // "nothing chosen", which is when the restored record (if any) applies. Keeping the choice and the
  // restore in separate slots is what lets the restored signer be derived during RENDER (below) rather
  // than installed by an effect: an effect here belongs to an ANCESTOR fiber of AppShell, so it runs
  // AFTER the auth wall's effect has already redirected to /welcome and rewritten the URL.
  const [chosen, setChosen] = useState<PostingSigner | null>(null);
  const [connectedWalletId, setConnectedWalletId] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  // Kept apart from `deriving` deliberately — see the doc on UseSigner.unlocking. `deriving` feeds
  // deriveSessionState, so raising it for a session that already has an identity would report the user
  // as "not connected" for the duration of their own wallet prompt.
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The default //Alice is a BACKGROUND signer, not an active identity: posting stays disabled
  // until the user connects a wallet, has a restored session, or explicitly chooses a dev account.
  const [devChosen, setDevChosen] = useState(false);

  // The remembered account. `null` on the hydration render (see useRestoredSession) — which is why
  // `hydrated` is read separately: null-before-hydration means "not known yet", not "signed out".
  const record = useRestoredSession();
  const hydrated = useHydrated();
  // The probe verdict for the current record.
  //   pending  — not answered yet; the auth wall waits (bounded, see PROBE_TIMEOUT_MS)
  //   settled  — either confirmed this account, or INCONCLUSIVE (wallet locked / gone / grant lapsed).
  //              Inconclusive keeps the restored session: signing someone out because their wallet
  //              auto-locked would be a worse bug than the one this fixes, and the unlock re-checks
  //              for real anyway (it compares the DERIVED ss58, the authoritative answer).
  //   mismatch — the wallet answered and it is a different account, or the wrong network. Conclusive.
  const [probeState, setProbeState] = useState<"pending" | "settled" | "mismatch">("pending");

  // Monotonic "derive generation". A CIP-30 signData() has no abort handle, so Cancel/disconnect can't
  // stop an in-flight wallet prompt — but it CAN abandon it: bumping this invalidates the pending
  // derive so its late (or never-arriving) result is ignored and the spinner is released immediately.
  // Without this, a dismissed-but-unsettled wallet popup wedges `deriving` true forever (dead Cancel).
  const deriveGen = useRef(0);

  // ── the restored (seedless) signer ─────────────────────────────────────────────────────────────
  // The lazy `unlock` the restored signer closes over must not change identity when this hook
  // re-renders (that would rebuild the signer and re-key every [signer.ss58] effect in the app), so it
  // reads through a ref that the real implementation below fills in.
  const unlockRef = useRef<() => Promise<PostingSigner>>(() =>
    Promise.reject(new Error("no session to unlock")),
  );
  const unlockThroughRef = useCallback(() => unlockRef.current(), []);

  const restoredSigner = useMemo(
    () => (record && probeState !== "mismatch" ? signerFromRestored(record, unlockThroughRef) : null),
    [record, probeState, unlockThroughRef],
  );

  const fallback = useMemo(() => getDevSigner(DEFAULT_DEV), []);
  const signer = chosen ?? restoredSigner ?? fallback;

  // ── the no-popup identity probe ────────────────────────────────────────────────────────────────
  // A restored ss58 is a CACHED answer to "who is this wallet?", and a multi-account wallet can have
  // moved on. Ask (silently) and drop the record on a conclusive mismatch. Best-effort: an
  // `unavailable` verdict — extension gone, grant lapsed, wallet locked — is inconclusive and leaves
  // the restored session alone, because signing out a user because their wallet auto-locked would be a
  // worse bug than the one this fixes. See cip8.ts `probeWalletIdentity`.
  useEffect(() => {
    if (!record || chosen) return; // nothing to check, or an explicit choice already supersedes it
    let cancelled = false;
    // A locked wallet may show its unlock UI and never resolve `enable()` if the user ignores it. The
    // auth wall waits on `restoring`, so an unbounded probe would pin a returning user on the loading
    // screen with no escape — the same failure `useIdentity` time-boxes its bound read against. Settle
    // as inconclusive instead and let the session stand.
    const timer = setTimeout(() => {
      if (!cancelled) setProbeState((s) => (s === "pending" ? "settled" : s));
    }, PROBE_TIMEOUT_MS);
    void probeWalletIdentity(record.walletId).then((p) => {
      if (cancelled) return;
      const conclusiveMismatch =
        (p.ok && p.addressHex !== record.walletAddressHex) || (!p.ok && p.kind === "mismatch");
      if (conclusiveMismatch) {
        console.warn(
          `cogno: remembered session dropped — wallet "${record.walletId}" ${p.ok ? "is on a different account" : p.reason}`,
        );
        clearRestoredSession();
        setProbeState("mismatch");
        return;
      }
      setProbeState("settled");
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [record, chosen]);

  // Adopt the record's wallet id + address for the restored session, so bind / vault / role flows and
  // Settings → Account work after a refresh exactly as they do after a fresh connect.
  useEffect(() => {
    if (chosen || !record) return;
    setConnectedWalletId(record.walletId);
    setWalletAddress(record.walletAddress);
  }, [chosen, record]);

  const connectWallet = useCallback(async (walletId: string): Promise<boolean> => {
    const gen = ++deriveGen.current;
    setDeriving(true);
    setError(null);
    try {
      const { signer: s, signingAddress, signingAddressHex } = await deriveSignerFromWallet(walletId);
      if (deriveGen.current !== gen) return false; // cancelled mid-derive — drop the stale result
      setChosen(s);
      setDevChosen(false);
      setConnectedWalletId(walletId);
      setWalletAddress(signingAddress);
      setProbeState("settled");
      // Remember WHO, never the seed. This is what stops the next refresh from logging them out.
      saveRestoredSession({
        walletId,
        ss58: s.ss58,
        publicKeyHex: s.publicKeyHex,
        walletAddress: signingAddress,
        walletAddressHex: signingAddressHex,
      });
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

  // ── unlock: turn a restored session into a signing one ─────────────────────────────────────────
  // Single-flight through a ref-held promise, because a restored signer's signTx calls this — and a
  // burst of writes (a like plus a reply) must open ONE wallet prompt, not one each.
  const inFlightUnlock = useRef<Promise<PostingSigner> | null>(null);
  const unlock = useCallback(async (): Promise<PostingSigner> => {
    if (chosen) return chosen; // a seed is already in memory (fresh connect, dev account, or a prior unlock)
    if (inFlightUnlock.current) return inFlightUnlock.current;
    const rec: RestoredSession | null = record;
    if (!rec) throw new Error("no session to unlock. Connect your wallet");

    // The SAME abandonment generation `connectWallet` uses. A CIP-30 signData() has no abort handle,
    // so a sign-out during an unlock cannot stop the popup — but it must stop the popup's late
    // approval from silently reviving the session the user just ended. Without this guard, approving a
    // prompt after signing out re-ran setChosen + saveRestoredSession and wrote the record back.
    const gen = ++deriveGen.current;
    const run = (async () => {
      setUnlocking(true);
      setError(null);
      try {
        const { signer: s, signingAddress, signingAddressHex } = await deriveSignerFromWallet(rec.walletId);
        if (deriveGen.current !== gen) {
          // Abandoned mid-prompt (sign-out, or a fresh connect superseded this). Do not touch state,
          // and do not resurrect the record — but still reject, so the write that asked for the
          // signature fails cleanly instead of hanging on a promise that never settles.
          throw new Error("the session ended before the signature arrived");
        }
        // THE authoritative identity check. The probe is a cheap proxy; this is the real thing — if the
        // wallet has moved to a different account, the key we just derived does not match the account
        // the app has been rendering (and the tx it is about to sign was built for THAT account). Fail
        // closed and sign them out rather than sign with the wrong key.
        if (s.ss58 !== rec.ss58) {
          clearRestoredSession();
          setProbeState("mismatch");
          throw new Error(
            "this wallet is now on a different account. Sign in again to post from it",
          );
        }
        setChosen(s);
        setConnectedWalletId(rec.walletId);
        setWalletAddress(signingAddress);
        // Refresh the record: same account, but the address encoding/label may have been re-read.
        saveRestoredSession({
          walletId: rec.walletId,
          ss58: s.ss58,
          publicKeyHex: s.publicKeyHex,
          walletAddress: signingAddress,
          walletAddressHex: signingAddressHex,
        });
        return s;
      } catch (e) {
        if (!isUserRejection(e)) {
          console.error(`cogno: unlock("${rec.walletId}") failed:`, e);
        }
        // An abandoned unlock's error belongs to a session that no longer exists — surfacing it would
        // paint a failure on whatever the user did next.
        if (deriveGen.current === gen) setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        // Only the CURRENT unlock owns the spinner (same rule as connectWallet's).
        if (deriveGen.current === gen) setUnlocking(false);
        inFlightUnlock.current = null;
      }
    })();
    inFlightUnlock.current = run;
    return run;
  }, [chosen, record]);

  // Publish the real implementation to the ref the restored signer closes over. Assigned during render
  // (not in an effect) so a write dispatched on the very first post-hydration commit can already sign.
  unlockRef.current = unlock;

  const disconnect = useCallback(() => {
    deriveGen.current++; // abandon any in-flight derive/unlock so a late approval can't revive this session
    inFlightUnlock.current = null;
    setDeriving(false); // release the "Check your wallet" spinner immediately (makes Cancel actually work)
    setUnlocking(false);
    setConnectedWalletId(null);
    setWalletAddress(null);
    setError(null);
    setDevChosen(false);
    setChosen(null);
    setProbeState("pending");
    // This is what makes disconnect a real SIGN OUT rather than a lock: forget which account this
    // device was signed in as, so the next load is a clean guest session (and the ss58-keyed device
    // stores go back to their `anon` bucket instead of this account's).
    clearRestoredSession();
    // Device-local, identity-agnostic state that must not resurface for the NEXT account on a shared
    // device: the unsent post draft, the recent-search terms (the set stores are per-account, but
    // recent searches are a single device-global key, so clear them explicitly here), and the held feed
    // page — which is in memory only and viewer-keyed, but carries this account's `myVote` overlay, so
    // there is no reason to keep it alive after they sign out.
    clearPostDraft();
    recentSearchActions.clear();
    clearFeedSnapshot();
  }, []);

  const setDevAccount = useCallback((uri: string) => {
    setError(null);
    setConnectedWalletId(null);
    setWalletAddress(null);
    setDevChosen(true);
    setChosen(getDevSigner(uri));
  }, []);

  const walletConnected = signer.kind === "derived";
  const restored = signer.kind === "restored";
  // MEMOIZED — this object is the `signerCtl` field of the session context value, and a fresh literal
  // per render defeated that context's `useMemo` (see the note in useIdentity's return).
  return useMemo(
    () => ({
      signer,
      canSign: !restored,
      walletConnected,
      walletSession: walletConnected || restored,
      postingEnabled: walletConnected || restored || devChosen,
      restored,
      // Undecided while the client has not hydrated (no record can be known yet), and while a restored
      // session's probe is still out (bounded by PROBE_TIMEOUT_MS, so this always resolves). Not gated
      // on `deriving`: an unlock happens mid-session, long after the wall has stopped caring.
      restoring: !hydrated || (restored && probeState === "pending"),
      connectedWalletId,
      walletAddress,
      deriving,
      unlocking,
      error,
      connectWallet,
      unlock,
      disconnect,
      devAccounts: DEV_ACCOUNTS,
      setDevAccount,
    }),
    [
      signer,
      restored,
      walletConnected,
      devChosen,
      hydrated,
      probeState,
      connectedWalletId,
      walletAddress,
      deriving,
      unlocking,
      error,
      connectWallet,
      unlock,
      disconnect,
      setDevAccount,
    ],
  );
}
