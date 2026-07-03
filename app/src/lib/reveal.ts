"use client";

// reveal — session-scoped "this image has been revealed" memory (image-reveal feature).
//
// The browser never auto-fetches an image from a linked / IPFS host until the user taps its cover.
// Once revealed, the SAME image stays revealed everywhere it appears this session — keyed by its
// resolved src — so a feed avatar tapped once shows in every post by that author. Reset on a full
// page reload (the natural lifetime of a module singleton, which matches "for this session").
//
// Same shape as modalStore.ts: a module-level external store driven by useSyncExternalStore. The app
// is a Next.js static export, so getServerSnapshot returns a STABLE empty set (a fresh Set per call
// would throw the "getServerSnapshot should be cached" hydration error). Snapshot immutability: each
// reveal() swaps in a NEW Set so useSyncExternalStore sees a referentially-new value.

import { useSyncExternalStore } from "react";

const EMPTY: ReadonlySet<string> = new Set<string>();

let revealed: ReadonlySet<string> = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True if `key` has been revealed this session. Pure (no React) — usable outside components. */
export function isRevealed(key: string): boolean {
  return revealed.has(key);
}

/** Mark `key` revealed (no-op if already), mirroring modalStore's identity-stable guard. */
export function reveal(key: string): void {
  if (revealed.has(key)) return;
  const next = new Set(revealed);
  next.add(key);
  revealed = next;
  emit();
}

/** Re-cover `key` (put the reveal gate back) — the inverse of {@link reveal}. No-op if not revealed. */
export function unreveal(key: string): void {
  if (!revealed.has(key)) return;
  const next = new Set(revealed);
  next.delete(key);
  revealed = next;
  emit();
}

/** Subscribe a component to a single key's reveal state. Returns a stable boolean snapshot. */
export function useRevealed(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => revealed.has(key),
    () => EMPTY.has(key),
  );
}
