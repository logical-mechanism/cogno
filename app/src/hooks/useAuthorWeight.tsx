"use client";

// useAuthorWeight — a session-lived, shared cache of each account's Cardano-sourced talk WEIGHT
// (`TalkStake.VotingPower`, lovelace: the observer-written epoch stake of its bound stake credential).
// It drives the stake-tier avatar ring (useStakeRing). 0n for an account with no stake-credential bind
// (most accounts) → no ring.
//
// ERROR POLICY = retry: a failed read is uncommitted and re-read the next time an avatar for that
// author mounts. Epoch stake changes at most once per Cardano epoch, so session-cache staleness is
// fine — a reload refreshes it.
//
// The batching / coalescing / StrictMode scaffold lives in createChainCache — this file used to be a
// 137-line copy of it.

import { createChainCache } from "./createChainCache";
import { readVotingPower } from "@/lib/chain/social-reads";
import type { Ss58 } from "@/lib/types";

const cache = createChainCache<Ss58, bigint>({
  name: "AuthorWeight",
  toKey: (a) => a,
  read: (api, account) => readVotingPower(api, account),
  onError: { mode: "retry" },
});

export const AuthorWeightProvider = cache.Provider;

/** The cached talk weight (lovelace) for one author, or `null` while unknown / loading. */
export function useAuthorWeight(address: Ss58 | undefined): bigint | null {
  return cache.useValue(address);
}

export const useInvalidateAuthorWeight = cache.useInvalidate;
