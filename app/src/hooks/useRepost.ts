"use client";

// useRepost — optimistic PERMANENT repost. There is no un-repost (the chain rejects
// `AlreadyReposted`), so once reposted the button is disabled and the optimistic state must not
// double-fire. On confirm/error the overlay patch is cleared so chain truth reconciles.

import { useCallback } from "react";
import { useMutation } from "./useMutation";
import { useOptimistic } from "./useOptimistic";
import { submitRepost } from "@/lib/chain/mutations";
import type { CognoApi, PostingSigner } from "@/lib/types";

export interface UseRepost {
  /** Repost a post (permanent). No-op if already reposted (the caller also disables the control). */
  repost: (postId: bigint, alreadyReposted: boolean) => void;
  pending: boolean;
}

export function useRepost(api: CognoApi | null, signer: PostingSigner | null): UseRepost {
  const { patchViewer, patchCounts, clearPost } = useOptimistic();
  const { run, pending } = useMutation();

  const repost = useCallback(
    (postId: bigint, alreadyReposted: boolean) => {
      if (!api || !signer || alreadyReposted) return;
      patchViewer(postId, { reposted: true });
      patchCounts(postId, { repostCountDelta: 1 });
      void run(submitRepost(api, signer, postId), {
        onConfirm: () => clearPost(postId),
        onError: () => clearPost(postId),
      }).catch(() => {
        /* surfaced + rolled back via onError/clearPost */
      });
    },
    [api, signer, patchViewer, patchCounts, clearPost, run],
  );

  return { repost, pending };
}
