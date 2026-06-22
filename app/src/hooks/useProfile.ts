"use client";

// useProfile — fetch one author's profile + posts via the seam (tab-aware: Posts / Replies / Likes).
// Display fields (name/bio/avatar/counts) come back only on the indexer (caps.profiles/follows);
// PAPI-direct returns the ss58 + posts and the surface falls back to an identicon + truncated handle.

import { useEffect, useRef, useState } from "react";
import type { FeedSource, ProfileArgs } from "@/lib/feed/source";
import type { CognoPost, ProfileView } from "@/lib/types";

export interface UseProfile {
  profile: ProfileView | null;
  posts: CognoPost[];
  loading: boolean;
  error: string | null;
  loadMore: () => void;
}

/**
 * @param liveKey changing value (e.g. the best block number) that triggers a SILENT re-fetch — so a
 *   profile edit or a fresh post lands as soon as the block comes in, with no spinner/manual refresh.
 */
export function useProfile(
  source: FeedSource | null,
  args: ProfileArgs,
  liveKey?: number | null,
): UseProfile {
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(args);
  // Track which args we've already shown data for, so a liveKey tick is a silent refresh (no spinner,
  // no error clobber) while a new args/source is a fresh load.
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!source || (!args.author && !args.identityHash)) {
      setProfile(null);
      loadedKey.current = null;
      return;
    }
    let cancelled = false;
    const firstForKey = loadedKey.current !== key;
    if (firstForKey) {
      setLoading(true);
      setError(null);
    }
    source
      .profile(args)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        loadedKey.current = key;
      })
      .catch((e: unknown) => {
        // Only surface an error on the initial load; a silent refresh failure keeps the last data.
        if (!cancelled && firstForKey) {
          setError(e instanceof Error ? e.message : "could not load the profile");
        }
      })
      .finally(() => {
        if (!cancelled && firstForKey) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, key, liveKey]);

  return {
    profile,
    posts: profile?.page.posts ?? [],
    loading,
    error,
    // v1: the seam returns the first page; profile cursor pagination is a clean follow-up.
    loadMore: () => {},
  };
}
