"use client";

// useSubmit — turns the submitPost observable into a single React-friendly tx
// lifecycle. Tracks the latest TxUpdate, cancels any in-flight subscription when a
// new submit starts or on unmount, and is gated by the boot guard (a spec mismatch
// must block the WRITE path — reads stay live). There is no delete: posts are permanent.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Subscription } from "rxjs";
import { submitPost } from "@/lib/chain/post";
import type {
  CognoApi,
  PostingSigner,
  TxUpdate,
  BootGuard,
} from "@/lib/types";

export interface UseSubmit {
  /** Latest update of the in-flight (or last) tx; null when idle. */
  state: TxUpdate | null;
  /** true while a tx is signing/broadcasting/in-best-block but not yet settled. */
  busy: boolean;
  /** true when posting is allowed (connected + boot guard ok). */
  canSubmit: boolean;
  /** Submit a post (optionally a reply to `parent`). No-op when not allowed. */
  post: (text: string, parent?: bigint) => void;
  /** Clear the tx state back to idle. */
  reset: () => void;
}

// A phase is terminal once the tx can no longer change on its own.
function isTerminal(phase: TxUpdate["phase"]): boolean {
  return phase === "finalized" || phase === "invalid" || phase === "error";
}

export function useSubmit(
  api: CognoApi | null,
  signer: PostingSigner,
  boot: BootGuard | null,
): UseSubmit {
  const [state, setState] = useState<TxUpdate | null>(null);
  const subRef = useRef<Subscription | null>(null);

  const cancelInFlight = useCallback(() => {
    subRef.current?.unsubscribe();
    subRef.current = null;
  }, []);

  useEffect(() => () => cancelInFlight(), [cancelInFlight]);

  const canSubmit = api !== null && boot?.ok === true;

  const run = useCallback(
    (obs: ReturnType<typeof submitPost>) => {
      cancelInFlight();
      setState({ phase: "signing" });
      subRef.current = obs.subscribe({
        next: (u) => setState(u),
        error: (err: unknown) => {
          // The observable rarely errors (post.ts maps stream errors into an "error" TxUpdate),
          // but if the subscription itself errors, log it with the signer so it is debuggable.
          // eslint-disable-next-line no-console
          console.error(`cogno: submit subscription errored (signer ${signer.ss58.slice(0, 8)}…):`, err);
          setState({
            phase: "error",
            error:
              err instanceof Error
                ? err.message
                : "submission failed (connection or runtime error)",
          });
        },
      });
    },
    [cancelInFlight, signer.ss58],
  );

  const post = useCallback(
    (text: string, parent?: bigint) => {
      if (!api || !canSubmit) return;
      run(submitPost(api, signer, text, parent));
    },
    [api, canSubmit, signer, run],
  );

  const reset = useCallback(() => {
    cancelInFlight();
    setState(null);
  }, [cancelInFlight]);

  const busy = state !== null && !isTerminal(state.phase);

  return { state, busy, canSubmit, post, reset };
}
