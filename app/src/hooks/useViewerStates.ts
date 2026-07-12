"use client";

// useViewerStates — the viewer's own vote/repost on a set of posts (drives the filled heart +
// active repost icon). Reads via the seam (gated on caps.tallies; batched on the indexer, per-card
// on PAPI) and MERGES the optimistic viewer overlay so a just-liked/reposted card reflects instantly
// and reconciles when the read refetches.
//
// SPEC-120 BYPASS: a node-served page (the `caps.nodeFeedApi` MicroblogApi path) already carries each
// post's `myVote`/`reposted`, stamped node-side. The caller passes that as `carried` (id-string →
// overlay); for any post present there, this hook uses the carried overlay and SKIPS its per-card
// `source.viewerPostState(id, who)` read — which on PAPI is the heavy `Reposts.getEntries` scan. Posts
// absent from `carried` (the pre-120 keyed path) still fall back to the per-card read, unchanged.

import { useEffect, useMemo, useRef, useState } from "react";
import { useOptimistic } from "./useOptimistic";
import { applyViewerPatch, viewerPatchSettled, NO_VIEWER } from "@/lib/optimistic";
import type { FeedSource } from "@/lib/feed/source";
import type { Ss58, ViewerPostState } from "@/lib/types";


export function useViewerStates(
  source: FeedSource | null,
  postIds: bigint[],
  who: Ss58 | null,
  /**
   * Optional per-post overlay already carried on a node-served page (id-string → state). When an id
   * is present here, the hook trusts it and does NOT issue a `viewerPostState` read for that id (the
   * spec-120 bypass). Build it from the page's posts (only those whose `myVote` is defined).
   */
  carried?: Map<string, ViewerPostState>,
): Map<bigint, ViewerPostState> {
  const { overlay, clearPost } = useOptimistic();
  const [base, setBase] = useState<Map<string, ViewerPostState>>(new Map());
  // Stable dependency key for the id set (order-independent).
  const idsKey = useMemo(() => postIds.map(String).sort().join(","), [postIds]);
  // Stable dependency key for the carried overlay (so a node-served refetch with a changed overlay
  // re-runs the effect, but a referentially-new-but-equal map does not).
  const carriedKey = useMemo(
    () =>
      carried == null
        ? ""
        : Array.from(carried.entries())
            .map(([id, v]) => `${id}:${v.myVote ?? "null"}`)
            .sort()
            .join(","),
    [carried],
  );
  // Reach the latest carried map inside the async effect closure without re-subscribing on identity.
  const carriedRef = useRef(carried);
  carriedRef.current = carried;
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
    if (!source || !who || postIds.length === 0) {
      setBase(new Map());
      return;
    }
    let cancelled = false;
    const carriedNow = carriedRef.current;
    // SPEC-120 BYPASS: an id whose overlay the node-served page already carries is read FROM that map;
    // only the rest hit `source.viewerPostState` (on PAPI, the per-card `Reposts.getEntries` scan).
    Promise.all(
      postIds.map(async (id) => {
        const fromCarried = carriedNow?.get(String(id));
        if (fromCarried) return [String(id), fromCarried] as const;
        return [String(id), await source.viewerPostState(id, who).catch(() => NO_VIEWER)] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      const map = new Map(entries);
      setBase(map);
      // Reconcile-by-fresh-read: this read ran AFTER the expected-set changed (a vote confirmed), so
      // for each post we actually re-read, retire any confirmed patch the read now agrees with — the
      // colour hands cleanly from overlay to chain truth with no flash. The carried overlay is itself a
      // fresh node read (the page refetched), so it reconciles a confirmed patch the same way.
      const v = overlayRef.current.viewer;
      for (const id of postIds) {
        const patch = v[String(id)];
        if (patch?.expected && viewerPatchSettled(map.get(String(id)) ?? NO_VIEWER, patch)) {
          clearPost(id);
        }
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, who, idsKey, expectedKey, carriedKey]);

  return useMemo(() => {
    const out = new Map<bigint, ViewerPostState>();
    for (const id of postIds) {
      const b = base.get(String(id)) ?? NO_VIEWER;
      out.set(id, applyViewerPatch(b, overlay.viewer[String(id)]));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, overlay, idsKey]);
}
