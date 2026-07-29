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
import type { PollVoter } from "@/lib/chain/social-reads";

export interface UsePollVoters {
  voters: PollVoter[] | null;
  /** The poll's option labels, in on-chain index order. Read with the roster, not borrowed. */
  labels: string[];
  /** More accounts have cast than are listed. Reported BY the read; never inferred from the list length. */
  truncated: boolean;
}

export function usePollVoters(
  source: FeedSource | null,
  hostId: bigint | null,
  isPoll: boolean,
  nonce = 0,
): UsePollVoters {
  const [voters, setVoters] = useState<PollVoter[] | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!source || hostId == null || !isPoll) {
      setVoters(null);
      setLabels([]);
      setTruncated(false);
      return;
    }
    let alive = true;
    source
      .pollVoters(hostId)
      .then((r) => {
        if (!alive) return;
        setVoters(r.voters);
        setLabels(r.labels);
        setTruncated(r.truncated);
      })
      .catch(() => {
        if (!alive) return;
        setVoters(null);
        setLabels([]);
        setTruncated(false);
      });
    return () => {
      alive = false;
    };
  }, [source, hostId, isPoll, nonce]);

  // `truncated` is passed through from the read rather than derived here. Deriving it as
  // `voters.length >= MAX_POLL_VOTERS` was wrong in both directions: the serve denylist filters the
  // roster after the cap has bitten, so one denied account inside the cap made a truncated list report
  // itself complete, and a poll with exactly 200 voters claimed a truncation that had not happened.
  return { voters, labels, truncated };
}

export default usePollVoters;
