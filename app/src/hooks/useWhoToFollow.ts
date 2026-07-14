"use client";

// useWhoToFollow — the RightRail ranked suggestions, node-direct via the FollowerCount map. Filters
// out the viewer + anyone they already follow (client-side, via followEdges). Returns nothing when the
// reader can't serve it (the surface then omits the section).

import { useEffect, useMemo, useState } from "react";
import { useBlockedSet } from "@/lib/blockStore";
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
  const [following, setFollowing] = useState<Set<string>>(new Set());
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

  useEffect(() => {
    if (!source || !who ) {
      setFollowing(new Set());
      return;
    }
    let cancelled = false;
    source
      .followEdges(who)
      .then((e) => {
        if (!cancelled) setFollowing(new Set(e.following));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source, who]);

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
