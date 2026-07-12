"use client";

// useAccountProfile — a session-lived, shared cache of each account's profile display name + avatar.
// A mention chip, a hover card, an author line: the same account recurs across dozens of cards and
// every surface, and keying by account means it costs exactly ONE read no matter how many are on screen.
//
// ERROR POLICY = commit-empty, and this is the ONE cache that differs. A failed or absent read resolves
// to `{}` and is NEVER retried, so a mention chip settles on its truncated-ss58 fallback — visually
// identical to a genuinely unbound/nameless account — instead of thrashing a read every time it scrolls
// back into view. That is a deliberate product call, not drift: for a cosmetic label, thrashing is worse
// than stale. A reload refetches.
//
// (Contrast useReputation / useAuthorWeight / useNestedQuote, which uncommit a failure and retry on the
// next mount. The shared factory takes the policy as a parameter for exactly this reason.)
//
// The batching / coalescing / StrictMode scaffold lives in createChainCache — this file used to be a
// 140-line copy of it.

import { createChainCache } from "./createChainCache";
import { binTextOpt } from "@/lib/chain/reads";
import type { CognoApi, Ss58 } from "@/lib/types";

/** A resolved (possibly empty) profile snapshot for one account. */
export interface AccountProfile {
  displayName?: string;
  avatar?: string;
}

/** Read one `Profile.Profiles` row → the display name + avatar (both BoundedVec<u8> → trimmed string). */
async function readAccountProfile(api: CognoApi, account: Ss58): Promise<AccountProfile> {
  // The ROW is optional; the FIELDS are not — keep the `rec?.` chain rather than marking them optional.
  const rec = await api.query.Profile.Profiles.getValue(account);
  return { displayName: binTextOpt(rec?.display_name), avatar: binTextOpt(rec?.avatar) };
}

const EMPTY: AccountProfile = {};

const cache = createChainCache<Ss58, AccountProfile>({
  name: "AccountProfile",
  toKey: (a) => a,
  read: readAccountProfile,
  onError: { mode: "commit", fallback: EMPTY },
});

export const AccountProfileProvider = cache.Provider;

/** The cached display name + avatar for one account, or `null` while unknown / loading. */
export function useAccountProfile(address: Ss58 | undefined): AccountProfile | null {
  return cache.useValue(address);
}

/**
 * Drop cached profiles so the next consumer re-reads them. Wired to the profile-save confirm: without
 * it, editing your own profile leaves every mention chip and hover card showing the OLD name and avatar
 * for the rest of the session.
 */
export const useInvalidateAccountProfile = cache.useInvalidate;
