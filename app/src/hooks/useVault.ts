"use client";

// useVault — the L1 vault lock/exit state for a connected Cardano wallet (M8). Locking ADA at the
// talk_vault mints the owner's beacon; the app-chain's consensus observer then reads it (once it is
// older than the stability window) and credits the bound account its talk-capacity weight. So a
// successful lock here is "submitted", NOT "you can post now": capacity appears after the observed
// Cardano frontier passes the lock's slot (see usePendingCapacity, which narrates that wait).
//
// Purely Cardano-side — it needs no chain api. The wallet id comes from the wallet picker in the UI.
// `lastAction` lets a caller persist a pending-lock record on a lock (and clear it on an exit).

import { useCallback, useEffect, useRef, useState } from "react";
import { lockIntoVault, exitVault, fetchVaultState, type VaultInfo } from "@/lib/cardano/vault";
import { hasCardanoProvider } from "@/lib/cardano/provider";
import { isUserRejection } from "@/lib/cardano/cip8";

export type VaultPhase = "idle" | "working" | "submitted" | "error";

/** Which action produced the current tx state — so a caller can tell a lock (start crediting) from an
 *  exit (stop crediting) when reacting to `phase === "submitted"`. */
export type VaultAction = "lock" | "exit";

/** The fine-grained sub-phase of the in-flight `working` tx, for a live step indicator. `preparing`
 *  = building the tx (wallet enable + UTxO fetch + script eval), then the wallet sign, then the
 *  Cardano submit. `idle` when no tx is in flight. */
export type VaultStep = "idle" | "preparing" | "signing" | "submitting";

export interface UseVault {
  /** a Cardano provider (Blockfrost) is configured ⇒ the lock/exit actions are usable. */
  available: boolean;
  phase: VaultPhase;
  /** the in-flight sub-phase while `phase === "working"` (drives the step indicator). */
  step: VaultStep;
  busy: boolean;
  error: string | null;
  txHash: string | null;
  /** which action produced the current `txHash`/phase (`lock` vs `exit`), or null when idle. */
  lastAction: VaultAction | null;
  /** the resolved owner/vault for the connected wallet (address, beacon, …). */
  info: VaultInfo | null;
  /** lovelace currently locked (null = none), once inspected. */
  locked: bigint | null;
  lockedKnown: boolean;
  /** True only during the post-submit confirm poll — drives the "Confirming…" UI without leaning on the
   *  sticky `submitted` phase (which never clears). */
  confirming: boolean;
  /** resolve the vault state for a wallet without sending a tx. */
  inspect: (walletId: string) => void;
  lock: (walletId: string, lovelace?: bigint) => void;
  exit: (walletId: string) => void;
  reset: () => void;
}

