"use client";

// not-found.tsx — Next renders this into out/404.html, which is the nginx SPA-fallback document (doc
// any deep link that misses on disk is served this page, the client router boots the full
// AppShell (mounted by the root layout), then re-resolves the real route. So this file only needs to
// render the in-app not-found BODY — the persistent chrome (LeftNav/RightRail/header) comes from the
// layout's AppShell, which wraps every route including this one.

import { NotFoundInline } from "@/components/AppShell";

export default function NotFound() {
  return <NotFoundInline kind="page" />;
}
