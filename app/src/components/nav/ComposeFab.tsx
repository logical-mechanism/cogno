"use client";

// ComposeFab — the mobile (<688px) floating compose button (doc 01 §5.4). A fixed accent circle above
// the BottomTabBar (bottom-right) that opens the compose modal overlay (full-screen sheet on mobile).
// Write intent funnels to /welcome/ when not connected / not bound (doc 01 §6.4).

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
    if (viewer.status === "ready") openCompose();
    else router.push("/welcome/");
  }, [viewer.status, openCompose, router]);

  // Hidden on the full-screen onboarding flow (doc 11 §11).
  if (pathname.startsWith("/welcome")) return null;

  return (
    <button type="button" className={styles.fab} onClick={onClick} aria-label="Compose post">
      <IconCompose size="var(--cg-icon-lg)" />
    </button>
  );
}
