"use client";

// BookmarksSection — Settings "Bookmarks": the mobile reach for the device-local saved-posts list
// (the bottom bar is a locked 4 tabs, so Bookmarks can't live there; desktop/tablet use the LeftNav
// item). This is only a launcher — the saved posts render on the /bookmarks route, not inline.
// Bookmarks are client-only (localStorage) — nothing is written to the chain, see lib/bookmarkStore.

import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";
import { useSession } from "@/components/Providers";
import { useBookmarkList } from "@/lib/bookmarkStore";

export function BookmarksSection() {
  const router = useRouter();
  const { viewer } = useSession();
  const count = useBookmarkList(viewer.address ?? null).length;

  return (
    <EmptyState
      title={count > 0 ? `${count} bookmarked ${count === 1 ? "post" : "posts"}` : "No bookmarks yet"}
      description="Saved posts are kept on this device only. Never written to the chain or synced across devices, and each account has its own list. Bookmark a post from the ··· menu on it."
      action={{ label: "Open bookmarks", onClick: () => router.push("/bookmarks/") }}
    />
  );
}
