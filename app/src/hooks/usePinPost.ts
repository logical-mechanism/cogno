"use client";

// usePinPost — pin one of your own posts to your profile, straight from the post's overflow menu
// (replacing the old type-a-post-id control in Edit profile). Feeless + capacity-metered like every
// pallet-profile write. Pinning REPLACES any previously pinned post. Unpinning lives on the settings
// Profile section. No optimistic overlay (the post card itself doesn't change; the profile's pinned
// block reflects it on its next read) — so it routes through the sticky "Pinning…" phase toast for
// immediate feedback that upgrades to success / fails, rather than nothing for the whole confirm window.

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
  const { phase } = useActionToast();

  const pin = useCallback(
    (postId: bigint) => {
      if (!api || !signer) return;
      // Immediate "Pinning…" (dedupe id per post) that upgrades to "Pinned…" on confirm or dismisses +
      // fails on error — so a click isn't met with several seconds of silence (which reads as broken).
      void run(
        submitPinPost(api, signer, postId),
        phase({ id: `pin-${postId}`, pending: "Pinning…", success: "Pinned to your profile" }),
      );
    },
    [api, signer, run, phase],
  );

  return { pin };
}
