"use client";

// useActionToast — the toast policy for optimistic write actions, in ONE place so every hook
// (follow / vote / repost / …) words feedback identically. A CheckCapacity pool rejection becomes the
// dedicated rate-limit toast; anything else is a generic error toast. `ok` is for the few DISCRETE
// successes worth confirming (follow / unfollow / repost) — high-frequency actions like votes stay
// silent on success because the optimistic UI already showed the change (doc 04 §3.4).

import { useCallback } from "react";
import { useToaster } from "@/components/toast/ToasterProvider";

/** A CheckCapacity pool rejection ⇒ the rate-limit toast, not the generic error. */
function isRateLimit(message: string): boolean {
  return /rate limit|ExhaustsResources/i.test(message);
}

export interface ActionToast {
  /** Toast a settle failure (rate-limit gets its dedicated toast; everything else a generic error). */
  fail: (message: string) => void;
  /** Toast a discrete success — skip for high-frequency actions (votes). */
  ok: (message: string) => void;
}

export function useActionToast(): ActionToast {
  const { toast, rateLimit } = useToaster();
  const fail = useCallback(
    (message: string) => {
      if (isRateLimit(message)) rateLimit();
      else toast({ kind: "error", message });
    },
    [toast, rateLimit],
  );
  const ok = useCallback((message: string) => toast({ kind: "success", message }), [toast]);
  return { fail, ok };
}
