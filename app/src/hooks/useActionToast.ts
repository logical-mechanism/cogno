"use client";

// useActionToast — the toast policy for optimistic write actions, in ONE place so every hook
// (follow / vote / repost / …) words feedback identically. A CheckCapacity pool rejection becomes the
// dedicated rate-limit toast; anything else is a generic error toast. `ok` is for the few DISCRETE
// successes worth confirming (follow / unfollow / repost) — high-frequency actions like votes stay
// silent on success because the optimistic UI already showed the change (doc 04 §3.4).
//
// `phase` is the tx-lifecycle variant used by the compose writes (post / reply / quote / repost /
// poll): a sticky "…ing" pending toast on submit that UPGRADES in place (dedupe-by-id) to a success
// toast — optionally carrying a "View →" action — at inBestBlock, or is dismissed + routed through
// `fail` on error. It returns a RunOptions object to spread straight into useMutation.run so the
// caller composes its own optimistic bookkeeping through the onConfirm/onError/onCancel hooks.

import { useCallback } from "react";
import { useToaster } from "@/components/toast/ToasterProvider";
import type { RunOptions } from "./useMutation";
import type { TxUpdate } from "@/lib/types";

/** A CheckCapacity pool rejection ⇒ the rate-limit toast, not the generic error. */
function isRateLimit(message: string): boolean {
  return /rate limit|ExhaustsResources/i.test(message);
}

/** Optional CTA on the success toast (e.g. "View →" the just-created post). */
export type ToastAction = { label: string; onClick: () => void };

export interface PhaseToastOptions {
  /** Dedupe key for the sticky→success upgrade — use the optimistic clientId (or `repost-<id>`). */
  id: string;
  /** Sticky pending copy shown on submit, e.g. "Quoting…". */
  pending: string;
  /** Success copy shown at inBestBlock, e.g. "Quoted". A check icon is added by the toast kind. */
  success: string;
  /** Build the success toast's action from the confirming update (its `postId`); omit for no CTA. */
  view?: (u: TxUpdate) => ToastAction | undefined;
  /** Success auto-dismiss (ms); default 4000. */
  successMs?: number;
  /** Caller bookkeeping composed after the success toast fires (drop/keep the optimistic card). */
  onConfirm?: (u: TxUpdate) => void;
  /** Caller rollback composed after the pending toast is dismissed + the failure surfaced. */
  onError?: (message: string) => void;
  /** Caller rollback composed after the pending toast is dismissed (run still unsettled at unmount). */
  onCancel?: () => void;
}

export interface ActionToast {
  /** Toast a settle failure (rate-limit gets its dedicated toast; everything else a generic error). */
  fail: (message: string) => void;
  /** Toast a discrete success — skip for high-frequency actions (votes). */
  ok: (message: string) => void;
  /**
   * Sticky "…ing" → in-place success (with optional "View →") / dismiss + `fail` on error. Fires the
   * pending toast immediately and returns the RunOptions to spread into useMutation.run.
   */
  phase: (opts: PhaseToastOptions) => RunOptions;
}

export function useActionToast(): ActionToast {
  const { toast, dismiss, rateLimit } = useToaster();
  const fail = useCallback(
    (message: string) => {
      if (isRateLimit(message)) rateLimit();
      else toast({ kind: "error", message });
    },
    [toast, rateLimit],
  );
  const ok = useCallback((message: string) => toast({ kind: "success", message }), [toast]);

  const phase = useCallback(
    (opts: PhaseToastOptions): RunOptions => {
      const tid = `phase-${opts.id}`;
      // Sticky pending shows the moment the write is submitted.
      toast({ id: tid, kind: "pending", message: opts.pending });
      return {
        onConfirm: (u) => {
          // Upgrade the same toast in place (dedupe-by-id) → success + optional "View →", auto-dismiss.
          toast({
            id: tid,
            kind: "success",
            message: opts.success,
            action: opts.view?.(u),
            duration: opts.successMs ?? 4000,
          });
          opts.onConfirm?.(u);
        },
        onError: (message) => {
          // Clear the sticky pending, then reuse fail() (rate-limit vs generic) before the caller rolls back.
          dismiss(tid);
          fail(message);
          opts.onError?.(message);
        },
        onCancel: () => {
          // Unmounted mid-flight: drop the sticky pending so it can't outlive its surface in the app-wide bus.
          dismiss(tid);
          opts.onCancel?.();
        },
      };
    },
    [toast, dismiss, fail],
  );

  return { fail, ok, phase };
}
