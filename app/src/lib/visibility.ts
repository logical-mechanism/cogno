"use client";

// Tab visibility, as a hook.
//
// Nothing in this app paused when its tab went to the background. A tab left open in another window
// kept re-running everything the block tick drives — the thread re-read on /post, the full profile
// re-read on /u, the feed's vote-reconcile page-1 refetch — every ~6 seconds, forever, for pixels
// nobody was looking at. `useNotifications` was the single exception (it skips its 120s fold while
// hidden); this generalizes that instinct to the one value all the others hang off.
//
// Used by Providers to freeze the shared best-block number while hidden. Freezing the NUMBER (rather
// than adding a visibility check to each effect) is the whole trick: every per-block refetch keys on
// it, so they all stop together and all catch up together on the single re-emission when the tab comes
// back. Nothing goes stale silently — coming back is exactly one tick.

import { useEffect, useRef, useState } from "react";

/** true when the document is visible (and on the server / before mount, where there is nothing to hide). */
export function useDocumentVisible(): boolean {
  // Start `true` so SSG and the hydration render agree, and so a normally-opened tab never spends a
  // frame believing it is hidden.
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== "hidden");
    sync(); // a tab restored straight into the background starts hidden
    document.addEventListener("visibilitychange", sync);
    // `pageshow` covers the bfcache/sleep restore: the document is visible again but no
    // visibilitychange necessarily fired, and the socket underneath may have died while we slept.
    window.addEventListener("pageshow", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("pageshow", sync);
    };
  }, []);

  return visible;
}

/**
 * `value`, frozen at its last-seen value while the tab is hidden.
 *
 * On becoming visible it snaps to the current value in one step — so a per-block effect keyed on the
 * result runs once to catch up, not once per block that elapsed while the tab was away.
 */
export function useFrozenWhileHidden<T>(value: T, visible: boolean): T {
  // A ref, NOT state. Holding the last-seen value in state meant every new block cost TWO renders of
  // the component that owns this hook — one for the incoming value, then one more for the `setHeld`
  // that mirrored it — which is the opposite of the point. A ref written during render tracks the
  // value for free, and the only render this hook needs to cause is the one `visible` already causes
  // when the tab comes back.
  const held = useRef(value);
  if (visible) held.current = value;
  return held.current;
}
