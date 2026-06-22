"use client";

// ComposePage — /compose (doc 01 §1, surface 09). STUB: the full-page composer fallback (the modal
// is the primary presentation, via ModalRouteHost). The foundation mounts the shell + a placeholder;
// surface 09 fills it with the Composer wired to the session + capacity gate.

import { StickyHeader } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";

export default function ComposePage() {
  return (
    <>
      <StickyHeader showBack title="Compose" />
      <EmptyState title="Compose is coming soon" description="Write a post here." />
    </>
  );
}
