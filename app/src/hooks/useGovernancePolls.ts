"use client";

// useGovernancePolls — load the chain's action-tagged governance polls for the /governance surface. A cold
// read on connect (and on `reload()`); the close state is derived per-render from the shared best block, so
// the list doesn't refetch every block. `readGovernancePolls` never throws — `error` is a soft signal.

import { useCallback, useEffect, useState } from "react";
import type { CognoApi } from "@/lib/types";
import { readGovernancePolls, type GovPollSummary } from "@/lib/chain/governance-feed";

export interface UseGovernancePolls {
  polls: GovPollSummary[] | null;
  loading: boolean;
  error: boolean;
  reload: () => void;
}

export function useGovernancePolls(api: CognoApi | null): UseGovernancePolls {
  const [polls, setPolls] = useState<GovPollSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!api) {
      setPolls(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    readGovernancePolls(api)
      .then((p) => {
        if (!cancelled) setPolls(p);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, nonce]);

  return { polls, loading, error, reload };
}
