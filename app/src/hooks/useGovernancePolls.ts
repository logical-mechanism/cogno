"use client";

// useGovernancePolls — load the chain's action-tagged governance polls for the /governance surface. A cold
// read on connect (and on `reload()`); the close state is derived per-render from the shared best block, so
// the list doesn't refetch every block. `readGovernancePolls` never throws; it signals a failed poll
// scan by returning `null`, which becomes `error` here — `[]` really does mean "no governance polls".

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
        if (cancelled) return;
        // `null` = the poll scan failed. Set `error` and leave `polls` at null: setting `[]` alongside
        // it flips the page's `counted` back on and re-asserts "0 polls." underneath the failure state,
        // which is the exact thing the page's own comment was written to prevent.
        if (p === null) setError(true);
        else setPolls(p);
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
