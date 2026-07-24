"use client";

// useWhoToFollow — the RightRail ranked suggestions, node-direct via the FollowerCount map. Filters
// out the viewer + anyone they already follow (client-side, via followEdges). Returns nothing when the
// reader can't serve it (the surface then omits the section).

import { useEffect, useMemo, useState } from "react";
import { useBlockedSet } from "@/lib/blockStore";
import { useFollowEdgesFor } from "./useFollowEdges";
import type { FeedSource } from "@/lib/feed/source";
import type { Ss58, Suggestion } from "@/lib/types";

export interface UseWhoToFollow {
  suggestions: Suggestion[];
  loading: boolean;
}

export function useWhoToFollow(
  source: FeedSource | null,
  who: Ss58 | null,
  limit: number,
): UseWhoToFollow {
  const [raw, setRaw] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!source ) {
      setRaw([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    source
      .whoToFollow(who, limit + 10)
      .then((s) => {
        if (!cancelled) setRaw(s);
      })
      .catch(() => {
        if (!cancelled) setRaw([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, who, limit]);

  // Shared cache: this used to issue its own `followEdges(who)` alongside the two useFollow mounts and
  // Home's followees probe — four reads of one answer per load. See hooks/useFollowEdges.
  const edges = useFollowEdgesFor(source && who ? who : undefined);
  const following = useMemo(() => new Set(edges?.following ?? []), [edges]);

  // A blocked account never appears as a suggestion (hard suppression, viewer-side).
  const blocked = useBlockedSet(who);
  const suggestions = useMemo(
    () =>
      raw
        .filter((s) => s.author !== who && !following.has(s.author) && !blocked.has(s.author))
        .slice(0, limit),
    [raw, following, blocked, who, limit],
  );

  return { suggestions, loading };
}
