// ProfilePage — /u/[address] (doc 01 §1, surface 07).
//
// STATIC EXPORT: this page.tsx is a SERVER component (NO "use client") because Next 14 forbids a page
// from being both a Client Component and exporting generateStaticParams(). generateStaticParams returns
// a single throwaway placeholder so the build emits the route bundle; the REAL ss58 is read CLIENT-SIDE
// in the <ProfileView> child via useParams(). Real deep links are served via the nginx SPA fallback
// (doc 01 §3). Do NOT set dynamicParams=false.

import { ProfileView } from "./view";

export function generateStaticParams() {
  return [{ address: "_" }];
}

export default function ProfilePage() {
  return <ProfileView />;
}
