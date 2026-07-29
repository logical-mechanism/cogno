"use client";

// useZeroWeightVoteNotice — fires the "your vote carries no weight" disclosure.
//
// Mounted at the three WRITE paths (useVote, useAccountVote, usePoll), never at the ~25 affordances
// that render a vote control. The distinction matters: the disclosure is about a vote that was just
// CAST, so tying it to the write is both correct and a fraction of the wiring. Every vote surface in
// the app funnels through one of those three.
//
// See lib/voteWeightNotice.ts for why this keys on `votingPower` rather than `stakeBound`, and why it
// fires on every weightless vote rather than once per account.

import { useCallback } from "react";
import { useSession } from "@/components/Providers";
import { useToaster } from "@/components/toast/ToasterProvider";
import {
  shouldWarnZeroWeight,
  ZERO_WEIGHT_TOAST_ID,
  ZERO_WEIGHT_MESSAGE,
  ZERO_WEIGHT_ACTION_LABEL,
} from "@/lib/voteWeightNotice";

/**
 * Returns a `disclose()` to call right after a vote is submitted.
 *
 * Deliberately fire-and-forget and non-blocking: it never gates, delays or reverts the vote. The vote
 * is already valid on chain; this only explains what it is worth.
 */
export function useZeroWeightVoteNotice(): () => void {
  const { votingPower } = useSession();
  const { toast } = useToaster();

  return useCallback(() => {
    if (!shouldWarnZeroWeight({ votingPower })) return;
    toast({
      // Fixed id: the toaster dedupes on it, so voting repeatedly refreshes this one toast rather
      // than stacking an identical copy per vote.
      id: ZERO_WEIGHT_TOAST_ID,
      kind: "info",
      message: ZERO_WEIGHT_MESSAGE,
      action: {
        label: ZERO_WEIGHT_ACTION_LABEL,
        // A plain assignment, not next/navigation: this runs from inside mutation callbacks on
        // surfaces that may unmount as the vote settles, and the settings deep-link is a full page
        // the user is choosing to leave for.
        onClick: () => {
          window.location.href = "/settings/#account";
        },
      },
    });
  }, [votingPower, toast]);
}
