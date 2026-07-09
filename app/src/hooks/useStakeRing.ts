"use client";

// useStakeRing — the avatar's stake-tier ring descriptor for one account, or null when there's nothing
// to draw. Composes the two shared, batched caches (`useAuthorWeight` = TalkStake.VotingPower;
// `useAuthorReputation` = AccountVoteTally net score) through the pure `avatarRing` decision. Both
// underlying hooks self-register their address for a batched read and dedup app-wide, so this shares
// reads with the existing ReputationBadge — an author on screen costs one weight read + one tally read,
// no matter how many of their avatars render.
//
// Returns null (no ring) for the common fresh-chain case: zero/unknown stake AND non-negative
// reputation. A negative reputation always yields a danger ring, even at tier 0.

import { useAuthorWeight } from "./useAuthorWeight";
import { useAuthorReputation } from "./useReputation";
import { avatarRing, type AvatarRingView } from "@/lib/stake";

export function useStakeRing(address: string | undefined): AvatarRingView | null {
  const weight = useAuthorWeight(address);
  const reputation = useAuthorReputation(address);
  return avatarRing(weight, reputation);
}
