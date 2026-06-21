"use client";

// useMutation — the generic write adapter every optimistic social hook composes on. It
// subscribes to a `TxUpdate` phase stream (from lib/chain/mutations.ts), tracks the phase
// reactively, and returns a Promise that RESOLVES at `inBestBlock` (the optimistic confirm
// point — Twitter-speed) and REJECTS on `invalid` / `error` (so the caller rolls back).
//
// Toast policy (doc 04 §3.4): feeless social actions are SILENT on success (the optimistic UI
// already showed the heart fill — we never toast "Liked!"). We surface ONLY failures. The
// caller decides whether to toast a confirm (e.g. profile edits close a modal on success).

import { useCallback, useEffect, useRef, useState } from "react";
import type { Observable, Subscription } from "rxjs";
import type { TxUpdate } from "@/lib/types";

export type MutationPhase =
  | "idle"
  | "signing"
  | "broadcast"
  | "inBestBlock"
  | "finalized"
  | "error";

export interface RunOptions {
  /** Fired once at `inBestBlock` (ok) — the confirm point. */
  onConfirm?: (u: TxUpdate) => void;
  /** Fired once on `invalid` / `error` with the friendly message. */
  onError?: (message: string) => void;
}

export interface UseMutation {
  phase: MutationPhase;
  error: string | null;
  /** true between `run()` and the settle (confirm or error). */
  pending: boolean;
  /**
   * Subscribe a `TxUpdate` stream. Resolves with the confirming update at `inBestBlock`,
   * rejects with an Error on `invalid` / `error` / stream error. Continues tracking the phase
   * through `finalized` after resolving.
   */
  run: (stream$: Observable<TxUpdate>, opts?: RunOptions) => Promise<TxUpdate>;
  reset: () => void;
}

export function useMutation(): UseMutation {
  const [phase, setPhase] = useState<MutationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const subs = useRef<Set<Subscription>>(new Set());

  // Tear down any live subscriptions on unmount (a tx stream outliving the component is a leak).
  useEffect(() => {
    const set = subs.current;
    return () => {
      set.forEach((s) => s.unsubscribe());
      set.clear();
    };
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setPending(false);
  }, []);

  const run = useCallback((stream$: Observable<TxUpdate>, opts?: RunOptions): Promise<TxUpdate> => {
    setError(null);
    setPending(true);
    setPhase("signing");
    return new Promise<TxUpdate>((resolve, reject) => {
      let settled = false;
      const settleOk = (u: TxUpdate) => {
        if (settled) return;
        settled = true;
        setPending(false);
        opts?.onConfirm?.(u);
        resolve(u);
      };
      const settleErr = (message: string) => {
        setPhase("error");
        setError(message);
        if (settled) return;
        settled = true;
        setPending(false);
        opts?.onError?.(message);
        reject(new Error(message));
      };
      const sub = stream$.subscribe({
        next: (u) => {
          switch (u.phase) {
            case "signing":
              setPhase("signing");
              break;
            case "broadcast":
              setPhase("broadcast");
              break;
            case "inBestBlock":
              setPhase("inBestBlock");
              settleOk(u);
              break;
            case "finalized":
              setPhase("finalized");
              break;
            case "invalid":
            case "error":
              settleErr(u.error ?? "Transaction failed.");
              break;
          }
        },
        error: (e: unknown) => {
          settleErr(e instanceof Error ? e.message : String(e));
        },
        complete: () => {
          subs.current.delete(sub);
        },
      });
      subs.current.add(sub);
    });
  }, []);

  return { phase, error, pending, run, reset };
}
