"use client";

// useMutation — the generic write adapter every optimistic social hook composes on. It subscribes to a
// `TxUpdate` phase stream (from lib/chain/mutations.ts) and delivers the outcome through the
// onConfirm / onError / onCancel callbacks.
//
// The returned promise SETTLES (never rejects) once the run reaches any terminal state. "Settled" means
// the outcome has been delivered to your callbacks — NOT that it succeeded. Do not branch on it; there
// is nothing in it to branch on. It exists so a caller can `void run(...)` without an unhandled
// rejection, which is all any of the twelve call sites ever wanted: every one of them was
// `void run(...).catch(() => {})`, twelve copies of "please don't crash the tab".
//
// It used to REJECT on failure, and it used to track the tx `phase` reactively. Nothing consumed the
// phase — every call site destructured `{ run }` or `{ run, pending }` — but `setPhase` fired on each
// stream event, and `useVote` mounts inside the component that owns the timeline, so a single like
// re-rendered the whole 50-card feed several times over to store a string nobody read.
//
// This hook no longer tracks a reactive `pending` flag: every call site now derives its own in-flight
// state (useAccountVote → intent.inFlight, the composers → their optimistic ActionState), so a `pending`
// here had no consumer and only added re-renders. It is gone; callers destructure `{ run }`.
//
// Toast policy: feeless social actions are SILENT on success (the optimistic UI already
// showed the heart fill — we never toast "Liked!"). We surface ONLY failures. The caller decides
// whether to toast a confirm (e.g. profile edits close a modal on success).

import { useCallback, useEffect, useRef } from "react";
import type { Observable, Subscription } from "rxjs";
import { useSession } from "@/components/Providers";
import { classifyThrown, type ChainError } from "@/lib/chain/errors";
import type { TxUpdate } from "@/lib/types";

export interface RunOptions {
  /** Fired once at `inBestBlock` (ok) — the confirm point. */
  onConfirm?: (u: TxUpdate) => void;
  /** Fired once on `invalid` / `error` with the CLASSIFIED failure (branch on `.kind`, render with `errorCopy`). */
  onError?: (error: ChainError) => void;
  /**
   * Fired once if the run is still UNSETTLED when the hook unmounts (e.g. the card navigated away
   * mid-flight). Use it to silently roll back an optimistic overlay — do NOT reuse onError, which
   * would raise a spurious failure toast for a tx that may still land.
   */
  onCancel?: () => void;
}

export interface UseMutation {
  /**
   * Subscribe a `TxUpdate` stream. The outcome arrives via `opts` — onConfirm at `inBestBlock`,
   * onError on `invalid`/`error`, onCancel if the hook unmounts still in flight.
   *
   * The promise resolves when the run has SETTLED, whichever way. It never rejects, and it carries no
   * value: resolution does NOT mean success. Await it only to sequence work after the run is over.
   */
  run: (stream$: Observable<TxUpdate>, opts?: RunOptions) => Promise<void>;
}

export function useMutation(): UseMutation {
  const { boot } = useSession();
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

  const run = useCallback((stream$: Observable<TxUpdate>, opts?: RunOptions): Promise<void> => {
    // ENCODING GUARD. Every write in the app funnels through here, which is why the gate lives here:
    // if the connected node's runtime does not match the spec our PAPI descriptors were built against,
    // the extrinsic we are about to sign is mis-encoded. The boot guard has always computed this and
    // its reason string has always said "Posting is blocked to avoid mis-encoding" — but its only
    // enforcer was useSubmit, which had ZERO importers, so nothing was ever blocked.
    //
    // `=== false`, not `!== true`: `boot` is null while the probe is still in flight, and treating that
    // as a failure would make the app read-only for the first moments of every session.
    if (boot?.ok === false) {
      // `raw`, never a classified kind: this must NEVER be mistakable for a rate limit (see
      // lib/chain/errors.ts). This path SETTLES like any other — it used to reject, and it is a second,
      // separate rejection path from settleErr, so a conversion that only fixed settleErr would have
      // turned every write on an incompatible node into an unhandled rejection.
      const error: ChainError = {
        kind: "raw",
        detail: boot.reason ?? "This app is not compatible with the connected node.",
      };
      opts?.onError?.(error);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const settleOk = (u: TxUpdate) => {
        if (settled) return;
        settled = true;
        opts?.onConfirm?.(u);
        resolve();
      };
      const settleErr = (error: ChainError) => {
        // Guard FIRST: a late invalid/error (or observable error) after inBestBlock already settled
        // must not flip a confirmed tx to failed.
        if (settled) return;
        settled = true;
        opts?.onError?.(error);
        resolve();
      };
      // `entry` is captured by complete() below; declared with `let` before subscribe() so a
      // (theoretical) synchronous complete sees `undefined` (a harmless delete) rather than a TDZ throw.
      let entry: { sub: Subscription; cancel: () => void } | undefined;
      const sub = stream$.subscribe({
        next: (u) => {
          switch (u.phase) {
            case "inBestBlock":
              settleOk(u);
              break;
            case "invalid":
            case "error":
              settleErr(u.error ?? { kind: "raw", detail: "Transaction failed." });
              break;
            // "signing" / "broadcast" / "finalized" are not ignored — they are simply not OURS to
            // react to. The subscription must stay open through them so complete() fires and removes
            // this entry from subs.current; short-circuiting at inBestBlock leaks it until unmount.
            default:
              break;
          }
        },
        error: (e: unknown) => {
          settleErr(classifyThrown(e));
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
          opts?.onCancel?.();
          // Settle here too. This path used to flip `settled` and call onCancel WITHOUT resolving, so
          // the promise dangled forever on unmount-mid-flight. Harmless while every caller ignored it;
          // a lie the moment anyone awaits it.
          resolve();
        },
      };
      subs.current.add(entry);
    });
  }, [boot]);

  return { run };
}
