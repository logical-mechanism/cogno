"use client";

// useWhoToFollow — the RightRail ranked suggestions (caps.whoToFollow; node-direct via the
// FollowerCount map since spec-118, or the indexer). Filters out the viewer + anyone they already
// follow (client-side, via followEdges). Returns nothing when the reader can't serve it (surface omits).

import { useEffect, useMemo, useState } from "react";
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
    if (!source || !source.caps.whoToFollow) {
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
    if (!source || !who || !source.caps.follows) {
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

  const suggestions = useMemo(
    () => raw.filter((s) => s.author !== who && !following.has(s.author)).slice(0, limit),
    [raw, following, who, limit],
  );

  return { suggestions, loading };
}
