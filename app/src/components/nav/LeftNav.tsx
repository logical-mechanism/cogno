"use client";

// LeftNav — the persistent left rail (doc 01 §5.2 / §6.1). Desktop (≥1020px): icons + labels + a
// full-width accent "Post" pill + the Account mini-widget. Tablet (688–1019px): the same rail
// collapses to icons only (CSS) and the Post pill becomes a round accent icon button.
//
// Items (top→bottom): cogno wordmark → / · Home · Explore · Profile · Bookmarks · Settings · Post ·
// Account. (Bookmarks is the desktop/tablet reach for the device-local /bookmarks list; on mobile the
// bottom bar stays a locked 4 tabs, so a Settings launcher covers it there.)
// Active state uses usePathname() with FILLED icons (X-style). Profile resolves to /u/<me>/ when
// connected, else /welcome/ (doc 01 §6.4). The "Post" pill opens the compose modal overlay
// (modalStore.openCompose). Reads the gate from useSession(); never builds an extrinsic.

import { useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import styles from "./LeftNav.module.css";
import { Account } from "../Account";
import { IconHome, IconSearch, IconProfile, IconBookmark, IconSettings, IconCompose, IconBell } from "../icons";
import { useSession } from "../Providers";
import { useNotificationsFeed } from "@/hooks/useNotifications";
import { useNavReTap } from "@/hooks/useNavReTap";
import { useModalStore } from "@/lib/modalStore";
import type { IconProps } from "../icons";

interface NavItem {
  label: string;
  href: string;
  Icon: (p: IconProps) => React.ReactElement;
  /** active-match predicate against the current pathname. */
  match: (path: string) => boolean;
  /** unread badge count (Notifications); omitted / 0 → no badge. */
  badge?: number;
}

export function LeftNav() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const { viewer } = useSession();
  const { unreadCount } = useNotificationsFeed();
  const { openCompose } = useModalStore();
  // Clicking the tab you're already on scrolls that surface to the top (and, on Home, refreshes it).
  const reTap = useNavReTap();

  // Profile target resolves to the connected account, else the onboarding gate (doc 01 §6.4).
  const profileHref = viewer.address ? `/u/${viewer.address}/` : "/welcome/";

  const items: NavItem[] = [
    { label: "Home", href: "/", Icon: IconHome, match: (p) => p === "/" },
    { label: "Explore", href: "/explore/", Icon: IconSearch, match: (p) => p.startsWith("/explore") },
    {
      label: "Notifications",
      href: "/notifications/",
      Icon: IconBell,
      match: (p) => p.startsWith("/notifications"),
      badge: unreadCount,
    },
    {
      label: "Profile",
      href: profileHref,
      Icon: IconProfile,
      // Own profile only — not every /u/<someone>. (Addresses are fixed-length, so a prefix match on
      // our own address never collides with another account's path.)
      match: (p) =>
        viewer.address ? p.startsWith(`/u/${viewer.address}`) : p.startsWith("/welcome"),
    },
    { label: "Bookmarks", href: "/bookmarks/", Icon: IconBookmark, match: (p) => p.startsWith("/bookmarks") },
    { label: "Settings", href: "/settings/", Icon: IconSettings, match: (p) => p.startsWith("/settings") },
  ];

  const onPost = useCallback(() => {
    if (viewer.writeReady) {
      openCompose();
    } else {
      // Write intent funnels to /welcome until setup is fully complete (bound + stake-bound + posting
      // power). An explicit "Post" click is clearer sent to finish setup than to a disabled composer CTA.
      router.push("/welcome/");
    }
  }, [viewer.writeReady, openCompose, router]);

  return (
    <nav className={styles.nav} aria-label="Primary">
      <div className={styles.inner}>
        <Link href="/" className={styles.wordmark} onClick={reTap("/")} aria-label="cogno-chain home">
          <span className={styles.wordmarkText}>cogno</span>
        </Link>

        <ul className={styles.items}>
          {items.map(({ label, href, Icon, match, badge }) => {
            const active = match(pathname);
            const count = badge && badge > 0 ? badge : 0;
            return (
              <li key={label}>
                <Link
                  href={href}
                  onClick={reTap(href)}
                  className={`${styles.item} ${active ? styles.active : ""}`}
                  aria-current={active ? "page" : undefined}
                  aria-label={count > 0 ? `${label} (${count} unread)` : undefined}
                >
                  <span className={styles.itemIcon}>
                    <Icon filled={active} size="var(--cg-icon-lg)" />
                    {count > 0 && (
                      <span className={styles.badge} aria-hidden>
                        {count > 99 ? "99+" : count}
                      </span>
                    )}
                  </span>
                  <span className={styles.itemLabel}>{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>

        <button type="button" className={styles.postBtn} onClick={onPost} aria-label="Post">
          <span className={styles.postLabel}>Post</span>
          <span className={styles.postIcon}>
            <IconCompose size="var(--cg-icon-md)" />
          </span>
        </button>
      </div>

      <div className={styles.footer}>
        <Account />
      </div>
    </nav>
  );
}
