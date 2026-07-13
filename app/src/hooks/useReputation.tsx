"use client";

// useReputation — a session-lived, shared cache of each account's NET stake-weighted community
// reputation (`Microblog.AccountVoteTally`: up_weight − down_weight; may be negative). It powers the
// small reputation badge next to an author's name on every post header (a quick "good actor vs troll"
// signal, so you don't have to open the profile), and is the seam a future "hide low-reputation"
// timeline filter can read from.
//
// A `<ReputationBadge address>` leaf consumes it, mirroring how `<ProfileHoverCard>` reads from the
// session inside the header — so `PostCard` itself stays presentational, importing no reader.
//
// ERROR POLICY = retry: a failed read is uncommitted, so the author is re-read the next time a badge
// for them mounts. The value is a COARSE hint, so session-cache staleness (a vote cast elsewhere) is
// acceptable, and a hidden badge is visually identical to the common net-zero case.
//
// The batching / coalescing / StrictMode scaffold lives in createChainCache — this file used to be a
// 138-line copy of it.

import { createChainCache } from "./createChainCache";
import { readAccountVoteTally, type Tally } from "@/lib/chain/social-reads";
import type { Ss58 } from "@/lib/types";

// The cache holds the WHOLE tally, not just the net score. `readAccountVoteTally` was always returning
// up/down weight + up/down counts and this cache was discarding four of the five fields — so the account
// vote control, which needs all of them, had to source its tally from somewhere else entirely (the
// profile page's big `profile()` read). Widening the value costs nothing on the wire (it is one keyed
// read either way) and means the badge, the avatar ring and the vote control now share ONE cache entry
// per account: invalidating after a vote refreshes all three, and the vote control's score is already
// warm before the mouse reaches a hover card (every feed avatar registers the key via useStakeRing).
const cache = createChainCache<Ss58, Tally>({
  name: "AccountTally",
  toKey: (a) => a,
  read: (api, account) => readAccountVoteTally(api, account),
  onError: { mode: "retry" },
});

export const ReputationProvider = cache.Provider;

/** The cached net reputation score for one author, or `null` while unknown / loading. */
export function useAuthorReputation(address: Ss58 | undefined): bigint | null {
  return cache.useValue(address)?.score ?? null;
}

/** The cached full reputation tally (weights + counts + net score), or `null` while unknown / loading. */
export function useAccountTally(address: Ss58 | undefined): Tally | null {
  return cache.useValue(address);
}

/** Drop cached tallies so the next consumer re-reads them (called after a vote lands on an account). */
export const useInvalidateReputation = cache.useInvalidate;
