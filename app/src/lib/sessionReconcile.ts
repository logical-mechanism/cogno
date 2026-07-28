// sessionReconcile — should this tab adopt a sign-out (or an account switch) performed in another tab?
//
// THE BUG. `useSigner` resolves the active key as `chosen ?? restoredSigner ?? fallback`. `chosen` is
// an in-memory shadow set by a fresh connect, an unlock, or a dev-account pick; `restoredSigner` is
// built from the crossTab `cg-session` record. So the in-memory shadow OUTRANKS the shared record, and
// the two effects that could have reacted both bail on `chosen` first.
//
// Connect in tab A (sets `chosen`), middle-click a post to open tab B (restores, `chosen` null), sign
// out in B. Tab A's storage listener fires, `record` goes null, and nothing changes: the seed is still
// in memory, so no wallet prompt is needed and that tab keeps posting, voting, following and editing
// the profile as the signed-out account until it is reloaded. The account chip in `useSigner`
// explicitly promises "the next load is a clean guest session"; on a shared browser that fails open.
//
// WHAT ADOPTION IS, AND IS NOT. The tab performs the LOCAL half of `disconnect` — abandon in-flight
// derives, drop the in-memory key, wallet id and address, reset the probe. It must NOT re-broadcast,
// and specifically must NOT call `clearRestoredSession()` or `clearAllPostDrafts()`: by the time a
// stale tab notices, the record and the drafts may already belong to the NEXT person, and wiping them
// would turn one bug into two. (`disconnect()` does clear both, which is correct for the tab the user
// actually clicked Sign out in, and is exactly why a stale tab must not run that path.)
//
// `recordSeen` IS LOAD-BEARING. `connectWallet` sets `chosen` and then writes the record, and
// `persistentStore.commit` swallows a storage throw — so on a browser with site data blocked the record
// never lands and a naive "record doesn't match chosen ⇒ sign out" would make signing in impossible.
// Adoption therefore only arms once this tab has actually SEEN a record agreeing with its own key.

import type { Ss58 } from "./types";

export interface SignOutAdoptionInput {
  /**
   * false during SSG and the hydration render. Until then `recordSs58 === null` means "not known yet",
   * not "signed out" — the same distinction the auth wall depends on.
   */
  hydrated: boolean;
  /** The in-memory chosen signer's account, or null when nothing is chosen this session. */
  chosenSs58: Ss58 | null;
  /** The chosen signer is a dev account (`//Alice`…), which by design never writes a record. */
  devChosen: boolean;
  /** The crossTab `cg-session` record's account, or null when there is none. */
  recordSs58: Ss58 | null;
  /** This tab has already observed a record agreeing with `chosenSs58` at least once. */
  recordSeen: boolean;
}

/**
 * True when the shared record has moved out from under this tab's in-memory key — signed out
 * elsewhere, or a different account signed in elsewhere — and the tab should drop to what the record
 * says.
 */
export function shouldAdoptSignOut(input: SignOutAdoptionInput): boolean {
  const { hydrated, chosenSs58, devChosen, recordSs58, recordSeen } = input;
  if (!hydrated) return false; // a null record here is "not hydrated", not "signed out"
  if (chosenSs58 === null) return false; // nothing in memory to tear down
  if (devChosen) return false; // dev accounts are chosen without a record, by design
  if (!recordSeen) return false; // never established → storage may simply be unwritable
  return recordSs58 !== chosenSs58;
}
