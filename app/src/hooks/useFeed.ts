"use client";

// useFeed — subscribes to the live feed (watchEntries-derived) and exposes the
// FULL current post set (authoritative, newest-first) as plain React state.

import { useEffect, useState } from "react";
import { watchFeed } from "@/lib/chain/reads";
import type { CognoApi, FeedSnapshot } from "@/lib/types";

const EMPTY: FeedSnapshot = { posts: [], asOf: null };

export interface UseFeed {
  /** Full current post set, newest-first. */
  snapshot: FeedSnapshot;
  /** false until the first emission lands (so the UI can tell "loading" from "empty"). */
  ready: boolean;
}

export function useFeed(api: CognoApi | null): UseFeed {
  const [snapshot, setSnapshot] = useState<FeedSnapshot>(EMPTY);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!api) {
      setSnapshot(EMPTY);
      setReady(false);
      return;
    }
    setReady(false);
    const sub = watchFeed(api).subscribe({
      next: (snap) => {
        setSnapshot(snap);
        setReady(true);
      },
      error: () => {
        // Keep the last good snapshot on a transient stream error; just stop
        // claiming readiness so the UI can fall back to a connection state.
        setReady(false);
      },
    });
    return () => sub.unsubscribe();
  }, [api]);

  return { snapshot, ready };
}
