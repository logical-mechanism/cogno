"use client";

// useFollow — the follow graph + optimistic toggle. The READ (edges + counts) is gated on
// the node (which serves the whole follow graph). The WRITE (follow/unfollow) is NEVER
// reader-gated — it is a chain extrinsic available to any bound account — so the toggle works even
// on PAPI-direct; only the displayed counts are hidden there.

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "./useMutation";
import { useActionToast } from "./useActionToast";
import { useFollowEdgesFor, useInvalidateFollowEdges } from "./useFollowEdges";
import { submitFollow, submitUnfollow } from "@/lib/chain/mutations";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoApi, PostingSigner, Ss58 } from "@/lib/types";

/** Optional per-call hooks so a surface with its OWN optimistic state (e.g. the profile header's
 *  follower-count delta) can reconcile it against the write outcome, not just useFollow's isFollowing map. */
export interface FollowCallbacks {
  onError?: () => void;
}

export interface UseFollow {
  isFollowing: (target: Ss58) => boolean;
  follow: (target: Ss58, cb?: FollowCallbacks) => void;
  unfollow: (target: Ss58, cb?: FollowCallbacks) => void;
  followers: Ss58[];
  following: Ss58[];
  followerCount: number;
  followingCount: number;
}

export function useFollow(
  api: CognoApi | null,
  signer: PostingSigner | null,
  source: FeedSource | null,
  who: Ss58 | null,
): UseFollow {
  const { run } = useMutation();
  const { fail, ok } = useActionToast();
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  // The SHARED cache, not a per-hook read. Home mounts this hook twice (the page and RightRail) and
  // two other surfaces ask the same question on the same load; through the cache that is one
  // state_call for all four. `source` is no longer read here, but stays in the signature as the
  // reader-gate every call site already passes.
  const edges = useFollowEdgesFor(source && who ? who : undefined);
  const invalidateEdges = useInvalidateFollowEdges();

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
    (target: Ss58, cb?: FollowCallbacks) => {
      if (!api || !signer) return;
      setOptimistic((p) => ({ ...p, [target]: true }));
      void run(submitFollow(api, signer, target), {
        onConfirm: () => {
          ok("Following");
          // The write is the ONLY thing that moves this graph, so an explicit invalidation is the whole
          // cache-coherence story: both ends of the new edge are re-read, which also refreshes the
          // target's follower count on their profile.
          if (who) invalidateEdges(who, target);
          else invalidateEdges(target);
        },
        onError: (message) => {
          setOptimistic((p) => ({ ...p, [target]: false }));
          cb?.onError?.(); // let a surface roll back its own optimistic count too
          fail(message);
        },
      });
    },
    [api, signer, run, fail, ok, who, invalidateEdges],
  );

  const unfollow = useCallback(
    (target: Ss58, cb?: FollowCallbacks) => {
      if (!api || !signer) return;
      setOptimistic((p) => ({ ...p, [target]: false }));
      void run(submitUnfollow(api, signer, target), {
        onConfirm: () => {
          ok("Unfollowed");
          if (who) invalidateEdges(who, target);
          else invalidateEdges(target);
        },
        onError: (message) => {
          setOptimistic((p) => ({ ...p, [target]: true }));
          cb?.onError?.();
          fail(message);
        },
      });
    },
    [api, signer, run, fail, ok, who, invalidateEdges],
  );

  return {
    isFollowing,
    follow,
    unfollow,
    followers: edges?.followers ?? [],
    following: edges?.following ?? [],
    followerCount: edges?.followerCount ?? 0,
    followingCount: edges?.followingCount ?? 0,
  };
}
