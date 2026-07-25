"use client";

// stringSetStore — the "device-local SET OF STRINGS" store behind bookmarkStore and muteStore. Both are
// the same store with a different element type and a different notion of a valid member.
//
// The per-account bucketing, the cross-tab sync and the one-shot legacy claim all live in
// lib/viewerScopedStore now (they are needed by localListStore too, whose value is not a string set).
// Read that file's header for WHY those exist — both were real data-loss bugs. This module is the thin
// set-shaped facade over it: element validity plus add/remove/toggle.
//
// `isValid` is deliberately per-store and applied on BOTH the read and the write path. bookmarkStore's
// /^\d+$/ is not cosmetic — useBookmarkList does BigInt(s), which THROWS on junk and would hard-crash
// /bookmarks — so a laxer shared predicate would be a crash vector, and validating only on parse would
// let a bad value in through `add` and blow up on the next read.

import { createViewerScopedStore } from "./viewerScopedStore";

const EMPTY: ReadonlySet<string> = new Set();

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

  const store = createViewerScopedStore<ReadonlySet<string>>({
    prefix,
    empty: EMPTY,
    parse: (raw) => {
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return new Set(
        Array.isArray(parsed)
          ? parsed.filter((x): x is string => typeof x === "string" && isValid(x))
          : [],
      );
    },
    // Sorted, so the cross-tab change-detector (which compares serialized forms) doesn't read insertion
    // order as a change and churn a re-render.
    serialize: (set) => JSON.stringify([...set].sort()),
    // bookmarks + mutes shipped device-global before being bucketed, so their bare key is claimable.
    claimLegacy: true,
  });

  function actionsFor(who: string | null): ViewerScopedSetActions {
    const commitFrom = (mutate: (draft: Set<string>) => void) =>
      store.update(who, (current) => {
        const next = new Set(current);
        mutate(next);
        return next;
      });
    const add = (value: string) => {
      if (!isValid(value) || store.readFor(who).has(value)) return;
      commitFrom((d) => d.add(value));
    };
    const remove = (value: string) => {
      if (!store.readFor(who).has(value)) return;
      commitFrom((d) => d.delete(value));
    };
    return { add, remove, toggle: (v) => (store.readFor(who).has(v) ? remove(v) : add(v)) };
  }

  return {
    actionsFor,
    useSet: (who) => store.use(who),
    readFor: (who) => store.readFor(who),
    subscribeFor: (who, cb) => store.subscribeFor(who, cb),
  };
}
