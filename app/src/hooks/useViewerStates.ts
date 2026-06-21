"use client";

// useViewerStates — the viewer's own vote/repost on a set of posts (drives the filled heart +
// active repost icon). Reads via the seam (gated on caps.tallies; batched on the indexer, per-card
// on PAPI) and MERGES the optimistic viewer overlay so a just-liked/reposted card reflects instantly
// and reconciles when the read refetches.

import { useEffect, useMemo, useState } from "react";
import { useOptimistic } from "./useOptimistic";
import { applyViewerPatch } from "@/lib/optimistic";
import type { FeedSource } from "@/lib/feed/source";
import type { Ss58, ViewerPostState } from "@/lib/types";

const NONE: ViewerPostState = { myVote: null, reposted: false };

export function useViewerStates(
  source: FeedSource | null,
  postIds: bigint[],
  who: Ss58 | null,
): Map<bigint, ViewerPostState> {
  const { overlay } = useOptimistic();
  const [base, setBase] = useState<Map<string, ViewerPostState>>(new Map());
  // Stable dependency key for the id set (order-independent).
  const idsKey = useMemo(() => postIds.map(String).sort().join(","), [postIds]);

  useEffect(() => {
    if (!source || !who || !source.caps.tallies || postIds.length === 0) {
      setBase(new Map());
      return;
    }
    let cancelled = false;
    Promise.all(
      postIds.map(
        async (id) =>
          [String(id), await source.viewerPostState(id, who).catch(() => NONE)] as const,
      ),
    ).then((entries) => {
      if (!cancelled) setBase(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, who, idsKey]);

  return useMemo(() => {
    const out = new Map<bigint, ViewerPostState>();
    for (const id of postIds) {
      const b = base.get(String(id)) ?? NONE;
      out.set(id, applyViewerPatch(b, overlay.viewer[String(id)]));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, overlay, idsKey]);
}
