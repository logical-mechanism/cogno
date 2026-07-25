"use client";

// ListsSection — Settings "Lists": the mobile reach for the device-local account lists (the bottom bar is
// a locked 4 tabs, so Lists can't live there; desktop/tablet use the LeftNav item). Without this a
// mobile-only viewer could never create a list, which would also make PostCard's "Add to <list>" rows
// permanently invisible to them — the rows only appear once at least one list exists.
//
// Launcher only — the lists and their timelines render on the /lists route, not inline. Lists are
// client-only (localStorage), never written to the chain: see lib/localListStore.

import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";
import { useSession } from "@/components/Providers";
import { useLocalLists } from "@/lib/localListStore";

export function ListsSection() {
  const router = useRouter();
  const { viewer } = useSession();
  const lists = useLocalLists(viewer.address ?? null);
  const count = lists.length;

  return (
    <EmptyState
      title={count > 0 ? `${count} ${count === 1 ? "list" : "lists"}` : "No lists yet"}
      description="Group accounts into a list and read a timeline of just those accounts. Lists are saved on this device, per account — nothing is written to the chain."
      action={{ label: "Open lists", onClick: () => router.push("/lists/") }}
    />
  );
}
