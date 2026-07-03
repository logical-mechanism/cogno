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
  const { fail, ok } = useActionToast();

  const repost = useCallback(
    (postId: bigint, alreadyReposted: boolean) => {
      if (!api || !signer || alreadyReposted) return;
      patchViewer(postId, { reposted: true });
      patchCounts(postId, { repostCountDelta: 1 });
      void run(submitRepost(api, signer, postId), {
        onConfirm: () => {
          clearPost(postId);
          ok("Reposted");
        },
        onError: (message) => {
          clearPost(postId);
          fail(message);
        },
        // Card unmounted mid-flight → silently drop the optimistic patch so it can't outlive the
        // page-scoped hook and stick a permanent repost-count offset.
        onCancel: () => clearPost(postId),
      }).catch(() => {
        /* surfaced via fail(); optimistic patch rolled back via clearPost */
      });
    },
    [api, signer, patchViewer, patchCounts, clearPost, run, fail, ok],
  );

  return { repost, pending };
}
