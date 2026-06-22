"use client";

// PostDetailView — the client half of /post/[id]. Reads the live id from useParams() and validates
// it (/^\d+$/); invalid → in-app not-found (NOT a hard 404). STUB: the full ThreadView is surface 08.

import { useParams } from "next/navigation";
import { StickyHeader, NotFoundInline } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";

export function PostDetailView() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  if (!/^\d+$/.test(id)) return <NotFoundInline kind="post" />;

  return (
    <>
      <StickyHeader showBack title="Post" />
      <EmptyState title="Post detail is coming soon" description={`Thread view for post #${id} lands here.`} />
    </>
  );
}
