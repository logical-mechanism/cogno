"use client";

// RightRail — the desktop (≥1020px) right column (doc 01 §5.2 / §6.3). Sticky full-height:
//   1. SearchBar — submitting routes to /explore/ (the explore surface reads the term client-side).
//      Gated on caps.search (node-served — true once connected); the input disables itself only before
//      connect (SearchBar owns that placeholder), and submitting still lands on /explore.
//   2. "Who to follow" — up to 3 suggestions (useWhoToFollow; caps.whoToFollow), each with a
//      FollowButton (optimistic, useFollow). Node-served (FollowerCount ranking); hidden only when empty.
//   3. Footer — ThemeToggle + an About link to /settings/. No trends, no premium upsell.

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
import { useWhoToFollow } from "@/hooks/useWhoToFollow";
import { useFollow } from "@/hooks/useFollow";
import { profileRouteForQuery } from "@/lib/ss58";
import { normalizeQuery } from "@/lib/search";

export function RightRail() {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { api, signer, source, viewer } = useSession();
  const me = viewer.address ?? null;

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
        router.push("/welcome/");
        return;
      }
      if (next) follow.follow(target);
      else follow.unfollow(target);
    },
    [viewer.writeReady, router, follow],
  );

  // Suppress the whole rail where the surface owns the full content width: the
  // centered onboarding flow (doc 11 §11) and the settings master/detail (doc 12 §1).
  if (pathname.startsWith("/welcome") || pathname.startsWith("/settings")) return null;

  // /explore owns its own header SearchBar — hide the rail's so there are not two
  // competing inputs on that surface (doc 10 §5.1, the recommended choice).
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
              <Link href={`/u/${s.author}/`} className={styles.personLink} aria-label={`Profile ${s.author}`}>
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
        <ThemeToggle withLabel />
        <Link href="/settings/" className={styles.about}>
          About &amp; settings
        </Link>
      </footer>
    </aside>
  );
}
