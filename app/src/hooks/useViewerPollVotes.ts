"use client";

// useViewerPollVotes — which of a set of polls the connected viewer has already cast in, so the
// governance list can be lensed down to what they still owe a vote on.
//
// One batched read for the whole set, not a point read per poll. It re-runs when the poll set changes or
// after the viewer casts (via `nonce`), not per block: a vote the viewer just made is reflected by the
// caller bumping the nonce, and a vote made in another tab shows on the next load. That matches the
// cadence of the poll layer rather than making the list the hottest reader on the page.
//
// Never throws: a failed read leaves the set EMPTY, which reads as "not voted" and can only ever show
// somebody a poll they have already dealt with. The opposite default would hide one they still owe.

import { useEffect, useMemo, useState } from "react";
import type { CognoApi, Ss58 } from "@/lib/types";
import { readViewerPollChoices } from "@/lib/chain/social-reads";

export function useViewerPollVotes(
  api: CognoApi | null,
  hostIds: readonly bigint[],
  who: Ss58 | null,
  nonce = 0,
): ReadonlySet<bigint> | null {
  const [voted, setVoted] = useState<ReadonlySet<bigint> | null>(null);

  // Key on the id SET, not the array identity: the caller rebuilds the list every render, and keying on
  // identity would re-fire the read continuously.
  const idKey = useMemo(() => hostIds.map(String).sort().join(","), [hostIds]);

  useEffect(() => {
    if (!api || !who || idKey === "") {
      setVoted(null);
      return;
    }
    let alive = true;
    // Rebuild the id list from the key so `hostIds` need not be a dep. Round-tripping through the key is
    // deliberate: it guarantees the read covers exactly the set the effect was keyed on.
    const ids = idKey.split(",").map((s) => BigInt(s));
    readViewerPollChoices(api, ids, who)
      .then((m) => {
        if (alive) setVoted(new Set(m.keys()));
      })
      .catch(() => {
        if (alive) setVoted(new Set());
      });
    return () => {
      alive = false;
    };
  }, [api, who, idKey, nonce]);

  return voted;
}

export default useViewerPollVotes;
