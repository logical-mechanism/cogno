"use client";

// muteStore — device-local "muted accounts" (client-only; NO chain state, no writing to Cardano).
// A viewer collapses a muted author's posts everywhere (the only recourse on a delete-free,
// no-moderation chain — muting is the viewer's own choice, it never hides content for anyone else).
// Persisted as a JSON array of ss58 under localStorage['cg-muted']; exposed via useSyncExternalStore
// so any component (PostCard, a Settings list) reflects a mute/unmute instantly.

import { useSyncExternalStore } from "react";
import type { Ss58 } from "./types";

const KEY = "cg-muted";
const EMPTY: ReadonlySet<string> = new Set();

let cache: Set<string> = load();
const listeners = new Set<() => void>();

function load(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
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

export const muteActions = {
  mute(addr: Ss58): void {
    if (!addr || cache.has(addr)) return;
    commit(new Set(cache).add(addr));
  },
  unmute(addr: Ss58): void {
    if (!cache.has(addr)) return;
    const next = new Set(cache);
    next.delete(addr);
    commit(next);
  },
  toggle(addr: Ss58): void {
    if (cache.has(addr)) muteActions.unmute(addr);
    else muteActions.mute(addr);
  },
};

/** Is `addr` muted? Subscribes, so the caller re-renders when the mute set changes. */
export function useMuted(addr: Ss58 | null | undefined): boolean {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return addr != null && snap.has(addr);
}

/** The full muted-account list (for the Settings manager). */
export function useMutedList(): Ss58[] {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [...snap];
}
