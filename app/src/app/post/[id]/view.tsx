"use client";

// PostDetailView — the client half of /post/[id] (surface 08). Reads the live id from useParams()
// and validates it (/^\d+$/); an invalid id (the static-export placeholder "_" or junk) → the in-app
// not-found (NOT a hard 404 — the server is never reached). A valid id mounts the back-arrow "Post"
// header + the ThreadView, which owns the focal/ancestor/replies composition + the inline reply
// composer + scroll-to-focal. The unknown-but-valid id case (no such post / outside snapshot) is
// handled inside ThreadView (→ NotFoundInline).

import { useParams } from "next/navigation";
import { StickyHeader, NotFoundInline } from "@/components/AppShell";
import { ThreadView } from "@/components/ThreadView";

export function PostDetailView() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  if (!/^\d+$/.test(id)) return <NotFoundInline kind="post" />;

  return (
    <>
      <StickyHeader showBack title="Post" />
      <ThreadView rootId={BigInt(id)} />
    </>
  );
}
