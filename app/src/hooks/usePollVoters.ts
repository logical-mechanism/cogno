"use client";

// usePollVoters — the roster behind a governance poll: everyone who has cast, with their choice.
//
// Read once per poll, not per block, for the same reason the reply vote chip is: usePoll's own load
// effect does not re-run per block either, so a roster that refreshed every 6 seconds would be the
// hottest reader on the page and would still disagree with the bars above it. `nonce` lets a surface
// force a re-read after the viewer's own cast, which is the one change they expect to see immediately.
//
// Never throws: a read failure leaves the list null, which renders nothing at all rather than an empty
// roster. Those are different claims, and "nobody voted" is not one to make on a failed read.

import { useEffect, useState } from "react";
import type { FeedSource } from "@/lib/feed/source";
import { MAX_POLL_VOTERS, type PollVoter } from "@/lib/chain/social-reads";

export interface UsePollVoters {
  voters: PollVoter[] | null;
  /** The read came back at the cap, so there are more voters than are listed. */
  truncated: boolean;
}

export function usePollVoters(
  source: FeedSource | null,
  hostId: bigint | null,
  isPoll: boolean,
  nonce = 0,
): UsePollVoters {
  const [voters, setVoters] = useState<PollVoter[] | null>(null);

  useEffect(() => {
    if (!source || hostId == null || !isPoll) {
      setVoters(null);
      return;
    }
    let alive = true;
    source
      .pollVoters(hostId)
      .then((v) => {
        if (alive) setVoters(v);
      })
      .catch(() => {
        if (alive) setVoters(null);
      });
    return () => {
      alive = false;
    };
  }, [source, hostId, isPoll, nonce]);

  // Exactly at the cap is the only signal available that more exist, and it can be a false positive when
  // a poll has precisely MAX_POLL_VOTERS voters. Over-disclosing is the right error: the copy says the
  // list may be incomplete, which stays true either way.
  return { voters, truncated: voters != null && voters.length >= MAX_POLL_VOTERS };
}

export default usePollVoters;
