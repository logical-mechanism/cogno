"use client";

// /compose — the FULL-PAGE composer fallback. The PRIMARY compose
// presentation is the ComposerModal overlay owned by <ModalRouteHost> (AppShell); this real route
// is the cold deep-link / hard-refresh / no-JS share of /compose/. All behaviour lives in the
// ComposePage composite — this file only mounts it inside a Suspense boundary (useSearchParams()
// requires one under the static export).

import { Suspense } from "react";
import { ComposePage } from "@/components/compose/ComposePage";
import { Loading } from "@/components/Loading";

export default function ComposeRoute() {
  return (
    <Suspense fallback={<Loading variant="surface" label="Opening the composer…" />}>
      <ComposePage />
    </Suspense>
  );
}
