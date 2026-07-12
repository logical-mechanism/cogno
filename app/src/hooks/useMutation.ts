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
import { useSession } from "@/components/Providers";
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
  /**
   * Fired once if the run is still UNSETTLED when the hook unmounts (e.g. the card navigated away
   * mid-flight). Use it to silently roll back an optimistic overlay — do NOT reuse onError, which
   * would raise a spurious failure toast for a tx that may still land.
   */
  onCancel?: () => void;
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
  const { boot } = useSession();
  const [phase, setPhase] = useState<MutationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const subs = useRef<Set<{ sub: Subscription; cancel: () => void }>>(new Set());

  // Tear down any live subscriptions on unmount (a tx stream outliving the component is a leak). Each
  // still-unsettled run's cancel() runs first so the caller can silently roll its optimistic overlay
  // back — otherwise a provider-scoped patch outlives the page-scoped hook and sticks forever.
  useEffect(() => {
    const set = subs.current;
    return () => {
      set.forEach((e) => {
        e.cancel();
        e.sub.unsubscribe();
      });
      set.clear();
    };
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setPending(false);
  }, []);

  const run = useCallback((stream$: Observable<TxUpdate>, opts?: RunOptions): Promise<TxUpdate> => {
    // ENCODING GUARD. Every write in the app funnels through here, which is why the gate lives here:
    // if the connected node's runtime does not match the spec our PAPI descriptors were built against,
    // the extrinsic we are about to sign is mis-encoded. The boot guard has always computed this and
    // its reason string has always said "Posting is blocked to avoid mis-encoding" — but its only
    // enforcer was useSubmit, which had ZERO importers, so nothing was ever blocked.
    //
    // `=== false`, not `!== true`: `boot` is null while the probe is still in flight, and treating that
    // as a failure would make the app read-only for the first moments of every session.
    if (boot?.ok === false) {
      const message = boot.reason ?? "This app is not compatible with the connected node.";
      setPhase("error");
      setError(message);
      opts?.onError?.(message);
      return Promise.reject(new Error(message));
    }
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
        // Guard FIRST: a late invalid/error (or observable error) after inBestBlock already settled
        // must not flip a confirmed tx's phase to "error".
        if (settled) return;
        settled = true;
        setPhase("error");
        setError(message);
        setPending(false);
        opts?.onError?.(message);
        reject(new Error(message));
      };
      // `entry` is captured by complete() below; declared with `let` before subscribe() so a
      // (theoretical) synchronous complete sees `undefined` (a harmless delete) rather than a TDZ throw.
      let entry: { sub: Subscription; cancel: () => void } | undefined;
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
          if (entry) subs.current.delete(entry);
        },
      });
      entry = {
        sub,
        cancel: () => {
          if (settled) return;
          settled = true;
          setPending(false);
          opts?.onCancel?.();
        },
      };
      subs.current.add(entry);
    });
  }, [boot]);

  return { phase, error, pending, run, reset };
}
