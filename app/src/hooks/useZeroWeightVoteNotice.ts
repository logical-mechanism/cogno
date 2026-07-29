"use client";

// useZeroWeightVoteNotice — fires the one-shot "your vote carries no weight" disclosure.
//
// Mounted at the three WRITE paths (useVote, useAccountVote, usePoll), never at the ~25 affordances
// that render a vote control. The distinction matters: the disclosure is about a vote that was just
// CAST, so tying it to the write is both correct and a fraction of the wiring. Every vote surface in
// the app funnels through one of those three.
//
// See lib/voteWeightNotice.ts for why this keys on `votingPower` rather than `stakeBound`, and why it
// is one shot per account rather than per vote.

import { useCallback } from "react";
import { useSession } from "@/components/Providers";
import { useToaster } from "@/components/toast/ToasterProvider";
import {
  seenNoticeStore,
  shouldWarnZeroWeight,
  ZERO_WEIGHT_VOTE,
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
  const { viewer, votingPower } = useSession();
  const { toast } = useToaster();
  const who = viewer.address ?? null;
  const seen = seenNoticeStore.useSet(who);

  return useCallback(() => {
    if (!shouldWarnZeroWeight({ votingPower, seen })) return;
    // Mark BEFORE raising, so a double-click cannot queue the toast twice. `add` returning false
    // (blocked site data / quota) is not worth failing on: the worst case is the user sees this again
    // next time, which is strictly better than swallowing the disclosure.
    seenNoticeStore.actionsFor(who).add(ZERO_WEIGHT_VOTE);
    toast({
      kind: "info",
      message: ZERO_WEIGHT_MESSAGE,
      action: {
        label: ZERO_WEIGHT_ACTION_LABEL,
        // A plain assignment, not next/navigation: this hook is called from inside mutation callbacks
        // on surfaces that may unmount as the vote settles, and the settings deep-link is a full page
        // the user is choosing to leave for.
        onClick: () => {
          window.location.href = "/settings/#account";
        },
      },
    });
  }, [votingPower, seen, who, toast]);
}
