"use client";

// useCapacity — the live, advisory talk-capacity view for one account.
//
// Reads the capacity constants once (from metadata), watches the account's weight
// (TalkStake.AllowedStake) and bucket (Microblog.Capacity) at `best`, and recomputes the
// replayed CapacityView every block (driven by `bestBlock` ticking) so regeneration animates.
// ⛔ Advisory only — the runtime's CheckCapacity is the authority (see lib/chain/capacity).

import { useEffect, useMemo, useState } from "react";
import {
  computeView,
  readCapacityConsts,
  type CapacityConsts,
  type CapacityInputs,
  type CapacityView,
} from "@/lib/chain/capacity";
import type { CognoApi, Ss58 } from "@/lib/types";

export interface UseCapacity {
  view: CapacityView | null;
  consts: CapacityConsts | null;
}

export function useCapacity(
  api: CognoApi | null,
  ss58: Ss58 | null,
  bestBlock: number | null,
): UseCapacity {
  const [consts, setConsts] = useState<CapacityConsts | null>(null);
  const [inputs, setInputs] = useState<CapacityInputs | null>(null);

  // Constants are fixed per runtime — read once per api. Fail-closed: stay null on error.
  useEffect(() => {
    if (!api) {
      setConsts(null);
      return;
    }
    let cancelled = false;
    readCapacityConsts(api)
      .then((k) => !cancelled && setConsts(k))
      .catch((err: unknown) => {
        if (cancelled) return;
        // Fail-closed: with no constants the advisory capacity battery cannot render. A missing
        // constant means a spec mismatch or an unreachable node — make it visible, don't blank.
        // eslint-disable-next-line no-console
        console.warn("cogno: could not read capacity constants — advisory capacity check disabled:", err);
        setConsts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Watch weight + bucket for the active account at `best`.
  useEffect(() => {
    if (!api || !ss58) {
      setInputs(null);
      return;
    }
    let weight = 0n;
    let bucket: CapacityInputs["bucket"] = null;
    let started = false;
    const push = () => {
      if (started) setInputs({ weight, bucket });
    };
    const s1 = api.query.TalkStake.AllowedStake.watchValue(ss58, "best").subscribe((w) => {
      weight = (w as bigint) ?? 0n;
      push();
    });
    const s2 = api.query.Microblog.Capacity.watchValue(ss58, "best").subscribe((row) => {
      bucket = row ? { capLast: row.cap_last, lastBlock: row.last_block } : null;
      push();
    });
    started = true;
    push();
    return () => {
      s1.unsubscribe();
      s2.unsubscribe();
    };
  }, [api, ss58]);

  // Recompute the replayed view every block tick (so capacity regenerates live).
  const view = useMemo(() => {
    if (!consts || !inputs || bestBlock == null) return null;
    return computeView(inputs, bestBlock, consts);
  }, [consts, inputs, bestBlock]);

  return { view, consts };
}
