"use client";

// InlinePoll — a self-contained, votable poll attachment for a PostCard in a LIST context (timeline,
// profile, …) where the surface doesn't pre-fetch poll data the way ThreadView does for its focal
// post. It reads the shared session + fetches the poll via usePoll, then renders the same PollCard.
// PostCard stays presentational; this is the single poll piece that touches the session/reader seam,
// so polls render + vote inline in the feed instead of showing as plain text posts.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { PollCard } from "./PollCard";
import { Skeleton } from "./Skeleton";
import { useSession } from "./Providers";
import { usePoll } from "@/hooks/usePoll";
import styles from "./InlinePoll.module.css";
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
  const router = useRouter();
  const { source, api, signer, bestBlock } = useSession();
  const { poll, myChoice, castVote, loading, error, provisional, finalize, finalizing, reload } = usePoll(
    source,
    postId,
    api,
    signer,
    gate.address ?? null,
    bestBlock,
  );
  // Casting a poll vote is a mutating write — funnel an unfinished-setup viewer to /welcome instead of
  // casting. usePoll.castVote has NO gate of its own, so this is the single enforcement point for inline
  // poll votes (the mandatory stake step is not a pool gate, so the UI must hold the line).
  const onVote = useCallback(
    (index: number) => {
      if (!gate.writeReady) return void router.push("/welcome/");
      castVote(index);
    },
    [gate.writeReady, router, castVote],
  );
  // Finalizing (`close_poll`) is a permissionless mutating write too — same write-gate funnel.
  const onFinalize = useCallback(() => {
    if (!gate.writeReady) return void router.push("/welcome/");
    finalize();
  }, [gate.writeReady, router, finalize]);
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
  return (
    <PollCard
      poll={poll}
      myChoice={myChoice}
      onVote={onVote}
      showResults={detail}
      disabled={gate.status === "not-identity-bound"}
      disabledHint="Finish setup to vote"
      compact={!detail}
      closeState={closeState}
      onFinalize={onFinalize}
      finalizing={finalizing}
    />
  );
}

export default InlinePoll;
