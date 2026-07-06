"use client";

// recentSearchStore — device-local recent search terms (client-only; NO chain state, nothing written
// to Cardano). The Explore SearchBar shows them in a dropdown when the box is focused-and-empty, so a
// prior query is one click away. Mirrors bookmarkStore, but the list is ORDERED (most-recent-first),
// deduped case-insensitively, and capped. Device-local by design — not synced to the chain or across
// devices. Exposed via useSyncExternalStore so the dropdown reflects a push/remove/clear instantly.

import { useSyncExternalStore } from "react";

const KEY = "cg-recent-searches";
const MAX = 8;
const EMPTY: readonly string[] = [];

let cache: string[] = load();
const listeners = new Set<() => void>();

function load(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, MAX)
      : [];
  } catch {
    return [];
  }
}

function commit(next: string[]): void {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota exceeded / storage disabled → keep the in-memory list only */
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
function getSnapshot(): readonly string[] {
  return cache;
}
function getServerSnapshot(): readonly string[] {
  return EMPTY;
}

export const recentSearchActions = {
  /** Record a term, moving it to the front (dedup case-insensitively) and capping the list. */
  push(term: string): void {
    const t = term.trim();
    if (t.length === 0) return;
    const lower = t.toLowerCase();
    const next = [t, ...cache.filter((x) => x.toLowerCase() !== lower)].slice(0, MAX);
    // No-op when already at the front with the same list — avoids a needless re-render.
    if (next.length === cache.length && next.every((x, i) => x === cache[i])) return;
    commit(next);
  },
  remove(term: string): void {
    const lower = term.toLowerCase();
    const next = cache.filter((x) => x.toLowerCase() !== lower);
    if (next.length === cache.length) return;
    commit(next);
  },
  clear(): void {
    if (cache.length === 0) return;
    commit([]);
  },
};

/** The recent-search terms, most-recent-first. Subscribes → re-renders on change. */
export function useRecentSearches(): readonly string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
