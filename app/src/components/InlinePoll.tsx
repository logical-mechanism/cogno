"use client";

// InlinePoll — a self-contained, votable poll attachment for a PostCard in a LIST context (timeline,
// profile, …) where the surface doesn't pre-fetch poll data the way ThreadView does for its focal
// post. It reads the shared session + fetches the poll via usePoll, then renders the same PollCard.
// PostCard stays presentational; this is the single poll piece that touches the session/reader seam,
// so polls render + vote inline in the feed instead of showing as plain text posts.

import { useCallback } from "react";
import { affordanceFor, affordanceTitle } from "@/lib/writeAffordance";
import { signInPromptActions } from "@/lib/signInPromptStore";
import { PollCard } from "./PollCard";
import { Skeleton } from "./Skeleton";
import { useSession, useBestBlock } from "./Providers";
import { usePoll } from "@/hooks/usePoll";
import { chamberBlocksViewer, chamberRequiredRole, pollClosesIn, roleLabel } from "@/lib/poll";
import styles from "./InlinePoll.module.css";
import { viewerBucket } from "@/lib/viewerBucket";
import type { Viewer } from "./kit";

export interface InlinePollProps {
  /** The host post id (a poll's id == its host post id). */
  postId: bigint;
  /** Write-gate state — casting a vote funnels to /welcome until setup is complete (writeReady). */
  gate: Viewer;
  /** Detail surface → always show results; list → compact, results after the viewer votes. */
  detail?: boolean;
}

export function InlinePoll({ postId, gate, detail }: InlinePollProps) {
  const { source, api, signer, viewerRoles } = useSession();
  const bestBlock = useBestBlock();
  const { poll, myChoice, castVote, loading, error, provisional, finalize, finalizing, reload } = usePoll(
    source,
    postId,
    api,
    signer,
    viewerBucket(gate),
    bestBlock,
  );
  // Casting a poll vote is a mutating write — funnel an unfinished-setup viewer to /welcome instead of
  // casting. usePoll.castVote has NO gate of its own, so this is the single enforcement point for inline
  // poll votes (the mandatory stake step is not a pool gate, so the UI must hold the line).
  const onVote = useCallback(
    (index: number) => {
      if (!gate.writeReady) return void signInPromptActions.open("vote");
      castVote(index);
    },
    [gate.writeReady, castVote],
  );
  // Finalizing (`close_poll`) is a permissionless mutating write too — same write-gate funnel.
  const onFinalize = useCallback(() => {
    if (!gate.writeReady) return void signInPromptActions.open("vote");
    finalize();
  }, [gate.writeReady, finalize]);
  if (!poll) {
    // Hold the poll's shape while the tallies load so the card doesn't paint body-only and then jump when
    // they land; on a read failure show a Retry rather than silently rendering nothing.
    if (loading) return <Skeleton variant="pollCard" />;
    if (error) {
      return (
        <div role="status" className={styles.error}>
          <span>Couldn&apos;t load this poll.</span>
          <button
            type="button"
            className={styles.retry}
            onClick={(e) => {
              e.stopPropagation(); // don't open the post — this row lives inside a clickable card
              reload();
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return null; // no tallies and not loading/errored — the post body already rendered above
  }
  const closeState = poll.finalized ? "final" : provisional ? "provisional" : "open";
  // Chamber gate (spec 209): a single-chamber `Spo`/`Drep` poll accepts only that chamber's role-holders —
  // a non-member's cast would never enter the tally, so we block it rather than record a phantom vote. Only
  // gate while OPEN (a closed poll is disabled for everyone). `viewerRoles === null` fails open, so a member
  // is never blocked mid-load. A blocked non-member still READS the result (showResults), they just can't cast.
  // See lib/writeAffordance. A guest keeps a live option row that reads as sign-in; the CHAMBER gate
  // below is a different thing and still hard-disables, because a non-member's cast can never tally.
  const mode = affordanceFor({ status: gate.status, writeReady: gate.writeReady });
  const gateDisabled = mode === "blocked";
  const blocked = closeState === "open" && chamberBlocksViewer(poll.kind, viewerRoles);
  const required = chamberRequiredRole(poll.kind);
  const label = required ? roleLabel(required) : "";
  // The setup hint wins over the chamber one: "sign in to vote" is the more actionable truth for
  // someone who is not signed in, and telling a guest "only SPOs can vote" first would read as a
  // permanent exclusion rather than a step they have not taken yet.
  const disabledHint =
    affordanceTitle(mode, "vote") ?? (blocked ? `Only ${label}s can vote` : undefined);
  const gateNotice = blocked
    ? `Only verified ${label}s can vote in this poll.`
    : undefined;
  return (
    <PollCard
      poll={poll}
      myChoice={myChoice}
      onVote={onVote}
      showResults={detail || blocked}
      disabled={gateDisabled || blocked}
      disabledHint={disabledHint}
      gateNotice={gateNotice}
      compact={!detail}
      closeState={closeState}
      // Only while open: `provisional`/`final` already say the deadline has passed, and pollClosesIn
      // returns null past it anyway, so this is belt-and-braces against a lagging head reading.
      closesIn={closeState === "open" ? pollClosesIn(poll.closeAt, bestBlock) : null}
      onFinalize={onFinalize}
      finalizing={finalizing}
    />
  );
}

export default InlinePoll;
