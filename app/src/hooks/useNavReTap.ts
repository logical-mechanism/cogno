"use client";

// useNavReTap — X's "tap the tab you're already on" gesture, for LeftNav / BottomTabBar / the wordmark.
//
// Clicking a nav item for the route you are ALREADY on is not a navigation; it scrolls that surface
// back to the top. On Home it ALSO refreshes the feed (requestHomeReset → HomePage re-reads page 1 and
// drops the "N new posts" buffer into view). Every other tab just scrolls — which is what X does, and
// costs nothing extra here.
//
// Usage: `onClick={reTap(href)}` alongside the existing <Link href={href}>. The handler bows out of
// anything that isn't a plain left-click, so cmd/ctrl/shift/alt-click still open the route in a new
// tab or window, and it never swallows a click something upstream already handled.

import { useCallback } from "react";
import { usePathname } from "next/navigation";
import { scrollToTop } from "@/lib/scroll";
import { requestHomeReset } from "@/lib/homeSignal";
import type { MouseEvent } from "react";

/**
 * Trailing-slash-insensitive path equality: "/explore/" ≡ "/explore".
 *
 * The nav hrefs carry a trailing slash (the static export emits directory-style routes) while
 * usePathname() may hand back either form, so a raw === would miss the re-tap and let the Link
 * navigate to the page you are already on.
 *
 * This deliberately compares the WHOLE path rather than reusing the nav items' `match` predicates:
 * those are prefix matches (Profile is `startsWith('/u/<me>')`), so a `match`-based re-tap would fire
 * on /u/<me>/followers/ and scroll in place instead of navigating back to the profile root.
 */
export function isSamePath(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  return norm(a) === norm(b);
}

/** Returns a click-handler factory for a nav href. See the module comment. */
export function useNavReTap(): (href: string) => (e: MouseEvent<HTMLAnchorElement>) => void {
  const pathname = usePathname() ?? "/";

  return useCallback(
    (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.defaultPrevented) return; // already handled upstream
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // open-in-new-tab/window intent
      if (!isSamePath(pathname, href)) return; // a real navigation — let <Link> do its job

      // Every nav href is query-free, so a query string on the CURRENT url means the tab click still
      // changes the url — and clearing it is the point. Explore keeps its search in the query
      // (/explore/?q=…), so swallowing this click would strand the viewer in their old search results
      // with no way back to Explore proper. usePathname() drops the query, hence reading it here.
      if (typeof window !== "undefined" && window.location.search !== "") return;

      e.preventDefault();
      scrollToTop();
      // Home is the only surface with a live feed to re-read; HomePage owns what "refresh" means there
      // (which tab, which hook), so the nav just says that it happened.
      if (isSamePath(href, "/")) requestHomeReset();
    },
    [pathname],
  );
}
