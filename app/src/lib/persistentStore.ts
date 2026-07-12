"use client";

// persistentStore — the shared reactive localStorage-backed store behind the device-local stores
// (recent searches, pending locks). It collapses the load / commit / subscribe / useSyncExternalStore
// scaffold that was hand-rolled per store, and centralizes OPT-IN cross-tab `storage` sync so a write
// in one tab is reflected in the others. (Previously only recentSearchStore wired the `storage` event;
// pendingLockStore silently didn't, so a lock recorded in one tab left another tab showing the stale
// "Lock ADA to post" nag.) Client-only; NO chain state — nothing here is written to Cardano.
//
// bookmarkStore/muteStore predate this and still hand-roll the same shape; they can adopt this factory
// later (kept out of this pass to avoid churning working, cross-tab-agnostic stores).

export interface PersistentStore<T> {
  /** The current in-memory snapshot (stable ref between changes — safe as a useSyncExternalStore value). */
  read: () => T;
  /** Replace the value, persist it, and notify subscribers. */
  commit: (next: T) => void;
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => T;
  getServerSnapshot: () => T;
}

export interface PersistentStoreOpts<T> {
  /** localStorage key. */
  key: string;
  /** The value when storage is empty/unavailable — also the SSR snapshot. MUST be a stable reference. */
  empty: T;
  /** Parse+validate a raw localStorage string (or null when absent) into a T. May throw; caught → empty. */
  parse: (raw: string | null) => T;
  /** Serialize a T for localStorage (also used as the cross-tab change-detector). */
  serialize: (value: T) => string;
  /** true → mirror other tabs' writes to this key via the `storage` event (default false). */
  crossTab?: boolean;
}

export function createPersistentStore<T>(opts: PersistentStoreOpts<T>): PersistentStore<T> {
  const { key, empty, parse, serialize, crossTab = false } = opts;

  function loadFromStorage(): T {
    if (typeof window === "undefined") return empty;
    try {
      return parse(window.localStorage.getItem(key));
    } catch {
      return empty;
    }
  }

  let cache: T = loadFromStorage();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  function commit(next: T): void {
    cache = next;
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(key, serialize(next));
    } catch {
      /* quota exceeded / storage disabled → keep the in-memory value only */
    }
    notify();
  }

  // Another tab wrote our key → reload and notify so this tab stays in sync and its NEXT commit builds on
  // the fresh value instead of clobbering the other tab's write. The `storage` event fires only in OTHER
  // tabs, so this never loops with our own commit(). key===null is a full localStorage.clear().
  function onStorage(e: StorageEvent): void {
    if (e.key !== null && e.key !== key) return;
    const next = loadFromStorage();
    if (serialize(next) === serialize(cache)) return; // no real change → don't churn a re-render
    cache = next;
    notify();
  }

  function subscribe(cb: () => void): () => void {
    if (crossTab && listeners.size === 0 && typeof window !== "undefined") {
      window.addEventListener("storage", onStorage);
      // Re-read on (re)attach. The `storage` listener is only mounted while someone is subscribed, so
      // any foreign-tab write that landed while `listeners` was empty fired into a void — without this
      // the cache stays stale forever, and the NEXT commit builds on it and clobbers the other tab's
      // write. Safe with useSyncExternalStore: React calls getSnapshot() AFTER subscribe() returns.
      const fresh = loadFromStorage();
      if (serialize(fresh) !== serialize(cache)) cache = fresh;
    }
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
      if (crossTab && listeners.size === 0 && typeof window !== "undefined") {
        window.removeEventListener("storage", onStorage);
      }
    };
  }

  return {
    read: () => cache,
    commit,
    subscribe,
    getSnapshot: () => cache,
    getServerSnapshot: () => empty,
  };
}
