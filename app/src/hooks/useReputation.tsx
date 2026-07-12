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
import { readAccountVoteTally } from "@/lib/chain/social-reads";
import type { Ss58 } from "@/lib/types";

const cache = createChainCache<Ss58, bigint>({
  name: "Reputation",
  toKey: (a) => a,
  read: async (api, account) => (await readAccountVoteTally(api, account)).score,
  onError: { mode: "retry" },
});

export const ReputationProvider = cache.Provider;

/** The cached net reputation score for one author, or `null` while unknown / loading. */
export function useAuthorReputation(address: Ss58 | undefined): bigint | null {
  return cache.useValue(address);
}

/** Drop cached scores so the next badge that mounts re-reads them (e.g. after voting on an account). */
export const useInvalidateReputation = cache.useInvalidate;
