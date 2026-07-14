"use client";

// PostDetailView — the client half of /post/[id]. Reads the live id from the URL
// (useRouteSegment, NOT useParams — see lib/routeSegment) and validates it (/^\d+$/); an invalid id
// (the static-export placeholder "_" or junk) → the in-app not-found (NOT a hard 404 — the server is
// never reached). A valid id mounts the back-arrow "Post" header + the ThreadView, which owns the
// focal/ancestor/replies composition + the inline reply composer + scroll-to-focal. The
// unknown-but-valid id case (no such post / outside snapshot) is handled inside ThreadView
// (→ NotFoundInline).

import { StickyHeader, NotFoundInline } from "@/components/AppShell";
import { Skeleton } from "@/components/Skeleton";
import { ThreadView } from "@/components/ThreadView";
import { useRouteSegment } from "@/lib/routeSegment";

export function PostDetailView() {
  const id = useRouteSegment("post");

  // null = pre-hydration. Every thread is served the SAME prerendered shell, so judging the id on this
  // render is what bakes not-found into that shared HTML and flashes it on every cold deep link.
  if (id === null) {
    return (
      <>
        <StickyHeader showBack title="Post" />
        <Skeleton variant="thread" />
      </>
    );
  }

  if (!/^\d+$/.test(id)) return <NotFoundInline kind="post" />;

  return (
    <>
      <StickyHeader showBack title="Post" />
      {/* key: every thread shares the one exported route segment ("_"), so React would otherwise keep
          ThreadView mounted across /post/1/ → /post/2/ (an ancestor or reply click) and show post 1's
          thread under post 2's URL. */}
      <ThreadView key={id} rootId={BigInt(id)} />
    </>
  );
}
