// homeSignal — "the viewer tapped Home while already on Home" (the X gesture: the Home tab scrolls the
// feed back to the top and refreshes it).
//
// The nav sits OUTSIDE the routed page — LeftNav / BottomTabBar are siblings of <main> inside AppShell
// — so there is no prop path from the Home button down to HomePage's feed hooks. This is the same
// module-singleton seam modalStore uses for the "Post" pill, minus the snapshot: a reset is an EVENT,
// not state, so useSyncExternalStore is the wrong primitive (there is nothing to render off it).
//
// Emitting with nobody listening is a deliberate no-op: the only way to have no listener is for
// HomePage to be unmounted, i.e. the viewer is on another route — and then the Home link performs a
// real navigation, whose fresh HomePage mount seeds page 1 from scratch. That IS the refresh.

/** A minimal subscribe/emit bus. Exported as a factory so a test can drive one without the singleton. */
export function createSignal() {
  const listeners = new Set<() => void>();
  return {
    /** Register a listener. Returns its unsubscribe. */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Fire every listener. Iterates a COPY, so a listener that unsubscribes mid-emit can't make the
     *  Set skip the next one. */
    emit(): void {
      for (const listener of [...listeners]) listener();
    },
    /** Live listener count (test introspection — nothing in the app reads this). */
    size(): number {
      return listeners.size;
    },
  };
}

const homeReset = createSignal();

/** Ask Home to refresh its feed. Called by the nav when Home is re-tapped on "/". */
export function requestHomeReset(): void {
  homeReset.emit();
}

/** Listen for a Home reset (HomePage). Returns the unsubscribe — hand it straight back from useEffect. */
export function subscribeHomeReset(listener: () => void): () => void {
  return homeReset.subscribe(listener);
}
