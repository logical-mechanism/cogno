"use client";

// useHeads — live best-vs-finalized head positions for the Civic-Ledger strip.

import { useEffect, useState } from "react";
import type { PolkadotClient } from "polkadot-api";
import { watchHeads } from "@/lib/chain/reads";
import type { ChainHeads } from "@/lib/types";

const EMPTY: ChainHeads = { best: null, finalized: null };

export function useHeads(client: PolkadotClient | null): ChainHeads {
  const [heads, setHeads] = useState<ChainHeads>(EMPTY);

  useEffect(() => {
    if (!client) {
      setHeads(EMPTY);
      return;
    }
    const sub = watchHeads(client).subscribe({
      next: setHeads,
      // On error keep the last known heads — the ProvenanceLine reads "not
      // advancing" honestly from staleness rather than us blanking the strip.
      error: () => {},
    });
    return () => sub.unsubscribe();
  }, [client]);

  return heads;
}
