"use client";

// recentSearchStore — device-local recent search terms (client-only; NO chain state, nothing written
// to Cardano). The Explore SearchBar shows them in a dropdown when the box is focused-and-empty, so a
// prior query is one click away. The list is ORDERED (most-recent-first), deduped case-insensitively,
// and capped. Cross-tab synced (via the shared store factory) so the dropdown reflects another tab's
// searches. Device-local by design — not synced to the chain or across devices.

import { useSyncExternalStore } from "react";
import { createPersistentStore } from "./persistentStore";

const KEY = "cg-recent-searches";
const MAX = 8;
const EMPTY: readonly string[] = [];

function parse(raw: string | null): string[] {
  const parsed: unknown = raw ? JSON.parse(raw) : [];
  return Array.isArray(parsed)
    ? parsed.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, MAX)
    : [];
}

const store = createPersistentStore<readonly string[]>({
  key: KEY,
  empty: EMPTY,
  parse,
  serialize: (v) => JSON.stringify(v),
  crossTab: true, // keep the dropdown in sync with searches made in other tabs
});

export const recentSearchActions = {
  /** Record a term, moving it to the front (dedup case-insensitively) and capping the list. */
  push(term: string): void {
    const t = term.trim();
    if (t.length === 0) return;
    const lower = t.toLowerCase();
    const cache = store.read();
    const next = [t, ...cache.filter((x) => x.toLowerCase() !== lower)].slice(0, MAX);
    // No-op when already at the front with the same list — avoids a needless re-render.
    if (next.length === cache.length && next.every((x, i) => x === cache[i])) return;
    store.commit(next);
  },
  remove(term: string): void {
    const lower = term.toLowerCase();
    const cache = store.read();
    const next = cache.filter((x) => x.toLowerCase() !== lower);
    if (next.length === cache.length) return;
    store.commit(next);
  },
  clear(): void {
    if (store.read().length === 0) return;
    store.commit([]);
  },
};

/** The recent-search terms, most-recent-first. Subscribes → re-renders on change. */
export function useRecentSearches(): readonly string[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
