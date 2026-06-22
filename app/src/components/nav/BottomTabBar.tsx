"use client";

// BottomTabBar — the mobile (<688px) fixed bottom navigation (doc 01 §5.4 / §6.2). EXACTLY 4 tabs:
// Home · Explore · Profile · Settings. Compose is the FAB (ComposeFab), never a tab (X-exact). Active
// item = filled icon + accent tint. Profile resolves to /u/<me>/ when connected, else /welcome/.

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./BottomTabBar.module.css";
import { IconHome, IconSearch, IconProfile, IconSettings } from "../icons";
import { useSession } from "../Providers";
import type { IconProps } from "../icons";

interface Tab {
  label: string;
  href: string;
  Icon: (p: IconProps) => React.ReactElement;
  match: (path: string) => boolean;
}

export function BottomTabBar() {
  const pathname = usePathname() ?? "/";
  const { viewer } = useSession();
  const profileHref = viewer.address ? `/u/${viewer.address}/` : "/welcome/";

  // HOOK: notifications — when notifications ship, this bar becomes Home · Explore · Notifications ·
  // Profile and Settings moves into the top-bar drawer (planned swap; do not build now). DEFERRED.

  const tabs: Tab[] = [
    { label: "Home", href: "/", Icon: IconHome, match: (p) => p === "/" },
    { label: "Explore", href: "/explore/", Icon: IconSearch, match: (p) => p.startsWith("/explore") },
    {
      label: "Profile",
      href: profileHref,
      Icon: IconProfile,
      match: (p) => p.startsWith("/u/") || (!viewer.address && p.startsWith("/welcome")),
    },
    { label: "Settings", href: "/settings/", Icon: IconSettings, match: (p) => p.startsWith("/settings") },
  ];

  return (
    <nav className={styles.bar} aria-label="Primary">
      {tabs.map(({ label, href, Icon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={label}
            href={href}
            className={`${styles.tab} ${active ? styles.active : ""}`}
            aria-current={active ? "page" : undefined}
            aria-label={label}
          >
            <Icon filled={active} size="var(--cg-icon-lg)" />
          </Link>
        );
      })}
    </nav>
  );
}
