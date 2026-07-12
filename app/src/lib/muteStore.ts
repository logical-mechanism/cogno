"use client";

// muteStore — device-local "muted accounts" (client-only; NO chain state, no writing to Cardano).
// A viewer collapses a muted author's posts everywhere (the only recourse on a delete-free,
// no-moderation chain — muting is the viewer's own choice, it never hides content for anyone else).
// Mirrors across this device's tabs, and is scoped PER ACCOUNT: a mute list is a personal judgement,
// so a shared device must not apply one wallet's to the next.
//
// A typed Ss58 facade over the shared viewer-scoped set store. The validity guard rejects the empty
// string on BOTH read and write: without it `mute("")` persists, and `useMuted("")` then renders an
// empty address as muted.

import { createViewerScopedStringSetStore } from "./stringSetStore";
import type { Ss58 } from "./types";

const store = createViewerScopedStringSetStore({
  prefix: "cg-muted",
  isValid: (v) => v.length > 0,
});

/** Mute actions bound to `who` (null = the signed-out device bucket). */
export function muteActionsFor(who: Ss58 | null) {
  const a = store.actionsFor(who);
  return {
    mute: (addr: Ss58) => a.add(addr),
    unmute: (addr: Ss58) => a.remove(addr),
    toggle: (addr: Ss58) => a.toggle(addr),
  };
}

/** Is `addr` muted by `who`? Subscribes, so the caller re-renders when the mute set changes. */
export function useMuted(addr: Ss58 | null | undefined, who: Ss58 | null): boolean {
  const snap = store.useSet(who);
  return addr != null && snap.has(addr);
}

/** `who`'s muted-account list (for the Settings manager + the notifications fold). */
export function useMutedList(who: Ss58 | null): Ss58[] {
  const snap = store.useSet(who);
  return [...snap];
}
