"use client";

// useStabilityWindow — the lock-to-credit wait, as copy, read from the chain.
//
// The wait is one consensus parameter: the observer only reads Cardano history older than
// `StabilitySlots`, so a lock is credited that long after it confirms. That is ~10 minutes on the
// preprod window and ~36 hours on the mainnet one, which is why the pre-lock copy cannot be a
// hardcoded phrase — it is the number a user weighs before committing 100 real ADA.
//
// Returns null until the read resolves, so callers can render a neutral phrasing rather than guess.

import { useEffect, useState } from "react";
import { readObserverConfig, describeStabilityWindow } from "@/lib/chain/observer";
import type { CognoApi } from "@/lib/types";

export function useStabilityWindow(api: CognoApi | null): string | null {
  const [window, setWindow] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    readObserverConfig(api)
      .then((cfg) => {
        if (!cancelled) setWindow(describeStabilityWindow(cfg.stabilitySlots));
      })
      .catch(() => {
        // Best-effort: a failed read leaves the neutral copy rather than asserting a duration.
        if (!cancelled) setWindow(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return window;
}
