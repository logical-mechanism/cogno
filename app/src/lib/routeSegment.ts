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

/**
 * The first path segment under `/<base>/` — e.g. useRouteSegment("u") on /u/5Grw…/?tab=likes → "5Grw…".
 * Returns "" when the current path isn't under that base.
 */
export function useRouteSegment(base: string): string {
  const pathname = usePathname() ?? "";
  const prefix = `/${base}/`;
  if (!pathname.startsWith(prefix)) return "";
  const segment = pathname.slice(prefix.length).split("/")[0] ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed %-escape → let the caller's validation reject it
  }
}
