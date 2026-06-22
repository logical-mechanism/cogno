// PostDetailPage — /post/[id] (doc 01 §1/§2, surface 08).
//
// STATIC EXPORT: this page.tsx is a SERVER component (NO "use client") because Next 14 forbids a
// page from being both a Client Component and exporting generateStaticParams(). generateStaticParams
// returns a single throwaway placeholder so the build emits the route bundle; the REAL id is read
// CLIENT-SIDE in the <PostDetailView> child via useParams() (never from props — the HTML on disk is
// the placeholder doc). Real deep links are served via the nginx SPA fallback (doc 01 §3). Do NOT set
// dynamicParams=false.

import { PostDetailView } from "./view";

export function generateStaticParams() {
  // ≥1 param is required to emit the route bundle under output:'export'. "_" is never a real post id
  // and validates to the in-app not-found; real ids fall through to the nginx SPA shell (doc 01 §2/§3).
  return [{ id: "_" }];
}

export default function PostDetailPage() {
  return <PostDetailView />;
}
