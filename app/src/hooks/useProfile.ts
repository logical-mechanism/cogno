"use client";

// useProfile — fetch one author's profile + posts via the seam (tab-aware: Posts / Replies / Likes).
// Display fields (name/bio/avatar/counts) come back only on the indexer (caps.profiles/follows);
// PAPI-direct returns the ss58 + posts and the surface falls back to an identicon + truncated handle.

import { useEffect, useState } from "react";
import type { FeedSource, ProfileArgs } from "@/lib/feed/source";
import type { CognoPost, ProfileView } from "@/lib/types";

export interface UseProfile {
  profile: ProfileView | null;
  posts: CognoPost[];
  loading: boolean;
  error: string | null;
  loadMore: () => void;
}

export function useProfile(source: FeedSource | null, args: ProfileArgs): UseProfile {
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(args);

  useEffect(() => {
    if (!source || (!args.author && !args.identityHash)) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    source
      .profile(args)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "could not load the profile");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, key]);

  return {
    profile,
    posts: profile?.page.posts ?? [],
    loading,
    error,
    // v1: the seam returns the first page; profile cursor pagination is a clean follow-up.
    loadMore: () => {},
  };
}
