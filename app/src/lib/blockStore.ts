"use client";

// blockStore — device-local "blocked accounts" (client-only; NO chain state, no writing to Cardano).
// A viewer HARD-suppresses a blocked author: their posts, replies, quotes, search/People rows,
// who-to-follow suggestions and notifications are removed from THIS viewer's view on THIS device —
// with no "Show" stub (that soft collapse is muteStore). Block is stronger than mute; it is the
// viewer's own choice and changes nothing for anyone else.
//
// IMPORTANT (and why the copy must not over-promise): a client-side block is viewer-side only. It
// cannot stop a blocked account from seeing your public, permanent posts, replying to them, or quoting
// them on-chain. It removes them from YOUR view, nothing more.
//
// Same viewer-scoped device-local set as muteStore/bookmarkStore — keyed by ss58, per account, mirrored
// across this device's tabs. The validity guard rejects the empty string on read and write.

import { createViewerScopedStringSetStore } from "./stringSetStore";
import type { Ss58 } from "./types";

const store = createViewerScopedStringSetStore({
  prefix: "cg-blocked",
  isValid: (v) => v.length > 0,
});

/** Block actions bound to `who` (null = the signed-out device bucket). */
export function blockActionsFor(who: Ss58 | null) {
  const a = store.actionsFor(who);
  return {
    block: (addr: Ss58) => a.add(addr),
    unblock: (addr: Ss58) => a.remove(addr),
    toggle: (addr: Ss58) => a.toggle(addr),
  };
}

/** Is `addr` blocked by `who`? Subscribes, so the caller re-renders when the block set changes. */
export function useBlocked(addr: Ss58 | null | undefined, who: Ss58 | null): boolean {
  const snap = store.useSet(who);
  return addr != null && snap.has(addr);
}

/** `who`'s blocked-account list (for the Settings manager). */
export function useBlockedList(who: Ss58 | null): Ss58[] {
  return [...store.useSet(who)] as Ss58[];
}

/** The raw subscribing set (for useModeration's `filterPosts`). */
export function useBlockedSet(who: Ss58 | null): ReadonlySet<string> {
  return store.useSet(who);
}
