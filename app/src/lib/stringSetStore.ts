"use client";

// stringSetStore — the shared "device-local set of strings" store behind bookmarkStore and muteStore.
// Both are the same store with a different element type and a different notion of a valid member; they
// each hand-rolled the load / commit / subscribe / useSyncExternalStore scaffold that persistentStore
// already factors out (persistentStore's own doc comment said as much, and said they should adopt it).
//
// The reason this is not just tidy-up: both hand-rolled copies loaded their cache ONCE at module eval
// and never listened for `storage`, so every commit rebuilt the set from a boot-time snapshot. Two tabs
// open — tab A bookmarks #5, tab B bookmarks #9 — and tab B commits `["9"]` on top of its stale empty
// cache, PERMANENTLY destroying #5 while tab A still renders it as saved. Routing them through
// createPersistentStore with `crossTab: true` closes that: each tab mirrors the other's writes, so a
// commit always builds on the current value.
//
// `isValid` is deliberately per-store and applied on BOTH the read and the write path. bookmarkStore's
// /^\d+$/ is not cosmetic — useBookmarkList does BigInt(s), which THROWS on junk and would hard-crash
// /bookmarks — so a laxer shared predicate would be a crash vector, and validating only on parse would
// let a bad value in through `add` and blow up on the next read.

import { useSyncExternalStore } from "react";
import { createPersistentStore } from "./persistentStore";

const EMPTY: ReadonlySet<string> = new Set();

export interface StringSetStore {
  add: (value: string) => void;
  remove: (value: string) => void;
  toggle: (value: string) => void;
  /** The current set. */
  read: () => ReadonlySet<string>;
  /** Notified on every change, including one mirrored in from another tab. */
  subscribe: (cb: () => void) => () => void;
  /** React binding over {@link read}/{@link subscribe}. */
  useSet: () => ReadonlySet<string>;
}

export function createStringSetStore(key: string, isValid: (v: string) => boolean): StringSetStore {
  const store = createPersistentStore<ReadonlySet<string>>({
    key,
    empty: EMPTY,
    parse: (raw) => {
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return new Set(
        Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && isValid(x)) : [],
      );
    },
    // Sorted so the cross-tab change-detector (which compares serialized forms) doesn't see insertion
    // order as a change and churn a re-render.
    serialize: (set) => JSON.stringify([...set].sort()),
    crossTab: true,
  });

  function add(value: string): void {
    if (!isValid(value) || store.read().has(value)) return;
    commitFrom((next) => next.add(value));
  }

  function remove(value: string): void {
    if (!store.read().has(value)) return;
    commitFrom((next) => next.delete(value));
  }

  function commitFrom(mutate: (draft: Set<string>) => void): void {
    const next = new Set(store.read());
    mutate(next);
    store.commit(next);
  }

  return {
    add,
    remove,
    toggle: (value) => (store.read().has(value) ? remove(value) : add(value)),
    read: store.read,
    subscribe: store.subscribe,
    useSet: () => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot),
  };
}
