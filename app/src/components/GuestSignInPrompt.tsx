"use client";

// GuestSignInPrompt — the logged-out "join the conversation" banner shown where the inline composer
// would be on a public surface. Reading is open to everyone (the AppShell wall only guards the
// write/config routes); this is the always-visible, all-breakpoints nudge that tells a browsing guest
// what signing in unlocks and where to do it. It renders NOTHING once the viewer is fully set up
// (viewer.status === "ready" → the real Composer owns the slot). A connected-but-unbound wallet is
// mid-signup, so it gets a "finish setup" variant instead of "sign in". The CTA routes to /welcome — the
// one onboarding surface every write affordance already funnels to.
//
// IT NAMES THE PRICE. A cold arrival should be able to find out that reading is free forever and that
// posting costs a refundable lock BEFORE investing anything, not four screens into onboarding after a
// permanent identity bind. The amount comes from the script's own floor (LOCK_ADA_WHOLE), never a
// literal, and "More about the lock" points at /legal#cost rather than restating the custody terms here.
//
// PLACEMENT RULE: one prompt per surface, where that surface's primary write affordance sits, and never
// two on screen. Home has the composer slot; a profile has the follow action. /post deliberately does
// NOT mount this — ThreadView already renders a reply Composer at every breakpoint, which carries its
// own signed-out prompt, and a banner above it would be the second affordance saying the same thing.

import { useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./GuestSignInPrompt.module.css";
import { useSession } from "./Providers";
import { LOCK_ADA_WHOLE } from "@/lib/cardano/blueprint";

/** Which surface this is sitting on, so the copy names the action the reader actually reached for. */
export type GuestPromptVariant = "home" | "profile";

const TITLE: Record<GuestPromptVariant, string> = {
  home: "Join the conversation",
  profile: "Follow this account",
};

export function GuestSignInPrompt({ variant = "home" }: { variant?: GuestPromptVariant }) {
  const router = useRouter();
  const { viewer } = useSession();

  // Fully set up → the real composer owns this slot; render nothing.
  if (viewer.status === "ready") return null;

  const unfinished = viewer.status === "not-identity-bound";

  return (
    <section
      className={styles.card}
      aria-label={unfinished ? "Finish setting up your account" : "Sign in to cogno"}
    >
      <div className={styles.copy}>
        <h2 className={styles.title}>{unfinished ? "Almost there" : TITLE[variant]}</h2>
        <p className={styles.body}>
          {unfinished ? (
            "Finish setting up your account to post, vote, and follow."
          ) : (
            <>
              Reading is free forever. To post, vote, or follow, sign in with a Cardano wallet and lock{" "}
              {LOCK_ADA_WHOLE} ADA you can take back whenever you want.{" "}
              <Link href="/legal/#cost" className={styles.link}>
                More about the lock
              </Link>
            </>
          )}
        </p>
      </div>
      <button type="button" className={styles.cta} onClick={() => router.push("/welcome/")}>
        {unfinished ? "Finish setup" : "Sign in"}
      </button>
    </section>
  );
}

export default GuestSignInPrompt;
