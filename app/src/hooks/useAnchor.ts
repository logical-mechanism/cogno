"use client";

// useAnchor — the live Cardano anchor checkpoint (Anchor.LastCheckpoint, M3 Tier-A) for the
// Civic-Ledger strip. `null` until the relayer has anchored at least once.

import { useEffect, useState } from "react";
import { watchAnchor } from "@/lib/chain/reads";
import type { AnchorCheckpoint, CognoApi } from "@/lib/types";

export function useAnchor(api: CognoApi | null): AnchorCheckpoint | null {
  const [anchor, setAnchor] = useState<AnchorCheckpoint | null>(null);

  useEffect(() => {
    if (!api) {
      setAnchor(null);
      return;
    }
    const sub = watchAnchor(api).subscribe({
      next: setAnchor,
      // On error keep the last known checkpoint — staleness is read honestly from the block/ts,
      // we never blank an anchor we have already seen.
      error: () => {},
    });
    return () => sub.unsubscribe();
  }, [api]);

  return anchor;
}
