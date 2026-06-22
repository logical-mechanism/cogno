"use client";

// /compose (surface 09) — the FULL-PAGE composer fallback (doc 09 §1/§3.1). The PRIMARY compose
// presentation is the ComposerModal overlay owned by <ModalRouteHost> (AppShell); this real route
// is the cold deep-link / hard-refresh / no-JS share of /compose/. All behaviour lives in the
// ComposePage composite — this file only mounts it inside a Suspense boundary (useSearchParams()
// requires one under the static export).

import { Suspense } from "react";
import { ComposePage } from "@/components/compose/ComposePage";

export default function ComposeRoute() {
  return (
    <Suspense fallback={null}>
      <ComposePage />
    </Suspense>
  );
}
