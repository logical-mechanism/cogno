"use client";

// useReplyVoteChoices — the poll choices of the reply authors currently on screen in a poll thread, so
// each reply can carry its author's position beside their name.
//
// SCOPE. The account list is an input, not something this discovers: it asks for exactly the authors
// being rendered. That keeps the read bounded by the reply page size rather than by how many people
// voted, and it is why this cannot hand back a partial answer the way a capped whole-set enumeration
// would (see readPollChoices' header for the failure mode that rules out).
//
// NOT PER BLOCK. The deps deliberately exclude the chain head. The poll tallies three lines below this
// are read by usePoll, whose load effect does NOT re-run per block either — it refreshes on navigation
// and after the viewer's own cast. A chip row that re-read every 6 seconds would be the hottest thing on
// a thread and would still disagree with the bars beside it, so it follows the poll layer's cadence
// instead. A vote cast while a thread is open shows on the next load.
//
// Never throws: any read failure leaves `choices` null, and null renders no chips at all.

import { useEffect, useMemo, useRef, useState } from "react";
import type { FeedSource } from "@/lib/feed/source";
import type { Ss58 } from "@/lib/types";

export interface ReplyVoteChoices {
  /** Option labels in on-chain index order. Empty until the read lands, or when the host is not a poll. */
  labels: string[];
  /** author → their current option index, or null until the first read settles. */
  choices: Map<Ss58, number> | null;
}

const EMPTY: ReplyVoteChoices = { labels: [], choices: null };

export function useReplyVoteChoices(
  source: FeedSource | null,
  hostId: bigint | null,
  isPoll: boolean,
  authors: readonly Ss58[],
): ReplyVoteChoices {
  const [state, setState] = useState<ReplyVoteChoices>(EMPTY);

  // The effect keys on the author SET, not the array identity: ThreadView rebuilds the list on every
  // render, and keying on identity would re-fire the read continuously. Sorted so that a reordering
  // (paging revealing older replies above) is not mistaken for a new set.
  const authorKey = useMemo(() => [...authors].sort().join(","), [authors]);
  // Read inside the effect so `authors` itself is not a dep. The ref always holds the list the current
  // `authorKey` describes, because both are recomputed in the same render.
  const authorsRef = useRef(authors);
  authorsRef.current = authors;

  useEffect(() => {
    if (!source || hostId == null || !isPoll || authorKey === "") {
      setState(EMPTY);
      return;
    }
    let alive = true;
    source
      .pollChoices(hostId, authorsRef.current)
      .then((r) => {
        if (alive) setState({ labels: r.labels, choices: r.choices });
      })
      .catch(() => {
        // A failed read is indistinguishable from "nobody voted" to the reader either way, and the
        // honest rendering of both is no chip. Reset rather than leaving a stale map from another poll.
        if (alive) setState(EMPTY);
      });
    return () => {
      alive = false;
    };
  }, [source, hostId, isPoll, authorKey]);

  return state;
}

export default useReplyVoteChoices;
