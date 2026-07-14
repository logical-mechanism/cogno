"use client";

// hiddenStore — device-local "hidden posts" (client-only; NO chain state, no writing to Cardano).
// A viewer hides ONE specific post: it is removed from every feed, thread, profile and bookmark list
// on THIS device. The finest-grained recourse — "not this one" — below mute (a person, softly) and
// block (a person, hard). Opening the post's own permalink still shows it (you navigated there on
// purpose); the ··· menu there offers "Unhide", and Settings → Hidden posts lists them all.
//
// A typed bigint facade over the shared viewer-scoped set store — the same pattern as bookmarkStore,
// with which it is a mirror image (a negative bookmark). Post ids persist as their decimal-string form;
// the /^\d+$/ guard is load-bearing (useHiddenList calls BigInt(s), which throws on anything else).

import { createViewerScopedStringSetStore } from "./stringSetStore";
import type { Ss58 } from "./types";

const store = createViewerScopedStringSetStore({
  prefix: "cg-hidden",
  isValid: (v) => /^\d+$/.test(v),
});

/** Hide actions bound to `who` (null = the signed-out device bucket). */
export function hiddenActionsFor(who: Ss58 | null) {
  const a = store.actionsFor(who);
  return {
    hide: (id: bigint) => a.add(String(id)),
    unhide: (id: bigint) => a.remove(String(id)),
    toggle: (id: bigint) => a.toggle(String(id)),
  };
}

/** Is post `id` hidden by `who`? Subscribes, so the caller re-renders when the set changes. */
export function useHidden(id: bigint | null | undefined, who: Ss58 | null): boolean {
  const snap = store.useSet(who);
  return id != null && snap.has(String(id));
}

/** `who`'s hidden post ids (for the Settings → Hidden posts manager). */
export function useHiddenList(who: Ss58 | null): bigint[] {
  return [...store.useSet(who)].map((s) => BigInt(s));
}

/** The raw subscribing set (for useModeration's `filterPosts`). */
export function useHiddenSet(who: Ss58 | null): ReadonlySet<string> {
  return store.useSet(who);
}
