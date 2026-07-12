"use client";

// muteStore — device-local "muted accounts" (client-only; NO chain state, no writing to Cardano).
// A viewer collapses a muted author's posts everywhere (the only recourse on a delete-free,
// no-moderation chain — muting is the viewer's own choice, it never hides content for anyone else).
// Device-local by design, but DOES mirror across this device's tabs.
//
// A typed Ss58 facade over the shared string-set store. The validity guard rejects the empty string on
// BOTH read and write: without it `mute("")` persists, and `useMuted("")` then renders an empty address
// as muted.

import { createStringSetStore } from "./stringSetStore";
import type { Ss58 } from "./types";

const store = createStringSetStore("cg-muted", (v) => v.length > 0);

export const muteActions = {
  mute: (addr: Ss58) => store.add(addr),
  unmute: (addr: Ss58) => store.remove(addr),
  toggle: (addr: Ss58) => store.toggle(addr),
};

/** Is `addr` muted? Subscribes, so the caller re-renders when the mute set changes. */
export function useMuted(addr: Ss58 | null | undefined): boolean {
  const snap = store.useSet();
  return addr != null && snap.has(addr);
}

/** The full muted-account list (for the Settings manager). */
export function useMutedList(): Ss58[] {
  const snap = store.useSet();
  return [...snap];
}
