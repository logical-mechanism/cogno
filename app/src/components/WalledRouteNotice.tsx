"use client";

// WalledRouteNotice — what a signed-out visitor gets on /compose, /notifications or /settings.
//
// WHAT IT REPLACES. The wall used to answer with a full-screen `Loading…` and a post-paint
// `router.replace` to /welcome. So clicking Settings gave a blank spinner, then a silent teleport to a
// full-screen onboarding takeover that opened on "Choose a wallet" and never mentioned Settings. The
// visitor was not told where they were, why, or how to get back. That got worse once the nav started
// marking these routes "(sign in required)": the app now advertises a destination and then swallows
// anyone who takes it up on the offer.
//
// It renders INSIDE the shell, in place of the page, so the rails, tabs and footer stay put and the
// visitor is one click from anywhere else. Being stranded on a takeover was half the problem.
//
// WHY NOT THE SIGN-IN SHEET. That is for a blocked WRITE on a page you are already reading: it opens
// over live content and the point is not to take it away. Here there is no content to preserve, the
// route itself is the thing being refused, and a scrim over an empty page would be worse than a page.
// The CTA still routes through `welcomeUrlFor`, so `?next=` survives and finishing setup lands the
// visitor on the page they originally asked for.

import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./WalledRouteNotice.module.css";
import { welcomeUrlFor } from "@/lib/returnTo";
import { firstSegment } from "@/lib/routeAccess";
import { LOCK_ADA_WHOLE } from "@/lib/cardano/lockAmount";

interface Copy {
  /** Names the destination that refused them, so the page is not a generic "no". */
  title: string;
  body: string;
}

/**
 * Per-route copy. Keyed off the first path segment, the same way the wall itself decides, so this
 * cannot drift from `PUBLIC_SEGMENTS`. The fallback is deliberately generic rather than absent: a
 * future walled route gets an honest page instead of an empty one.
 */
function copyFor(segment: string): Copy {
  switch (segment) {
    case "settings":
      return {
        title: "Settings",
        body: "Your appearance, account and vault controls live here once you sign in. Reading needs no account at all.",
      };
    case "notifications":
      return {
        title: "Notifications",
        body: "This is where replies, quotes and follows to your account show up, once you have one.",
      };
    case "compose":
      return {
        title: "Post",
        body: `Reading is free forever. To post you need a Cardano wallet and ${LOCK_ADA_WHOLE} ADA locked in a contract only you can open.`,
      };
    default:
      // A NOUN, because the heading is `{title} needs an account` — "Sign in required" made that read
      // "Sign in required needs an account". Not hypothetical: routeAccess is deliberately fail-closed,
      // so every unclassified segment lands here, which means every mistyped URL and dead share link a
      // signed-out visitor opens (404.html renders through this same branch).
      return {
        title: "This page",
        body: "This part of cogno needs an account. Reading is free and always open.",
      };
  }
}

export function WalledRouteNotice({ pathname }: { pathname: string }) {
  const router = useRouter();
  const { title, body } = copyFor(firstSegment(pathname));

  // Deliberately NO StickyHeader. It lives in AppShell, which renders this component, so importing it
  // here would make the two modules circular — the class of dependency that typechecks, usually works,
  // and then fails as "Element type is invalid" the first time module evaluation order shifts. The
  // heading below plus "Back to the timeline" cover what the header would have offered, and the shell's
  // own nav is still on screen around this.
  return (
    <section className={styles.notice} aria-labelledby="cg-walled-title">
      <h1 id="cg-walled-title" className={styles.title}>
        {title} needs an account
      </h1>
      <p className={styles.body}>{body}</p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.cta}
          // welcomeUrlFor carries `?next=`, so finishing setup returns them HERE rather than the feed.
          // Read the query off window.location, never useSearchParams(): this renders under a component
          // that wraps every route, and that hook would force a client bailout for the whole app under
          // `output: export`.
          onClick={() => router.push(welcomeUrlFor(pathname, window.location.search))}
        >
          Sign in
        </button>
        <Link href="/" className={styles.ghost}>
          Back to the timeline
        </Link>
      </div>
    </section>
  );
}

export default WalledRouteNotice;
