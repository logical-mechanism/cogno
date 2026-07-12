"use client";

// stringSetStore — the shared "device-local set of strings" store behind bookmarkStore and muteStore.
// Both are the same store with a different element type and a different notion of a valid member; they
// each hand-rolled the load / commit / subscribe / useSyncExternalStore scaffold that persistentStore
// already factors out (persistentStore's own doc comment said as much, and said they should adopt it).
//
// Two bugs this closes, neither of them cosmetic:
//
// 1. CROSS-TAB CLOBBER. Both hand-rolled copies loaded their cache ONCE at module eval and never
//    listened for `storage`, so every commit rebuilt the set from a boot-time snapshot. Two tabs open —
//    tab A bookmarks #5, tab B bookmarks #9 — and tab B commits ["9"] over its stale empty cache,
//    PERMANENTLY destroying #5 while tab A still renders it as saved. `crossTab` fixes it.
//
// 2. CROSS-ACCOUNT LEAK. Both keyed a single device-global key, so connecting a different wallet on the
//    same device inherited the previous account's saved posts and mute list. useSigner.disconnect
//    already clears the post draft for exactly this reason ("so it can't resurface in the NEXT
//    account's composer on a shared device") and notificationReadState is already namespaced per viewer;
//    these two never got either treatment. Now each account gets its own bucket.
//
// `isValid` is deliberately per-store and applied on BOTH the read and the write path. bookmarkStore's
// /^\d+$/ is not cosmetic — useBookmarkList does BigInt(s), which THROWS on junk and would hard-crash
// /bookmarks — so a laxer shared predicate would be a crash vector, and validating only on parse would
// let a bad value in through `add` and blow up on the next read.

import { useSyncExternalStore } from "react";
import { createPersistentStore, type PersistentStore } from "./persistentStore";

const EMPTY: ReadonlySet<string> = new Set();

/** Signed-out browsing gets its own bucket — never an account's, and never the legacy one. */
const ANON = "anon";

export interface ViewerScopedSetActions {
  add: (value: string) => void;
  remove: (value: string) => void;
  toggle: (value: string) => void;
}

export interface ViewerScopedStringSetStore {
  /** Imperative actions bound to one account (null = the signed-out device bucket). */
  actionsFor: (who: string | null) => ViewerScopedSetActions;
  /** Subscribing snapshot for one account. Re-subscribes when `who` changes (the store identity does). */
  useSet: (who: string | null) => ReadonlySet<string>;
  /** Non-React read, for tests. */
  readFor: (who: string | null) => ReadonlySet<string>;
  /** Non-React subscribe, for tests. */
  subscribeFor: (who: string | null, cb: () => void) => () => void;
}

export interface ViewerScopedStringSetOpts {
  /**
   * Base localStorage key. Per-account buckets are `${prefix}:${ss58}`; signed-out is `${prefix}:anon`.
   * The BARE `prefix` is the pre-namespacing key and is treated as a one-shot migration source.
   */
  prefix: string;
  isValid: (value: string) => boolean;
}

export function createViewerScopedStringSetStore(
  opts: ViewerScopedStringSetOpts,
): ViewerScopedStringSetStore {
  const { prefix, isValid } = opts;
  const stores = new Map<string, PersistentStore<ReadonlySet<string>>>();

  const parse = (raw: string | null): ReadonlySet<string> => {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && isValid(x)) : [],
    );
  };

  // Sorted, so the cross-tab change-detector (which compares serialized forms) doesn't read insertion
  // order as a change and churn a re-render.
  const serialize = (set: ReadonlySet<string>) => JSON.stringify([...set].sort());

  /**
   * One-shot migration of the pre-namespacing device-global set. The FIRST real account to mount claims
   * it, and the legacy key is then removed so a second account on the same device does NOT inherit it —
   * which is the leak this whole change exists to close. Signed-out browsing never claims it (otherwise
   * a user's saved posts would land in `:anon` and look lost the moment they connected their wallet).
   */
  function claimLegacyFor(who: string | null): string | null {
    if (who === null || typeof window === "undefined") return null;
    try {
      if (window.localStorage.getItem(`${prefix}:${who}`) !== null) return null; // already has a bucket
      const legacy = window.localStorage.getItem(prefix);
      if (legacy === null) return null;
      window.localStorage.setItem(`${prefix}:${who}`, legacy);
      window.localStorage.removeItem(prefix);
      return legacy;
    } catch {
      return null; // storage blocked — nothing to migrate
    }
  }

  function storeFor(who: string | null): PersistentStore<ReadonlySet<string>> {
    const bucket = who ?? ANON;
    let s = stores.get(bucket);
    if (!s) {
      claimLegacyFor(who); // must run BEFORE the store reads its key
      s = createPersistentStore<ReadonlySet<string>>({
        key: `${prefix}:${bucket}`,
        empty: EMPTY,
        parse,
        serialize,
        crossTab: true,
      });
      stores.set(bucket, s);
    }
    return s;
  }

  function actionsFor(who: string | null): ViewerScopedSetActions {
    const s = storeFor(who);
    const commitFrom = (mutate: (draft: Set<string>) => void) => {
      const next = new Set(s.read());
      mutate(next);
      s.commit(next);
    };
    const add = (value: string) => {
      if (!isValid(value) || s.read().has(value)) return;
      commitFrom((d) => d.add(value));
    };
    const remove = (value: string) => {
      if (!s.read().has(value)) return;
      commitFrom((d) => d.delete(value));
    };
    return { add, remove, toggle: (v) => (s.read().has(v) ? remove(v) : add(v)) };
  }

  return {
    actionsFor,
    useSet: (who) => {
      const s = storeFor(who);
      return useSyncExternalStore(s.subscribe, s.getSnapshot, s.getServerSnapshot);
    },
    readFor: (who) => storeFor(who).read(),
    subscribeFor: (who, cb) => storeFor(who).subscribe(cb),
  };
}
