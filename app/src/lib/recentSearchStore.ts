"use client";

// recentSearchStore — device-local recent search terms (client-only; NO chain state, nothing written
// to Cardano). The Explore SearchBar shows them in a dropdown when the box is focused-and-empty, so a
// prior query is one click away. The list is ORDERED (most-recent-first), deduped case-insensitively,
// and capped. Cross-tab synced so the dropdown reflects another tab's searches.
//
// PER ACCOUNT, via lib/viewerScopedStore. It used to be one device-global key, and `useSigner`
// compensated by explicitly wiping the list on sign-out so it could not resurface for whoever
// connected next. That covered sign-out but NOT an in-place account switch, and it cost something: it
// threw away the signed-out person's own history, which they would reasonably expect back — the same
// expectation the privacy page states for bookmarks and mutes. Bucketing gets both right and deletes
// the special case.
//
// Search terms are ordinary text, so unlike the set stores there is no element-validity predicate worth
// enforcing beyond non-empty — a junk term is a useless dropdown row, never a crash.

import { createViewerScopedStore } from "./viewerScopedStore";
import type { Ss58 } from "./types";

const MAX = 8;
const EMPTY: readonly string[] = [];

const store = createViewerScopedStore<readonly string[]>({
  prefix: "cg-recent-searches",
  empty: EMPTY,
  parse: (raw) => {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, MAX)
      : [];
  },
  // NOT sorted: order IS the value here (most-recent-first). The set stores sort only to stop the
  // cross-tab change-detector reading insertion order as a change; doing that here would destroy recency.
  serialize: (v) => JSON.stringify(v),
  // Was device-global under this exact key, so let the first real account claim what is already there
  // instead of appearing to lose its history on upgrade.
  claimLegacy: true,
});

/** Recent-search actions bound to `who` (null = the signed-out device bucket). */
export function recentSearchActionsFor(who: Ss58 | null) {
  return {
    /** Record a term, moving it to the front (dedup case-insensitively) and capping the list. */
    push(term: string): void {
      const t = term.trim();
      if (t.length === 0) return;
      const lower = t.toLowerCase();
      const cache = store.readFor(who);
      const next = [t, ...cache.filter((x) => x.toLowerCase() !== lower)].slice(0, MAX);
      // No-op when already at the front with the same list — avoids a needless re-render.
      if (next.length === cache.length && next.every((x, i) => x === cache[i])) return;
      store.update(who, () => next);
    },
    remove(term: string): void {
      const lower = term.toLowerCase();
      const cache = store.readFor(who);
      const next = cache.filter((x) => x.toLowerCase() !== lower);
      if (next.length === cache.length) return;
      store.update(who, () => next);
    },
    clear(): void {
      if (store.readFor(who).length === 0) return;
      store.update(who, () => EMPTY);
    },
  };
}

/** `who`'s recent-search terms, most-recent-first. Subscribes → re-renders on change. */
export function useRecentSearches(who: Ss58 | null): readonly string[] {
  return store.use(who);
}
