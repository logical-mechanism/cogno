"use client";

// ComposeFab — the mobile (<688px) floating compose button. A fixed accent circle above
// the BottomTabBar (bottom-right) that opens the compose modal overlay (full-screen sheet on mobile).
// Write intent funnels to /welcome/ until setup is fully complete (bound + stake-bound + posting power,
// i.e. viewer.writeReady) — an explicit "Post" tap is clearer sent to finish setup than to a dead CTA.

import { useCallback, useEffect, useRef, useState } from "react";
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

  // Slide out of the way while the feed scrolls DOWN, and come back on any upward scroll or near the
  // top. The FAB is fixed at z 200 over a scrolling feed, so at rest it hit-tests on top of whichever
  // post card's "..." and Share happen to sit in its band, and a tap aimed at either opened the
  // composer instead. Restoring on scroll-up only is deliberate: taps happen at rest, so bringing it
  // back when the feed stops would put it over the control at the moment the user aims at it.
  const [tucked, setTucked] = useState(false);
  const lastY = useRef(0);
  useEffect(() => {
    lastY.current = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const dy = y - lastY.current;
      if (Math.abs(dy) > 4) {
        setTucked(dy > 0 && y > 120);
        lastY.current = y;
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Hidden on the full-screen onboarding flow, and on the full-page /compose route — where a cold load /
  // shared link renders ComposePage inside AppShell, and the FAB would float over it (tapping it would
  // stack the modal composer on top of the page composer).
  if (pathname.startsWith("/welcome") || pathname.startsWith("/compose")) return null;

  return (
    <button
      type="button"
      className={`${styles.fab} ${tucked ? styles.tucked : ""}`}
      onClick={onClick}
      aria-label="Compose post"
    >
      <IconCompose size="var(--cg-icon-lg)" />
    </button>
  );
}
