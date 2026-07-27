"use client";

// bookmarkStore — device-local "saved posts" (client-only; NO chain state, no writing to Cardano).
// A viewer bookmarks a post to find it again on the /bookmarks surface (a personal shortlist — it
// never changes what anyone else sees, and nothing is written to the chain). Never synced to the chain
// or across devices, but it DOES mirror across this device's tabs, and it is scoped PER ACCOUNT so a
// shared device doesn't show one wallet's saved posts to the next.
//
// A typed bigint facade over the shared viewer-scoped set store: post ids are `bigint` (not
// JSON-serializable), so they persist as their decimal string form and re-parse with BigInt() on read.
// The /^\d+$/ guard is load-bearing, not cosmetic — `useBookmarkList` calls BigInt(s), which throws on
// anything else and would take /bookmarks down with it.

import { createViewerScopedStringSetStore } from "./stringSetStore";
import type { Ss58 } from "./types";

/**
 * Capped because /bookmarks resolves the WHOLE set on mount, in one unbounded `Promise.all` of
 * `source.thread(id)` reads. Uncapped, a set built up over a long session is a burst of that many
 * concurrent node reads on every visit to the page. Well above any realistic saved list.
 */
export const MAX_BOOKMARKS = 500;

const store = createViewerScopedStringSetStore({
  prefix: "cg-bookmarks",
  isValid: (v) => /^\d+$/.test(v),
  max: MAX_BOOKMARKS,
  // Shipped device-global before per-account bucketing, so its bare key is claimable once.
  claimLegacy: true,
});

/** Bookmark actions bound to `who` (null = the signed-out device bucket). */
export function bookmarkActionsFor(who: Ss58 | null) {
  const a = store.actionsFor(who);
  return {
    add: (id: bigint) => a.add(String(id)),
    remove: (id: bigint) => a.remove(String(id)),
    toggle: (id: bigint) => a.toggle(String(id)),
  };
}

/** Is post `id` bookmarked by `who`? Subscribes, so the caller re-renders when the set changes. */
export function useBookmarked(id: bigint | null | undefined, who: Ss58 | null): boolean {
  const snap = store.useSet(who);
  return id != null && snap.has(String(id));
}

/** `who`'s bookmarked post ids (for the /bookmarks route + the Settings launcher count). */
export function useBookmarkList(who: Ss58 | null): bigint[] {
  const snap = store.useSet(who);
  return [...snap].map((s) => BigInt(s));
}
