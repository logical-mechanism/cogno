"use client";

// useAccountVoteState — a session-lived, shared cache of everything the reputation vote control needs
// about one (account, viewer) pair: the account's whole tally AND the viewer's own vote on it, read
// TOGETHER and committed as ONE value.
//
// The atomicity is the point, not an optimization. The vote control layers the viewer's unconfirmed
// intent over this base by re-deriving the delta from `base.myVote` (see lib/accountVote), which is only
// sound if `myVote` and the weights come from the SAME snapshot. Split them across two caches and they
// commit in two separate React renders — and in the window between, the tally has already absorbed your
// vote while `myVote` still reads `null`, so the rebase applies your weight A SECOND TIME. The score
// visibly jumps to base + 2× your weight and then snaps back. One key, one read, one commit, no window.
//
// It is deliberately NOT the same cache as the account tally in useReputation. That one is a property of
// the ACCOUNT (every viewer sees the same tally), so it is address-keyed and shared by the feed's
// reputation badges and avatar rings. This is a property of the PAIR — and keying the viewer in is what
// makes an in-place account switch safe: viewer B can never be served viewer A's lit arrow.
//
// ERROR POLICY = retry. A failed read must NOT commit: `myVote: null` ("has not voted") is a real value
// here, and committing it on a failure would show an unlit arrow on a vote already on chain — and then
// let the viewer cast a duplicate.

import { createChainCache } from "./createChainCache";
import { readAccountVoteTally, readViewerAccountVote, type Tally } from "@/lib/chain/social-reads";
import type { Ss58 } from "@/lib/types";

/** One (account, viewer) pair. */
export interface AccountVoteStateKey {
  target: Ss58;
  viewer: Ss58;
}

/** The account's tally and the viewer's own vote on it, from a single read. */
export interface AccountVoteState {
  tally: Tally;
  /** The viewer's vote, or `null` for "has not voted" — a real value, not "unknown". */
  myVote: "Up" | "Down" | null;
}

const cache = createChainCache<AccountVoteStateKey, AccountVoteState>({
  name: "AccountVoteState",
  toKey: (k) => `${k.target}|${k.viewer}`,
  read: async (api, k) => {
    // ONE await: both halves resolve together, so the cache commits them together.
    const [tally, myVote] = await Promise.all([
      readAccountVoteTally(api, k.target),
      readViewerAccountVote(api, k.target, k.viewer),
    ]);
    return { tally, myVote };
  },
  onError: { mode: "retry" },
});

export const AccountVoteStateProvider = cache.Provider;

/** The vote state for one (target, viewer) pair, or `null` while loading (NOT "has not voted"). */
export const useAccountVoteState = cache.useValue;

/** Drop a cached pair so it is re-read (called once the viewer's vote lands on chain). */
export const useInvalidateAccountVoteState = cache.useInvalidate;
