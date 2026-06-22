"use client";

// useOptimisticFeed — useFeed + the optimistic overlay (doc 04 §2.11). Same shape as useFeed, but
// the returned snapshot has pending optimistic cards prepended and per-post count patches applied,
// so an unconfirmed post/like/repost is visible immediately and survives the next feed poll until
// it confirms (overlay cleared) or rolls back.

import { useMemo } from "react";
import { useFeed, type UseFeed } from "./useFeed";
import { useOptimistic } from "./useOptimistic";
import { mergeFeed } from "@/lib/optimistic";
import type { FeedSource } from "@/lib/feed/source";

export function useOptimisticFeed(source: FeedSource | null): UseFeed {
  const { snapshot, ready, error } = useFeed(source);
  const { overlay } = useOptimistic();

  const merged = useMemo(
    () => ({ posts: mergeFeed(snapshot.posts, overlay), asOf: snapshot.asOf }),
    [snapshot, overlay],
  );

  return { snapshot: merged, ready, error };
}
