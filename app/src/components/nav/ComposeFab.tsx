"use client";

// ComposeFab — the mobile (<688px) floating compose button. A fixed accent circle above
// the BottomTabBar (bottom-right) that opens the compose modal overlay (full-screen sheet on mobile).
// Write intent funnels to /welcome/ until setup is fully complete (bound + stake-bound + posting power,
// i.e. viewer.writeReady) — an explicit "Post" tap is clearer sent to finish setup than to a dead CTA.

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import styles from "./ComposeFab.module.css";
import { IconCompose } from "../icons";
import { useSession } from "../Providers";
import { useModalStore } from "@/lib/modalStore";

export function ComposeFab() {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { viewer } = useSession();
  const { openCompose } = useModalStore();

  const onClick = useCallback(() => {
    if (viewer.writeReady) openCompose();
    else router.push("/welcome/");
  }, [viewer.writeReady, openCompose, router]);

  // Hidden on the full-screen onboarding flow, and on the full-page /compose route — where a cold load /
  // shared link renders ComposePage inside AppShell, and the FAB would float over it (tapping it would
  // stack the modal composer on top of the page composer).
  if (pathname.startsWith("/welcome") || pathname.startsWith("/compose")) return null;

  return (
    <button type="button" className={styles.fab} onClick={onClick} aria-label="Compose post">
      <IconCompose size="var(--cg-icon-lg)" />
    </button>
  );
}
