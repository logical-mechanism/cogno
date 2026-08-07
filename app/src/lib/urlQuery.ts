"use client";

// urlQuery — read and write the URL query string without going through the Next app router.
//
// WHY THIS EXISTS. Under `output: 'export'`, a query-ONLY `router.replace` is silently dropped on any
// page that was cold-loaded with a query string. Reproduced in Chromium against the built export:
// open `/governance/?t=closed`, pick a different status, and Next calls
// `history.replaceState(…, "/governance/?t=closed")` — the URL it already had, not the one it was
// handed. No network request is made, so nothing 404s and nothing logs. `useSearchParams()` therefore
// never changes either, so the list does not re-filter and the controls read as dead. It is permanent,
// not a hydration race: a second and third click do the same thing.
//
// The same page loaded WITHOUT a query works, which is what makes this so easy to miss. The everyday
// way in is not a shared link, it is a reload: filter anything, hit refresh, and every control on the
// surface goes inert until you navigate away and back.
//
// Scope: /governance and /explore are the only surfaces that write query-only URLs (/u/[address] and
// /compose read `useSearchParams` but never write it, and every other `router.push` here changes the
// PATHNAME, which is unaffected). Both already funnel every write through one builder, so swapping the
// transport is a small change at a seam that already existed.
//
// Reading off `window.location` rather than the router is not a new idea in this app — AppShell,
// /welcome and WalledRouteNotice all do it, each to dodge a different `output: export` sharp edge.
// This just makes the read subscribable so a write can drive a re-render.

import { useMemo, useSyncExternalStore } from "react";

/** Dispatched after our own writes. `popstate` covers Back/Forward; nothing fires for replaceState. */
const URL_QUERY_EVENT = "cg:urlquery";

// useSyncExternalStore requires getSnapshot to return a value that is `Object.is`-stable while nothing
// has changed, so the snapshot is the search STRING and callers derive the parsed object from it. A
// fresh URLSearchParams per call would be a new identity every render and loop forever.
let snapshot = "";

function subscribe(onStoreChange: () => void): () => void {
  const handler = () => {
    snapshot = window.location.search;
    onStoreChange();
  };
  window.addEventListener("popstate", handler);
  window.addEventListener(URL_QUERY_EVENT, handler);
  return () => {
    window.removeEventListener("popstate", handler);
    window.removeEventListener(URL_QUERY_EVENT, handler);
  };
}

function getSnapshot(): string {
  // Re-read rather than trusting the cache: a router navigation that changes the pathname lands here
  // without firing either of our events, and the query it arrived with has to be picked up.
  const current = window.location.search;
  if (current !== snapshot) snapshot = current;
  return snapshot;
}

/** The prerender has no location. Empty matches what `useSearchParams()` returns there, so the SSG'd
 *  HTML is the unfiltered view exactly as before and the client corrects it on hydration. */
function getServerSnapshot(): string {
  return "";
}

/** The current query, re-rendering the caller whenever it changes. Drop-in for `useSearchParams()`. */
export function useUrlSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return useMemo(() => new URLSearchParams(search), [search]);
}

/**
 * Point the address bar at `href` and re-render every {@link useUrlSearchParams} caller.
 *
 * REPLACE, never push — flipping a filter or a sort is not a navigation step, and stacking history on
 * every chip tap would make Back walk sort states instead of leaving the surface. The debounced search
 * term relies on this too: one history entry per keystroke would be unusable.
 *
 * Next's own router state object is carried over rather than nulled. Passing `null` would wipe the
 * entry's state, and Next reads it back when handling `popstate`, so Back out of a later page would
 * land on a route the router could no longer describe.
 */
export function replaceUrlQuery(href: string): void {
  window.history.replaceState(window.history.state, "", href);
  window.dispatchEvent(new Event(URL_QUERY_EVENT));
}
