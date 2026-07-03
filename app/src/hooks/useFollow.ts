"use client";

// useFollow — the follow graph + optimistic toggle. The READ (edges + counts) is gated on
// caps.follows (indexer-only; PAPI-direct returns empties). The WRITE (follow/unfollow) is NEVER
// reader-gated — it is a chain extrinsic available to any bound account — so the toggle works even
// on PAPI-direct; only the displayed counts are hidden there.

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "./useMutation";
import { useActionToast } from "./useActionToast";
import { submitFollow, submitUnfollow } from "@/lib/chain/mutations";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoApi, PostingSigner, Ss58, FollowEdges } from "@/lib/types";

export interface UseFollow {
  isFollowing: (target: Ss58) => boolean;
  follow: (target: Ss58) => void;
  unfollow: (target: Ss58) => void;
  followers: Ss58[];
  following: Ss58[];
  followerCount: number;
  followingCount: number;
  pending: boolean;
}

export function useFollow(
  api: CognoApi | null,
  signer: PostingSigner | null,
  source: FeedSource | null,
  who: Ss58 | null,
): UseFollow {
  const { run, pending } = useMutation();
  const { fail, ok } = useActionToast();
  const [edges, setEdges] = useState<FollowEdges | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!source || !who || !source.caps.follows) {
      setEdges(null);
      return;
    }
    let cancelled = false;
    source
      .followEdges(who)
      .then((e) => {
        if (!cancelled) setEdges(e);
      })
      .catch(() => {
        if (!cancelled) setEdges(null);
      });
    return () => {
      cancelled = true;
    };
  }, [source, who]);

  // Clear optimistic overrides when the viewer changes: a prior viewer's entries must not win over
  // the freshly-fetched edges (isFollowing prefers `optimistic`) after an in-place wallet/account switch.
  useEffect(() => {
    setOptimistic({});
  }, [who]);

  const isFollowing = useCallback(
    (target: Ss58) => {
      if (target in optimistic) return optimistic[target];
      return edges?.following.includes(target) ?? false;
    },
    [optimistic, edges],
  );

  const follow = useCallback(
    (target: Ss58) => {
      if (!api || !signer) return;
      setOptimistic((p) => ({ ...p, [target]: true }));
      void run(submitFollow(api, signer, target), {
        onConfirm: () => ok("Following"),
        onError: (message) => {
          setOptimistic((p) => ({ ...p, [target]: false }));
          fail(message);
        },
      }).catch(() => {});
    },
    [api, signer, run, fail, ok],
  );

  const unfollow = useCallback(
    (target: Ss58) => {
      if (!api || !signer) return;
      setOptimistic((p) => ({ ...p, [target]: false }));
      void run(submitUnfollow(api, signer, target), {
        onConfirm: () => ok("Unfollowed"),
        onError: (message) => {
          setOptimistic((p) => ({ ...p, [target]: true }));
          fail(message);
        },
      }).catch(() => {});
    },
    [api, signer, run, fail, ok],
  );

  return {
    isFollowing,
    follow,
    unfollow,
    followers: edges?.followers ?? [],
    following: edges?.following ?? [],
    followerCount: edges?.followerCount ?? 0,
    followingCount: edges?.followingCount ?? 0,
    pending,
  };
}
