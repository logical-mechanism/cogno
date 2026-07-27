"use client";

// viewerScopedStore — the generic "device-local state, bucketed PER ACCOUNT" store.
//
// This is stringSetStore's scoping machinery, lifted so a store whose value ISN'T a set of strings
// (lib/localListStore holds objects) gets the same two guarantees without re-deriving them. Both were
// real bugs, not hygiene, so a second hand-rolled copy is exactly what to avoid:
//
// 1. CROSS-TAB CLOBBER — a cache loaded once at module eval and never refreshed means every commit
//    rebuilds from a boot-time snapshot, so a write in tab B destroys tab A's write. `crossTab` in
//    persistentStore fixes it; this layer always opts in.
// 2. CROSS-ACCOUNT LEAK — a single device-global key means connecting a second wallet on a shared
//    device inherits the first account's data. Each account gets its own bucket; signed-out browsing
//    gets `:anon`, never an account's.
//
// WHY `:anon` IS NEVER ADOPTED INTO `:<ss58>` AT SIGN-IN. Deliberate, and worth writing down because it
// looks like an omission. The reverse of `claimLegacy` — folding the signed-out bucket into the first
// account to sign in — is the SAME cross-account leak this file exists to close, just pointed the other
// way: on a shared browser, one visitor's mutes, blocks, bookmarks and lists would become whoever signs
// in next. The window it would have closed is smaller than it looks, too: `viewerBucket` returns the
// address from the moment the posting key is derived, so the whole connect-then-bind stretch of
// onboarding already writes to the account's own bucket. What remains is a true guest who bookmarks
// something and then signs in, and for them /bookmarks and /lists are public surfaces they can still
// reach signed out. A silent merge is not worth a stranger's mute list.
//
// Client-only. NO chain state — nothing here is written to Cardano or to the chain.

import { useSyncExternalStore } from "react";
import { createPersistentStore, type PersistentStore } from "./persistentStore";

/** Signed-out browsing gets its own bucket — never an account's, and never the legacy one. */
const ANON = "anon";

export interface ViewerScopedStoreOpts<T> {
  /**
   * Base localStorage key. Per-account buckets are `${prefix}:${ss58}`; signed-out is `${prefix}:anon`.
   */
  prefix: string;
  /** The value when storage is empty/unavailable — also the SSR snapshot. MUST be a stable reference. */
  empty: T;
  /** Parse+validate a raw localStorage string (or null when absent). May throw; caught → `empty`. */
  parse: (raw: string | null) => T;
  /** Serialize for localStorage. Also the cross-tab change-detector, so it must be STABLE (sort it). */
  serialize: (value: T) => string;
  /**
   * One-shot claim of the pre-namespacing BARE `prefix` key by the first real account to mount.
   * Only for stores that shipped device-global before being bucketed (bookmarks, mutes). A store that
   * was per-account from birth must leave this off — there is nothing to claim, and reading a bare key
   * that some unrelated future store owns would be a cross-feature leak.
   */
  claimLegacy?: boolean;
}

export interface ViewerScopedStore<T> {
  /** Non-React read for one account (null = the signed-out device bucket). */
  readFor: (who: string | null) => T;
  /**
   * Read-modify-write against the FRESH value, so a cross-tab refresh isn't clobbered.
   *
   * Returns FALSE when the write did not reach storage (see `persistentStore.commit`), so a caller can
   * report a failure instead of confirming a save that will not survive a reload.
   */
  update: (who: string | null, mutate: (current: T) => T) => boolean;
  /** Subscribing snapshot for one account. Re-subscribes when `who` changes (the store identity does). */
  use: (who: string | null) => T;
  /** Non-React subscribe, for tests. */
  subscribeFor: (who: string | null, cb: () => void) => () => void;
}

export function createViewerScopedStore<T>(opts: ViewerScopedStoreOpts<T>): ViewerScopedStore<T> {
  const { prefix, empty, parse, serialize, claimLegacy = false } = opts;
  const stores = new Map<string, PersistentStore<T>>();

  /**
   * One-shot migration of the pre-namespacing device-global value. The FIRST real account to mount
   * claims it, and the legacy key is then removed so a second account on the same device does NOT
   * inherit it — the leak this bucketing exists to close. Signed-out browsing never claims it (a
   * user's saved data would land in `:anon` and look lost the moment they connected their wallet).
   */
  function claimLegacyFor(who: string | null): void {
    if (!claimLegacy || who === null || typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(`${prefix}:${who}`) !== null) return; // already has a bucket
      const legacy = window.localStorage.getItem(prefix);
      if (legacy === null) return;
      window.localStorage.setItem(`${prefix}:${who}`, legacy);
      window.localStorage.removeItem(prefix);
    } catch {
      /* storage blocked — nothing to migrate */
    }
  }

  function storeFor(who: string | null): PersistentStore<T> {
    const bucket = who ?? ANON;
    let s = stores.get(bucket);
    if (!s) {
      claimLegacyFor(who); // must run BEFORE the store reads its key
      s = createPersistentStore<T>({
        key: `${prefix}:${bucket}`,
        empty,
        parse,
        serialize,
        crossTab: true,
      });
      stores.set(bucket, s);
    }
    return s;
  }

  return {
    readFor: (who) => storeFor(who).read(),
    update: (who, mutate) => {
      const s = storeFor(who);
      return s.commit(mutate(s.read()));
    },
    use: (who) => {
      const s = storeFor(who);
      return useSyncExternalStore(s.subscribe, s.getSnapshot, s.getServerSnapshot);
    },
    subscribeFor: (who, cb) => storeFor(who).subscribe(cb),
  };
}
