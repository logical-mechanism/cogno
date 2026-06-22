"use client";

// useThread — fetch a thread (root + "replying to" parent + direct replies) and merge any pending
// optimistic replies (addOptimisticReply) so a just-submitted reply shows instantly under the root.
// v1 ThreadView is root + one level of direct replies (deeper replies open their own /post/[id]).

import { useEffect, useMemo, useState } from "react";
import { useOptimistic } from "./useOptimistic";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoPost, ThreadView } from "@/lib/types";

export interface UseThread {
  thread: ThreadView | null;
  loading: boolean;
  error: string | null;
  /** Insert a pending optimistic reply under this thread; returns its clientId. */
  addOptimisticReply: (post: CognoPost) => string;
}

export function useThread(source: FeedSource | null, rootId: bigint | null): UseThread {
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { overlay, addPending } = useOptimistic();

  useEffect(() => {
    if (!source || rootId == null) {
      setThread(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    source
      .thread(rootId)
      .then((t) => {
        if (!cancelled) setThread(t);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "could not load the thread");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, rootId]);

  const merged = useMemo(() => {
    if (!thread || rootId == null) return thread;
    const pendingReplies = overlay.pending
      .filter((p) => p.status === "pending" && p.parentId === rootId)
      .map((p) => p.post);
    if (pendingReplies.length === 0) return thread;
    return {
      ...thread,
      replies: [...thread.replies, ...pendingReplies],
      replyCount: thread.replyCount + pendingReplies.length,
    };
  }, [thread, overlay, rootId]);

  return {
    thread: merged,
    loading,
    error,
    addOptimisticReply: (post: CognoPost) => addPending(post, rootId ?? undefined),
  };
}
