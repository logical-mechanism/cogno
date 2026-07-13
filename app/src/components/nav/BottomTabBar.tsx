"use client";

// BottomTabBar — the mobile (<688px) fixed bottom navigation (doc 01 §5.4 / §6.2). 5 tabs:
// Home · Explore · Notifications · Profile · Settings. Compose is the FAB (ComposeFab), never a tab
// (X-exact). Active item = filled icon + accent tint; Notifications carries an unread badge. Profile
// resolves to /u/<me>/ when connected, else /welcome/.

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./BottomTabBar.module.css";
import { IconHome, IconSearch, IconProfile, IconSettings, IconBell } from "../icons";
import { useSession } from "../Providers";
import { useNotificationsFeed } from "@/hooks/useNotifications";
import { useNavReTap } from "@/hooks/useNavReTap";
import type { IconProps } from "../icons";

interface Tab {
  label: string;
  href: string;
  Icon: (p: IconProps) => React.ReactElement;
  match: (path: string) => boolean;
  badge?: number;
}

export function BottomTabBar() {
  const pathname = usePathname() ?? "/";
  const { viewer } = useSession();
  const { unreadCount } = useNotificationsFeed();
  // Tapping the tab you're already on scrolls that surface to the top (and, on Home, refreshes it).
  const reTap = useNavReTap();
  const profileHref = viewer.address ? `/u/${viewer.address}/` : "/welcome/";

  const tabs: Tab[] = [
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
      // Own profile only — not every /u/<someone>.
      match: (p) =>
        viewer.address ? p.startsWith(`/u/${viewer.address}`) : p.startsWith("/welcome"),
    },
    { label: "Settings", href: "/settings/", Icon: IconSettings, match: (p) => p.startsWith("/settings") },
  ];

  // The full-screen onboarding flow hides the bottom tabs (doc 11 §11).
  if (pathname.startsWith("/welcome")) return null;

  return (
    <nav className={styles.bar} aria-label="Primary">
      {tabs.map(({ label, href, Icon, match, badge }) => {
        const active = match(pathname);
        const count = badge && badge > 0 ? badge : 0;
        return (
          <Link
            key={label}
            href={href}
            onClick={reTap(href)}
            className={`${styles.tab} ${active ? styles.active : ""}`}
            aria-current={active ? "page" : undefined}
            aria-label={count > 0 ? `${label} (${count} unread)` : label}
          >
            <span className={styles.tabIcon}>
              <Icon filled={active} size="var(--cg-icon-lg)" />
              {count > 0 && (
                <span className={styles.badge} aria-hidden>
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
