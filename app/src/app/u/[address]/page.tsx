// ProfilePage — /u/[address] (doc 01 §1, surface 07).
//
// STATIC EXPORT: this page.tsx is a SERVER component (NO "use client") because Next forbids a page
// from being both a Client Component and exporting generateStaticParams(). generateStaticParams returns
// a single throwaway placeholder so the build emits the route bundle; the REAL ss58 is read CLIENT-SIDE
// in the <ProfileView> child — from the URL, via useRouteSegment(). NOT via useParams(): that reads the
// router state tree, which this placeholder bakes as "_" for every profile (see lib/routeSegment).
// Real deep links are served via the nginx SPA fallback, which must map BOTH the document AND the RSC
// payload (/u/<addr>/*.txt) onto this shell — without the payload rule the client router 404s and falls
// back to a full document load. See deploy/nginx/cogno.conf. Do NOT set dynamicParams=false.

import { ProfileView } from "./view";

export function generateStaticParams() {
  return [{ address: "_" }];
}

export default function ProfilePage() {
  return <ProfileView />;
}
