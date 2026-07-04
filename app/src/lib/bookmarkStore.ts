"use client";

// bookmarkStore — device-local "saved posts" (client-only; NO chain state, no writing to Cardano).
// A viewer bookmarks a post to find it again on the /bookmarks surface (a personal shortlist — it
// never changes what anyone else sees, and nothing is written to the chain). Mirrors muteStore, with
// ONE difference: post ids are `bigint` (not JSON-serializable), so they're persisted as their string
// form under localStorage['cg-bookmarks'] and re-parsed with BigInt() on read. Exposed via
// useSyncExternalStore so any component (PostCard's ··· menu, the /bookmarks list, a Settings launcher)
// reflects a save/unsave instantly. Device-local by design — not synced to the chain or across devices.

import { useSyncExternalStore } from "react";

const KEY = "cg-bookmarks";
const EMPTY: ReadonlySet<string> = new Set();

let cache: Set<string> = load();
const listeners = new Set<() => void>();

function load(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    // Keep only well-formed decimal id strings (a bigint round-trips as digits); ignore anything else.
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === "string" && /^\d+$/.test(x))
        : [],
    );
  } catch {
    return new Set();
  }
}

function commit(next: Set<string>): void {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {
    /* quota exceeded / storage disabled → keep the in-memory set only */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// getSnapshot returns a STABLE ref between changes (commit swaps it) so useSyncExternalStore only
// re-renders on a real change; getServerSnapshot is a constant for static export / hydration.
function getSnapshot(): ReadonlySet<string> {
  return cache;
}
function getServerSnapshot(): ReadonlySet<string> {
  return EMPTY;
}

export const bookmarkActions = {
  add(id: bigint): void {
    const s = String(id);
    if (cache.has(s)) return;
    commit(new Set(cache).add(s));
  },
  remove(id: bigint): void {
    const s = String(id);
    if (!cache.has(s)) return;
    const next = new Set(cache);
    next.delete(s);
    commit(next);
  },
  toggle(id: bigint): void {
    if (cache.has(String(id))) bookmarkActions.remove(id);
    else bookmarkActions.add(id);
  },
};

/** Is post `id` bookmarked? Subscribes, so the caller re-renders when the bookmark set changes. */
export function useBookmarked(id: bigint | null | undefined): boolean {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return id != null && snap.has(String(id));
}

/** The full bookmarked post-id list (for the /bookmarks route + the Settings launcher count). */
export function useBookmarkList(): bigint[] {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [...snap].map((s) => BigInt(s));
}
