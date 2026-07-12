"use client";

// bookmarkStore — device-local "saved posts" (client-only; NO chain state, no writing to Cardano).
// A viewer bookmarks a post to find it again on the /bookmarks surface (a personal shortlist — it
// never changes what anyone else sees, and nothing is written to the chain). Device-local by design —
// not synced to the chain or across devices, but DOES mirror across this device's tabs.
//
// A typed bigint facade over the shared string-set store: post ids are `bigint` (not JSON-serializable),
// so they persist as their decimal string form and re-parse with BigInt() on read. The /^\d+$/ guard is
// load-bearing, not cosmetic — `useBookmarkList` calls BigInt(s), which throws on anything else and
// would take /bookmarks down with it.

import { createStringSetStore } from "./stringSetStore";

const store = createStringSetStore("cg-bookmarks", (v) => /^\d+$/.test(v));

export const bookmarkActions = {
  add: (id: bigint) => store.add(String(id)),
  remove: (id: bigint) => store.remove(String(id)),
  toggle: (id: bigint) => store.toggle(String(id)),
};

/** Is post `id` bookmarked? Subscribes, so the caller re-renders when the bookmark set changes. */
export function useBookmarked(id: bigint | null | undefined): boolean {
  const snap = store.useSet();
  return id != null && snap.has(String(id));
}

/** The full bookmarked post-id list (for the /bookmarks route + the Settings launcher count). */
export function useBookmarkList(): bigint[] {
  const snap = store.useSet();
  return [...snap].map((s) => BigInt(s));
}
