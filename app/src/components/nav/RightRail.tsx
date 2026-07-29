"use client";

// RightRail — the desktop (≥1020px) right column. Sticky full-height:
//   1. SearchBar — submitting routes to /explore/ (the explore surface reads the term client-side).
//      Search is node-served, so the input disables itself only before connect (SearchBar owns that
//      placeholder); submitting still lands on /explore.
//   2. "Who to follow" — up to 3 suggestions (useWhoToFollow), each with a FollowButton (optimistic,
//      useFollow). Node-served (FollowerCount ranking); hidden only when empty.
//   3. Footer — the Settings/Legal/Privacy/Policy links, then an icon-only ThemeToggle. (The labelled
//      toggle lives in Settings → Appearance; a label here overflows the 350px rail.) No trends, no
//      premium upsell. The link row WRAPS rather than clipping — see the note in the stylesheet.

import { useCallback, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./RightRail.module.css";
import { SearchBar } from "../SearchBar";
import { Avatar } from "../Avatar";
import { DisplayName } from "../DisplayName";
import { Handle } from "../Handle";
import { FollowButton } from "../FollowButton";
import { ThemeToggle } from "../ThemeToggle";
import { useSession } from "../Providers";
import { signInPromptActions } from "@/lib/signInPromptStore";
import { useWhoToFollow } from "@/hooks/useWhoToFollow";
import { useFollow } from "@/hooks/useFollow";
import { profileRouteForQuery } from "@/lib/ss58";
import { normalizeQuery } from "@/lib/search";
import { viewerBucket } from "@/lib/viewerBucket";

export function RightRail() {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { api, signer, source, viewer } = useSession();
  const me = viewerBucket(viewer);

  const [term, setTerm] = useState("");
  const searchEnabled = source != null;

  const submitSearch = useCallback(
    (q: string) => {
      // Normalize to match Explore's committed term (one URL / result set for "a  b" vs "a b").
      const next = normalizeQuery(q);
      // A checksum-valid account address jumps straight to that profile rather than a fruitless
      // body/display-name search (users click-to-copy ss58 addresses across the app).
      const accountRoute = profileRouteForQuery(next);
      router.push(
        accountRoute ?? (next.length > 0 ? `/explore/?q=${encodeURIComponent(next)}` : "/explore/"),
      );
    },
    [router],
  );

  const { suggestions } = useWhoToFollow(source, me, 3);
  const follow = useFollow(api, signer, source, me);
  // Only show the card once real suggestions exist ("hidden only when empty") — rendering during the
  // load window left a heading + "Show more" over an empty body, which reads as broken.
  const showWhoToFollow = suggestions.length > 0;

  const onToggleFollow = useCallback(
    (target: string, next: boolean) => {
      if (!viewer.writeReady) {
        signInPromptActions.open("follow");
        return;
      }
      if (next) follow.follow(target);
      else follow.unfollow(target);
    },
    [viewer.writeReady, follow],
  );

  // Suppress the whole rail where the surface owns the full content width: the
  // centered onboarding flow and the settings master/detail.
  if (pathname.startsWith("/welcome") || pathname.startsWith("/settings")) return null;

  // /explore owns its own header SearchBar — hide the rail's so there are not two
  // competing inputs on that surface (the recommended choice).
  const hideSearch = pathname.startsWith("/explore");

  return (
    <aside className={styles.rail} aria-label="Discover">
      {!hideSearch && (
        <div className={styles.searchSlot}>
          <SearchBar
            value={term}
            onChange={setTerm}
            onSubmit={submitSearch}
            searchEnabled={searchEnabled}
          />
        </div>
      )}

      {showWhoToFollow && (
        <section className={styles.card} aria-label="Who to follow">
          <h2 className={styles.cardTitle}>Who to follow</h2>
          {suggestions.map((s) => (
            <div className={styles.person} key={s.author}>
              {/* prefetch off: the rail renders on EVERY home load, guests included, so the default
                  viewport prefetch put three suggested accounts' ss58s in the access log against every
                  visitor's IP with zero interaction. /privacy says those logs show what an IP OPENED. */}
              <Link href={`/u/${s.author}/`} className={styles.personLink} prefetch={false}>
                <Avatar address={s.author} src={s.avatar} size="md" name={s.displayName} />
                <span className={styles.personWho}>
                  <DisplayName address={s.author} displayName={s.displayName} truncate />
                  <Handle address={s.author} />
                </span>
              </Link>
              <FollowButton
                target={s.author}
                isFollowing={follow.isFollowing(s.author)}
                viewer={viewer}
                onToggle={onToggleFollow}
                size="sm"
              />
            </div>
          ))}
          <Link href="/explore/" className={styles.showMore}>
            Show more
          </Link>
        </section>
      )}

      <footer className={styles.footer}>
        <nav className={styles.footerLinks} aria-label="About this app">
          {/* Labelled "Settings" for everyone: About is a section inside /settings, and LeftNav and
              BottomTabBar both name this destination Settings. /settings is walled, so a logged-out
              guest is routed to sign in. Legal/Privacy are public. */}
          <Link href="/settings/" className={styles.about}>
            Settings
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/legal/" className={styles.about}>
            Legal
          </Link>
          <span aria-hidden="true">·</span>
          <Link href="/privacy/" className={styles.about}>
            Privacy
          </Link>
          <span aria-hidden="true">·</span>
          {/* The report/abuse surface. It is the one link here a stranger may actually NEED, so it is
              not hidden behind Settings; the mobile path to it is Settings > About, since this whole
              rail is display:none below 1020px. */}
          <Link href="/policy/" className={styles.about}>
            Policy
          </Link>
        </nav>
        <ThemeToggle />
      </footer>
    </aside>
  );
}
