"use client";

// useVote — optimistic stake-weighted voting. Like == an UP vote (the heart); the down-vote is the
// secondary action. A re-vote replaces (the optimistic delta reverses the previous vote's weight
// before applying the new one, mirroring the chain's drift-free tally). A zero-stake voter still
// registers `myVote` + a count bump but adds 0 weight (the chain accepts a zero-weight vote).
//
// `myWeight` is the viewer's VotingPower snapshot (TalkStake.VotingPower, from useIdentity), NOT
// AllowedStake. On confirm/error the overlay patch is cleared so the next read (chain truth) wins.

import { useCallback } from "react";
import { useMutation } from "./useMutation";
import { useActionToast } from "./useActionToast";
import { useOptimistic } from "./useOptimistic";
import { voteDelta } from "@/lib/optimistic";
import { submitVote, submitClearVote } from "@/lib/chain/mutations";
import type { CognoApi, PostingSigner, ViewerPostState } from "@/lib/types";

export interface UseVote {
  /** Toggle the heart: like if not up-voted, else clear. */
  like: (postId: bigint, current: ViewerPostState) => void;
  /** Explicitly clear an existing vote. */
  unlike: (postId: bigint, current: ViewerPostState) => void;
  /** Toggle the secondary down-vote. */
  downvote: (postId: bigint, current: ViewerPostState) => void;
  /** Clear whatever vote exists. */
  clear: (postId: bigint, current: ViewerPostState) => void;
  pending: boolean;
}

export function useVote(
  api: CognoApi | null,
  signer: PostingSigner | null,
  myWeight: bigint,
): UseVote {
  const { patchViewer, patchCounts, confirmPost, clearPost } = useOptimistic();
  const { run, pending } = useMutation();
  const { fail } = useActionToast();

  const doVote = useCallback(
    (postId: bigint, current: ViewerPostState, next: "Up" | "Down" | null) => {
      if (!api || !signer) return;
      if (current.myVote === next) return; // no-op
      patchViewer(postId, { myVote: next });
      patchCounts(postId, voteDelta(current.myVote, next, myWeight));
      const stream =
        next === null
          ? submitClearVote(api, signer, postId)
          : submitVote(api, signer, postId, next);
      void run(stream, {
        // On confirm DON'T tear the overlay down (the read hasn't re-observed the vote yet — that
        // would flash the colour off and, on PAPI-direct, drop the score to 0). confirmPost hands the
        // count to the feed's VoteTally and keeps the colour until a fresh read agrees; clearPost is
        // for rollback only.
        onConfirm: () => confirmPost(postId),
        onError: (message) => {
          clearPost(postId);
          fail(message);
        },
        // Card unmounted mid-flight (navigation) → silently drop the provider-scoped patch so it can't
        // stick forever offsetting the count/colour; a later read reflects the vote if it landed.
        onCancel: () => clearPost(postId),
      }).catch(() => {
        /* failure surfaced via fail(); optimistic patch rolled back via clearPost */
      });
    },
    [api, signer, myWeight, patchViewer, patchCounts, confirmPost, clearPost, run, fail],
  );

  return {
    like: (postId, current) => doVote(postId, current, current.myVote === "Up" ? null : "Up"),
    unlike: (postId, current) => doVote(postId, current, null),
    downvote: (postId, current) => doVote(postId, current, current.myVote === "Down" ? null : "Down"),
    clear: (postId, current) => doVote(postId, current, null),
    pending,
  };
}
