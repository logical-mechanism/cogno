"use client";

// GuestSignInPrompt — the logged-out "join the conversation" banner shown where the inline composer
// would be on a public surface. Reading is open to everyone (the AppShell wall only guards the
// write/config routes); this is the always-visible, all-breakpoints nudge that tells a browsing guest
// what signing in unlocks and where to do it. It renders NOTHING once the viewer is fully set up
// (viewer.status === "ready" → the real Composer owns the slot). A connected-but-unbound wallet is
// mid-signup, so it gets a "finish setup" variant instead of "sign in". The CTA routes to /welcome — the
// one onboarding surface every write affordance already funnels to.

import { useRouter } from "next/navigation";
import styles from "./GuestSignInPrompt.module.css";
import { useSession } from "./Providers";

export function GuestSignInPrompt() {
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
        <h2 className={styles.title}>{unfinished ? "Almost there" : "Join the conversation"}</h2>
        <p className={styles.body}>
          {unfinished
            ? "Finish setting up your account to post, vote, and follow."
            : "Reading is open to everyone. Sign in with a Cardano wallet to post, vote, and follow."}
        </p>
      </div>
      <button type="button" className={styles.cta} onClick={() => router.push("/welcome/")}>
        {unfinished ? "Finish setup" : "Sign in"}
      </button>
    </section>
  );
}

export default GuestSignInPrompt;
