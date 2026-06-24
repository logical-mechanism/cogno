"use client";

// usePinPost — pin one of your own posts to your profile, straight from the post's overflow menu
// (replacing the old type-a-post-id control in Edit profile). Feeless + capacity-metered like every
// pallet-profile write. Pinning REPLACES any previously pinned post. Unpinning lives on the settings
// Profile section. Discrete success/failure toasts (no optimistic overlay — the post card itself does
// not change; the profile's pinned block reflects it on its next read).

import { useCallback } from "react";
import { useMutation } from "./useMutation";
import { useActionToast } from "./useActionToast";
import { submitPinPost } from "@/lib/chain/mutations";
import type { CognoApi, PostingSigner } from "@/lib/types";

export interface UsePinPost {
  /** Pin a post id to the viewer's profile. */
  pin: (postId: bigint) => void;
}

export function usePinPost(api: CognoApi | null, signer: PostingSigner | null): UsePinPost {
  const { run } = useMutation();
  const { ok, fail } = useActionToast();

  const pin = useCallback(
    (postId: bigint) => {
      if (!api || !signer) return;
      void run(submitPinPost(api, signer, postId), {
        onConfirm: () => ok("Pinned to your profile"),
        onError: (message) => fail(message),
      }).catch(() => {
        /* failure surfaced via fail() */
      });
    },
    [api, signer, run, ok, fail],
  );

  return { pin };
}
