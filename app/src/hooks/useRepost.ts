"use client";

// useRepost — optimistic PERMANENT repost. There is no un-repost (the chain rejects
// `AlreadyReposted`), so once reposted the button is disabled and the optimistic state must not
// double-fire. On confirm/error the overlay patch is cleared so chain truth reconciles.

import { useCallback } from "react";
import { useMutation } from "./useMutation";
import { useActionToast } from "./useActionToast";
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
  const { phase } = useActionToast();

  const repost = useCallback(
    (postId: bigint, alreadyReposted: boolean) => {
      if (!api || !signer || alreadyReposted) return;
      patchViewer(postId, { reposted: true });
      patchCounts(postId, { repostCountDelta: 1 });
      // A repost creates no feed card, so the phase toast IS the feedback: sticky "Reposting…" →
      // "Reposted" at inBestBlock, or dismissed + fail() on error. No "View →" (there's no new post).
      // Every terminal path clears the optimistic patch so chain truth reconciles (and a mid-flight
      // unmount can't stick a permanent repost-count offset).
      void run(
        submitRepost(api, signer, postId),
        phase({
          id: `repost-${postId}`,
          pending: "Reposting…",
          success: "Reposted",
          onConfirm: () => clearPost(postId),
          onError: () => clearPost(postId),
          onCancel: () => clearPost(postId),
        }),
      ).catch(() => {
        /* surfaced via phase()'s fail(); optimistic patch rolled back via clearPost */
      });
    },
    [api, signer, patchViewer, patchCounts, clearPost, run, phase],
  );

  return { repost, pending };
}