export function useVault(): UseVault {
  // Computed after mount to avoid an SSR/first-paint hydration mismatch (it reads localStorage/env).
  const [available, setAvailable] = useState(false);
  useEffect(() => setAvailable(hasCardanoProvider()), []);

  const [phase, setPhase] = useState<VaultPhase>("idle");
  const [step, setStep] = useState<VaultStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<VaultAction | null>(null);
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [locked, setLocked] = useState<bigint | null>(null);
  const [lockedKnown, setLockedKnown] = useState(false);
  // True only while pollUntilSettled is actively re-reading after a submit (the confirm window), so the UI
  // can show "Confirming…" for exactly that span. Deliberately NOT derived from `phase === "submitted"`,
  // which never resets — that left the card frozen on "Confirming exit…" long after the exit had landed.
  const [confirming, setConfirming] = useState(false);

  // Re-entrancy guard for a tx run. MUST NOT live inside a setState updater: React StrictMode
  // double-invokes updater functions in dev, so launching the wallet interaction from there fired
  // the tx twice — the second collided with the still-open wallet prompt and threw a spurious
  // "user declined". A plain ref keeps the guard in the event-handler body (not double-invoked).
  const inFlight = useRef(false);
  // Bounded re-read poll after a submit (see pollUntilSettled). Cleared on unmount / reset / a new run.
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTries = useRef(0);

  const busy = phase === "working";

  const inspect = useCallback((walletId: string) => {
    setError(null);
    void (async () => {
      try {
        const res = await fetchVaultState(walletId);
        setInfo(res.info);
        setLocked(res.locked);
        setLockedKnown(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const clearPoll = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    pollTries.current = 0;
    setConfirming(false);
  }, []);
  // Clear any in-flight poll on unmount so it can't set state on a gone component.
  useEffect(() => clearPoll, [clearPoll]);

  // Re-read the vault until it reflects the submitted action, then stop. A lock/exit confirms on Cardano
  // over several blocks (~20–60s on preprod); the old single 5s re-read almost always fired too early and
  // left the card stale — still "No vault yet" after a lock (with a LIVE Lock button, inviting a duplicate
  // 100-ADA lock) or still "100 ADA locked" after an exit. Bounded so a never-confirming tx can't poll
  // forever; early-exit the instant the state matches so we don't hammer Blockfrost.
  const POLL_EVERY_MS = 6000;
  const POLL_MAX = 10; // ~60s of coverage
  const pollUntilSettled = useCallback(
    (walletId: string, kind: VaultAction) => {
      clearPoll();
      setConfirming(true);
      const settled = (l: bigint | null) =>
        kind === "lock" ? l != null && l > 0n : l == null || l === 0n;
      const tick = () => {
        pollTries.current += 1;
        void (async () => {
          try {
            const res = await fetchVaultState(walletId);
            setInfo(res.info);
            setLocked(res.locked);
            setLockedKnown(true);
            if (settled(res.locked)) return clearPoll();
          } catch {
            /* transient read failure — keep polling within the budget */
          }
          if (pollTries.current < POLL_MAX) pollTimer.current = setTimeout(tick, POLL_EVERY_MS);
          else clearPoll();
        })();
      };
      pollTimer.current = setTimeout(tick, POLL_EVERY_MS);
    },
    [clearPoll],
  );

  const run = useCallback(
    (action: () => Promise<{ txHash: string; info: VaultInfo }>, walletId: string, kind: VaultAction) => {
      if (inFlight.current) return; // already running (double-click / re-render); never start twice
      inFlight.current = true;
      setError(null);
      setTxHash(null);
      setStep("preparing");
      setPhase("working");
      void (async () => {
        try {
          const res = await action();
          setInfo(res.info);
          setTxHash(res.txHash);
          setPhase("submitted");
          // Re-read until the vault reflects this action (bounded); keeps the card + buttons truthful.
          pollUntilSettled(walletId, kind);
        } catch (e) {
          // A user-declined wallet prompt is an expected cancel, not a failure: return to idle so the
          // user can just try again — no red "error" wall (matches the connect + CIP-8 bind flows). A
          // genuine failure still surfaces as phase="error" with the message.
          if (isUserRejection(e)) {
            setPhase("idle");
          } else {
            setError(e instanceof Error ? e.message : String(e));
            setPhase("error");
          }
        } finally {
          setStep("idle");
          inFlight.current = false;
        }
      })();
    },
    [pollUntilSettled],
  );

  const lock = useCallback(
    (walletId: string, lovelace?: bigint) => {
      setLastAction("lock");
      run(() => lockIntoVault(walletId, lovelace, (p) => setStep(p)), walletId, "lock");
    },
    [run],
  );
  const exit = useCallback(
    (walletId: string) => {
      setLastAction("exit");
      run(() => exitVault(walletId, (p) => setStep(p)), walletId, "exit");
    },
    [run],
  );
  const reset = useCallback(() => {
    clearPoll();
    setPhase("idle");
    setStep("idle");
    setError(null);
    setTxHash(null);
    setLastAction(null);
    inFlight.current = false;
  }, [clearPoll]);

  return { available, phase, step, busy, error, txHash, lastAction, info, locked, lockedKnown, confirming, inspect, lock, exit, reset };
}
