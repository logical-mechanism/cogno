"use client";

// InlinePoll — a self-contained, votable poll attachment for a PostCard in a LIST context (timeline,
// profile, …) where the surface doesn't pre-fetch poll data the way ThreadView does for its focal
// post. It reads the shared session + fetches the poll via usePoll, then renders the same PollCard.
// PostCard stays presentational; this is the single poll piece that touches the session/reader seam,
// so polls render + vote inline in the feed instead of showing as plain text posts.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { PollCard } from "./PollCard";
import { useSession } from "./Providers";
import { usePoll } from "@/hooks/usePoll";
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
  const { poll, myChoice, castVote } = usePoll(source, postId, api, signer, gate.address ?? null, bestBlock);
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
  if (!poll) return null; // still loading / no tallies — the post body already rendered above
  return (
    <PollCard
      poll={poll}
      myChoice={myChoice}
      onVote={onVote}
      showResults={detail}
      disabled={gate.status === "not-identity-bound"}
      compact={!detail}
    />
  );
}

export default InlinePoll;
