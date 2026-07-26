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
  // NOT named `window`: this module is executed during the static export, and a state variable by that
  // name shadows the DOM global for the whole hook body — so the house `typeof window === "undefined"`
  // SSG guard, if anyone ever added one here, would silently test a string that is always defined.
  const [wait, setWait] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    readObserverConfig(api)
      .then((cfg) => {
        if (!cancelled) setWait(describeStabilityWindow(cfg.stabilitySlots));
      })
      .catch(() => {
        // Best-effort: a failed read leaves the neutral copy rather than asserting a duration.
        if (!cancelled) setWait(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return wait;
}
