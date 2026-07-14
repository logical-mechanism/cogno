"use client";

// Read the dynamic segment of a route (/u/<address>/, /post/<id>/) from the URL.
//
// WHY NOT useParams(): under `output: 'export'` a dynamic route is emitted as ONE placeholder document
// (generateStaticParams → "_"), and the RSC flight payload baked into that shell hard-codes the
// placeholder in the router state tree — out/u/_/index.txt literally contains `"address","_","d"`.
// useParams() is `getSelectedParams(tree)` (next/dist/client/components/app-router.js), i.e. it reads
// that tree, NOT the URL. So in the export it returns "_" for every real address/id — on a cold deep
// link (nginx rewrites /u/<addr>/ to the shell) and on a client-side navigation alike, which rendered
// the in-app not-found for every profile and every thread. `next dev` hides this: it renders dynamic
// routes on demand, so the tree there carries the real param.
//
// usePathname() returns the canonical URL, which is the real one in both cases.

import { usePathname } from "next/navigation";
import { useRef, useSyncExternalStore } from "react";

/**
 * The first path segment under `/<base>/`, or "" when `pathname` isn't under that base.
 * Pure — the hook below is the only thing that needs React. See routeSegment.test.ts.
 */
export function routeSegmentOf(pathname: string, base: string): string {
  const prefix = `/${base}/`;
  if (!pathname.startsWith(prefix)) return "";
  const segment = pathname.slice(prefix.length).split("/")[0];
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed %-escape → let the caller's validation reject it
  }
}

/**
 * The segment to render, given the one just parsed off the URL and the one we last held.
 *
 * An empty `next` does NOT mean "no such profile" — it means the URL currently points somewhere that
 * isn't this route, while this route is still mounted. ModalRouteHost does exactly that: it pushes the
 * overlay URL (/compose/?reply=<id>) with the RAW History API to keep <main> mounted behind the modal
 *. Next patches pushState, and for a state object it did not author it moves the CANONICAL
 * URL — hence usePathname — while restoring the route tree unchanged. So the moment a reply/quote/compose
 * overlay opens on /u/<addr>/, a naive re-parse yields "" and the profile behind the modal would render
 * its not-found body. Hold the last real segment instead. See routeSegment.test.ts.
 */
export function holdSegment(prev: string, next: string): string {
  return next || prev;
}

const subscribeNever = () => () => {};

/**
 * The route's dynamic segment, read from the live URL — or `null` until the client has hydrated.
 *
 * `null` is not "missing", it is "the URL is not trustworthy yet". `output: 'export'` prerenders ONE
 * shell per dynamic route, built from the "_" placeholder, and every profile is served that same HTML.
 * If the first client render read the real URL it would disagree with what the server put on disk:
 * React reports a hydration mismatch (#418) and — worse — the shell's prerendered body paints first, so
 * every cold deep link would flash "This account doesn't exist" before the profile appeared. Returning
 * `null` for that one render lets the caller prerender a loading state instead of a verdict.
 *
 * After hydration `useSyncExternalStore` returns true on the very first render, so a client-side
 * navigation to another profile never sees `null` and never flashes a skeleton.
 */
export function useRouteSegment(base: string): string | null {
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true, // client
    () => false, // server / the hydration render
  );
  const segment = routeSegmentOf(usePathname() ?? "", base);

  const held = useRef("");
  held.current = holdSegment(held.current, segment);

  return hydrated ? held.current : null;
}
