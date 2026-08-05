"use client";

// ComposeFab — the mobile (<688px) floating compose button. A fixed accent circle above
// the BottomTabBar (bottom-right) that opens the compose modal overlay (full-screen sheet on mobile).
// Write intent funnels to /welcome/ until setup is fully complete (bound + stake-bound + posting power,
// i.e. viewer.writeReady) — an explicit "Post" tap is clearer sent to finish setup than to a dead CTA.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import styles from "./ComposeFab.module.css";
import { IconCompose } from "../icons";
import { useSession } from "../Providers";
import { signInPromptActions } from "@/lib/signInPromptStore";
import { useModalStore } from "@/lib/modalStore";

export function ComposeFab() {
  const pathname = usePathname() ?? "/";
  const { viewer } = useSession();
  const { openCompose } = useModalStore();

  const onClick = useCallback(() => {
    if (viewer.writeReady) openCompose();
    else signInPromptActions.open("post");
  }, [viewer.writeReady, openCompose]);

  // Slide out of the way while the feed scrolls DOWN, and come back on any upward scroll or near the
  // top. The FAB is fixed at z 200 over a scrolling feed, so at rest it hit-tests on top of whichever
  // post card's "..." and Share happen to sit in its band, and a tap aimed at either opened the
  // composer instead. Restoring on scroll-up only is deliberate: taps happen at rest, so bringing it
  // back when the feed stops would put it over the control at the moment the user aims at it.
  //
  // Gated on a real gesture, because a PROGRAMMATIC scroll also fires this event: useLiveFeed
  // restores a saved feed position with window.scrollTo on every Home mount that has a snapshot,
  // which reads as one huge downward delta. Without the gate, read feed -> open post -> Back hid the
  // compose button before the user had touched anything, and since it only comes back on scroll-up
  // it stayed hidden. On mobile this is the ONLY way to compose.
  const [tucked, setTucked] = useState(false);
  const lastY = useRef(0);
  const gestured = useRef(false);
  useEffect(() => {
    lastY.current = window.scrollY;
    const onGesture = () => {
      gestured.current = true;
    };
    const onScroll = () => {
      const y = window.scrollY;
      const dy = y - lastY.current;
      if (Math.abs(dy) <= 4) return;
      lastY.current = y;
      if (!gestured.current) return; // a restore or an anchor jump, not the reader scrolling
      setTucked(dy > 0 && y > 120);
    };
    window.addEventListener("touchmove", onGesture, { passive: true });
    window.addEventListener("wheel", onGesture, { passive: true });
    window.addEventListener("keydown", onGesture);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("touchmove", onGesture);
      window.removeEventListener("wheel", onGesture);
      window.removeEventListener("keydown", onGesture);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  // Hidden on the full-screen onboarding flow, and on the full-page /compose route — where a cold load /
  // shared link renders ComposePage inside AppShell, and the FAB would float over it (tapping it would
  // stack the modal composer on top of the page composer).
  //
  // Also hidden on the three DOCUMENT routes. The button is an opaque filled circle, so wherever it
  // rests it does not dim the content underneath, it replaces it — and on a page of continuous prose
  // that means the ends of a couple of sentences are simply gone until you scroll. On a feed that is
  // survivable (the content is a repeating list of rows and the FAB tucks away on scroll); on /policy,
  // which is the abuse-reporting instructions, it was hiding the tails of two consecutive lines at 320px
  // on load. There is also nothing to compose against here: these pages are static text, not a surface
  // you reply to. Same reasoning as /welcome above — a route where the affordance does not belong.
  if (
    pathname.startsWith("/welcome") ||
    pathname.startsWith("/compose") ||
    pathname.startsWith("/policy") ||
    pathname.startsWith("/legal") ||
    pathname.startsWith("/privacy")
  ) {
    return null;
  }

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
