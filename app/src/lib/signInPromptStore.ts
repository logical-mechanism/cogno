"use client";

// signInPromptStore — drives the in-place sign-in sheet.
//
// WHY IT REPLACES A NAVIGATION. Every write affordance used to answer a not-ready viewer with
// `router.push("/welcome/")`. That unmounts <main>: the feed's live subscription drops, its loaded
// pages and scroll position are gone, and a reader who tapped Like on something halfway down the
// timeline comes back to the top of a fresh feed, if they come back at all. The click also gave no
// explanation for why they were suddenly somewhere else. A sheet over the current surface keeps the
// page mounted, so the answer to "why can't I do this" arrives without taking the page away.
//
// WHAT IT DOES NOT DO: replay the action afterwards. That was the obvious next feature and it is a
// trap. A cold guest cannot finish setup in this sitting (the lock alone settles in 10 minutes on
// preprod and up to 36 hours on mainnet), so a promise to "finish your like once you're set up" would
// be a lie on the path that matters. And for the one viewer who CAN finish in seconds (a restored
// session that just needs an unlock), replaying is still wrong for votes and follows: those are
// permanent, public, stake-weighted chain writes with no delete, and emitting one because a stranger
// tapped a heart before they had an identity is a write the signed-in user never confirmed. Because
// the sheet leaves the page mounted, the control they reached for is still right there underneath.
// One more tap is the correct cost. This is what X does.
//
// A module-level singleton with useSyncExternalStore, mirroring lib/modalStore — deliberately, because
// the gate is consumed from inside `useMemo` bodies and mutation callbacks that import the actions
// directly rather than taking them as deps (see usePostActions).

import { useSyncExternalStore } from "react";

/**
 * What the viewer reached for, so the sheet can name it instead of asking generically.
 *
 * WRITE INTENTS ONLY. There was a `"settings"` member here and nothing ever opened with it: a walled
 * ROUTE is answered by WalledRouteNotice on the page itself, not by this sheet, so /settings never
 * reaches here. It cost more than a dead line — the sheet body carried a `reason === "settings" ?
 * "use settings" : reason` branch that could not be taken, and its presence invited someone to wire a
 * route through the sheet and end up with two answers to one block. If a new member is added it should
 * be a verb a user pressed, and it must have a caller.
 */
export type SignInReason = "post" | "reply" | "quote" | "vote" | "follow";

export interface SignInPromptState {
  open: boolean;
  reason: SignInReason;
}

const CLOSED: SignInPromptState = { open: false, reason: "post" };

let state: SignInPromptState = CLOSED;
const listeners = new Set<() => void>();

function set(next: SignInPromptState) {
  if (next.open === state.open && next.reason === state.reason) return;
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): SignInPromptState => state;
/** SSG-safe: the server snapshot is always closed. */
const getServerSnapshot = (): SignInPromptState => CLOSED;

export const signInPromptActions = {
  open: (reason: SignInReason) => set({ open: true, reason }),
  close: () => set(CLOSED),
};

export function useSignInPrompt(): SignInPromptState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
