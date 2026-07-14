// PostDetailPage — /post/[id].
//
// STATIC EXPORT: this page.tsx is a SERVER component (NO "use client") because Next forbids a
// page from being both a Client Component and exporting generateStaticParams(). generateStaticParams
// returns a single throwaway placeholder so the build emits the route bundle; the REAL id is read
// CLIENT-SIDE in the <PostDetailView> child — from the URL, via useRouteSegment() (never from props:
// the HTML on disk is the placeholder doc; and never via useParams(), which reads the router state
// tree that bakes "_" for every post — see lib/routeSegment). Real deep links are served via the nginx
// SPA fallback, which must map BOTH the document AND the RSC payload (/post/<id>/*.txt) onto this
// shell — without the payload rule the client router 404s and falls back to a full document load.
// See deploy/nginx/cogno.conf. Do NOT set dynamicParams=false.

import { PostDetailView } from "./view";

export function generateStaticParams() {
  // ≥1 param is required to emit the route bundle under output:'export'. "_" is never a real post id
  // and validates to the in-app not-found; real ids fall through to the nginx SPA shell.
  return [{ id: "_" }];
}

export default function PostDetailPage() {
  return <PostDetailView />;
}
