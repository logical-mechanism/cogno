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

  // Re-entrancy guard for a tx run. MUST NOT live inside a setState updater: React StrictMode
  // double-invokes updater functions in dev, so launching the wallet interaction from there fired
  // the tx twice — the second collided with the still-open wallet prompt and threw a spurious
  // "user declined". A plain ref keeps the guard in the event-handler body (not double-invoked).
  const inFlight = useRef(false);

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

  const run = useCallback(
    (action: () => Promise<{ txHash: string; info: VaultInfo }>, walletId: string) => {
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
          // the lock/exit takes a few blocks to settle; re-read the vault then.
          setTimeout(() => inspect(walletId), 5000);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        } finally {
          setStep("idle");
          inFlight.current = false;
        }
      })();
    },
    [inspect],
  );

  const lock = useCallback(
    (walletId: string, lovelace?: bigint) => {
      setLastAction("lock");
      run(() => lockIntoVault(walletId, lovelace, (p) => setStep(p)), walletId);
    },
    [run],
  );
  const exit = useCallback(
    (walletId: string) => {
      setLastAction("exit");
      run(() => exitVault(walletId, (p) => setStep(p)), walletId);
    },
    [run],
  );
  const reset = useCallback(() => {
    setPhase("idle");
    setStep("idle");
    setError(null);
    setTxHash(null);
    setLastAction(null);
    inFlight.current = false;
  }, []);

  return { available, phase, step, busy, error, txHash, lastAction, info, locked, lockedKnown, inspect, lock, exit, reset };
}
