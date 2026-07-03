"use client";

// InlinePoll — a self-contained, votable poll attachment for a PostCard in a LIST context (timeline,
// profile, …) where the surface doesn't pre-fetch poll data the way ThreadView does for its focal
// post. It reads the shared session + fetches the poll via usePoll, then renders the same PollCard.
// PostCard stays presentational; this is the single poll piece that touches the session/reader seam,
// so polls render + vote inline in the feed instead of showing as plain text posts.

import { PollCard } from "./PollCard";
import { useSession } from "./Providers";
import { usePoll } from "@/hooks/usePoll";
import type { Viewer } from "./kit";

export interface InlinePollProps {
  /** The host post id (a poll's id == its host post id). */
  postId: bigint;
  /** Write-gate state — disables voting until the viewer is identity-bound. */
  gate: Viewer;
  /** Detail surface → always show results; list → compact, results after the viewer votes. */
  detail?: boolean;
}

export function InlinePoll({ postId, gate, detail }: InlinePollProps) {
  const { source, api, signer, bestBlock } = useSession();
  const { poll, myChoice, castVote } = usePoll(source, postId, api, signer, gate.address ?? null, bestBlock);
  if (!poll) return null; // still loading / no tallies — the post body already rendered above
  return (
    <PollCard
      poll={poll}
      myChoice={myChoice}
      onVote={castVote}
      showResults={detail}
      disabled={gate.status === "not-identity-bound"}
      compact={!detail}
    />
  );
}

export default InlinePoll;
