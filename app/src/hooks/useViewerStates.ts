"use client";

// useViewerStates — the viewer's own vote/repost on a set of posts (drives the filled heart +
// active repost icon). Reads via the seam (gated on caps.tallies; batched on the indexer, per-card
// on PAPI) and MERGES the optimistic viewer overlay so a just-liked/reposted card reflects instantly
// and reconciles when the read refetches.

import { useEffect, useMemo, useRef, useState } from "react";
import { useOptimistic } from "./useOptimistic";
import { applyViewerPatch, viewerPatchSettled } from "@/lib/optimistic";
import type { FeedSource } from "@/lib/feed/source";
import type { Ss58, ViewerPostState } from "@/lib/types";

const NONE: ViewerPostState = { myVote: null, reposted: false };

export function useViewerStates(
  source: FeedSource | null,
  postIds: bigint[],
  who: Ss58 | null,
): Map<bigint, ViewerPostState> {
  const { overlay, clearPost } = useOptimistic();
  const [base, setBase] = useState<Map<string, ViewerPostState>>(new Map());
  // Stable dependency key for the id set (order-independent).
  const idsKey = useMemo(() => postIds.map(String).sort().join(","), [postIds]);
  // A confirmed vote flags its viewer patch `expected`. A vote touches neither the post set nor the
  // feed (it writes Votes + VoteTally), so without this the base read would NEVER re-run after a vote
  // and the optimistic colour could never reconcile. Re-running the read when this key changes is what
  // closes the confirm→re-observe gap on the PAPI-direct path.
  const expectedKey = useMemo(
    () =>
      Object.entries(overlay.viewer)
        .filter(([, v]) => v.expected)
        .map(([id, v]) => `${id}:${v.myVote ?? "null"}`)
        .sort()
        .join(","),
    [overlay.viewer],
  );
  // Reconcile against the LATEST overlay — the read resolves async, after the effect's closure.
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;

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
      if (cancelled) return;
      const map = new Map(entries);
      setBase(map);
      // Reconcile-by-fresh-read: this read ran AFTER the expected-set changed (a vote confirmed), so
      // for each post we actually re-read, retire any confirmed patch the read now agrees with — the
      // colour hands cleanly from overlay to chain truth with no flash.
      const v = overlayRef.current.viewer;
      for (const id of postIds) {
        const patch = v[String(id)];
        if (patch?.expected && viewerPatchSettled(map.get(String(id)) ?? NONE, patch)) {
          clearPost(id);
        }
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, who, idsKey, expectedKey]);

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
