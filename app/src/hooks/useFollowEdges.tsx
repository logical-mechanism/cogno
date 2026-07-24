"use client";

// useFollowEdges — one shared, app-wide cache of "who does this account follow / who follows it",
// keyed by account.
//
// WHY IT EXISTS. A single cold load of Home resolved the SAME question four independent times:
//   • page.tsx's `followeesEmpty` probe (does the viewer follow anyone at all?)
//   • `useFollow` mounted by page.tsx (the isFollowing map behind every card's Follow button)
//   • `useFollow` mounted AGAIN by RightRail, which AppShell renders alongside Home
//   • `useWhoToFollow`, which reads it purely to filter already-followed accounts out of suggestions
// Four copies of one answer, each of which was itself a four-read fan-out. Through this cache — and
// `MicroblogApi.follow_edges`, the one-call runtime API that shipped in the descriptors and had no
// caller — it is one `state_call`.
//
// The follow graph is public chain state, so there is no privacy dimension here; the only correctness
// requirement is that a follow/unfollow INVALIDATES it, which useFollow does on confirm. Between
// writes it is stable (nothing else moves it), so no TTL is warranted — and `createChainCache` already
// drops everything on an endpoint change.

import { createChainCache } from "./createChainCache";
import { nodeFollowEdges } from "@/lib/chain/node-reads";
import type { FollowEdges, Ss58 } from "@/lib/types";

const EMPTY: FollowEdges = { following: [], followers: [], followerCount: 0, followingCount: 0 };

const cache = createChainCache<Ss58, FollowEdges>({
  name: "FollowEdgesCache",
  toKey: (who) => who,
  read: (api, who) => nodeFollowEdges(api, who),
  // RETRY, not commit-empty. An empty follow graph is a real, common answer (a new account follows
  // nobody), so committing EMPTY on a transient failure would be indistinguishable from the truth —
  // and it drives the Following tab's empty state and every Follow button's label. Uncommit and re-read
  // on the next mount instead.
  onError: { mode: "retry" },
});

export const FollowEdgesProvider = cache.Provider;

/** The follow graph for `who`, or null while unknown/loading. `undefined` = nothing to look up. */
export function useFollowEdgesFor(who: Ss58 | null | undefined): FollowEdges | null {
  return cache.useValue(who ?? undefined);
}

/** Re-read `who`'s follow graph — call after a follow/unfollow lands. */
export function useInvalidateFollowEdges(): (...who: Ss58[]) => void {
  return cache.useInvalidate();
}

/** The empty graph, for a caller that needs a non-null value while the read is in flight. */
export { EMPTY as EMPTY_FOLLOW_EDGES };
