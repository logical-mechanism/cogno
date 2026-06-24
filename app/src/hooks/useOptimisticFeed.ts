"use client";

// useOptimisticFeed — useFeed + the optimistic overlay (doc 04 §2.11). Same shape as useFeed, but
// the returned snapshot has pending optimistic cards prepended and per-post count patches applied,
// so an unconfirmed post/like/repost is visible immediately and survives the next feed poll until
// it confirms (overlay cleared) or rolls back.

import { useEffect, useMemo } from "react";
import { useFeed, type UseFeed } from "./useFeed";
import { useOptimistic } from "./useOptimistic";
import { mergeFeed } from "@/lib/optimistic";
import type { FeedSource } from "@/lib/feed/source";

export function useOptimisticFeed(source: FeedSource | null): UseFeed {
  const { snapshot, ready, error } = useFeed(source);
  const { overlay, dropPending } = useOptimistic();

  const merged = useMemo(
    () => ({ posts: mergeFeed(snapshot.posts, overlay), asOf: snapshot.asOf }),
    [snapshot, overlay],
  );

  // Retire a pending top-level post once its real twin LANDS in the chain snapshot (keyed author+text,
  // matching mergeFeed's dedup) — NOT on tx-confirm. Dropping on confirm raced the feed re-emit and
  // briefly blanked the just-posted card ("shows, vanishes, comes back"). Reconciling by presence keeps
  // the card up continuously: mergeFeed suppresses the pending the instant the real row appears, then
  // this drops the now-redundant overlay entry — a seamless optimistic→chain handoff.
  useEffect(() => {
    const top = overlay.pending.filter((p) => p.status === "pending" && p.parentId === undefined);
    if (top.length === 0) return;
    const realKeys = new Set(snapshot.posts.map((p) => `${p.author}\n${p.text}`));
    for (const pp of top) {
      if (realKeys.has(`${pp.post.author}\n${pp.post.text}`)) dropPending(pp.clientId);
    }
  }, [snapshot.posts, overlay.pending, dropPending]);

  return { snapshot: merged, ready, error };
}
