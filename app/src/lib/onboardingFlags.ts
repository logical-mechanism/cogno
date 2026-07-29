"use client";

// onboardingFlags — per-account, device-local record of onboarding choices the user has already made,
// so a step they dismissed does not reappear on every reload of a wait that can run 36 hours.
//
// Bucketed per account (`<prefix>:<ss58>`, `:anon` signed out) via the shared viewer-scoped store, for
// the reason every other client store is: a shared device must not hand one wallet's onboarding state
// to the next. No `claimLegacy` — this store is per-account from birth, so there is no bare
// pre-namespacing key to adopt, and reading one we never wrote would pick up whatever lives there.

import { createViewerScopedStringSetStore } from "./stringSetStore";

export const onboardingFlagStore = createViewerScopedStringSetStore({
  prefix: "cg:onboarding-flags",
  // Our own fixed slugs, never user input. Bounded anyway so a hand-edited value cannot grow the key.
  isValid: (v) => /^[a-z-]{1,40}$/.test(v),
  max: 16,
});

/**
 * The user chose "Skip for now" on the voting-power step.
 *
 * This suppresses the STEP, not the consequence. Their votes still carry no weight and the vote
 * surfaces still say so on every weightless vote, because that stays true until they bind. Skipping is
 * a statement about this screen, not a waiver of the disclosure.
 */
export const SKIPPED_VOTING_POWER = "skipped-voting-power";
