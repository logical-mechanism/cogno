"use client";

// ExplorePage — /explore (doc 01 §1, surface 10). STUB: the SearchBar + ExploreList + people/posts
// results are surface 10. The foundation mounts the shell + a sticky header + a "coming soon"
// EmptyState; the rich surface fills it. The search term arrives client-side via ?q= (read with
// useSearchParams in surface 10) — no server query parsing (static export).

import { StickyHeader } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";

export default function ExplorePage() {
  return (
    <>
      <StickyHeader title="Explore" />
      <EmptyState title="Explore is coming soon" description="Search and discovery land here." />
    </>
  );
}
