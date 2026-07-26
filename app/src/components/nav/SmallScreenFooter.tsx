"use client";

// SmallScreenFooter — the policy links, for the widths where RightRail does not exist.
//
// THE HOLE THIS CLOSES. RightRail carries the Settings/Legal/Privacy/Policy row, and it is
// `display: none` below 1020px (AppShell.module.css). The only other surface linking those pages is
// Settings > About, and "settings" is deliberately NOT in AppShell's PUBLIC_SEGMENTS, so a SIGNED-OUT
// visitor who opens it is redirected to /welcome. Compose the two and a signed-out reader on a phone
// had no path to /policy at all — no path to the abuse contact, the content rules, or the report
// instructions.
//
// That is precisely the reader the whole surface was built for: somebody who followed a shared link,
// scrolled past something illegal, and has no account and no reason to make one. Adding the links to
// Settings alone reproduced the defect it was meant to fix, one breakpoint down.
//
// Rendered inside <main> after {children} and CSS-gated to the widths where the rail is absent, so the
// same links exist at every width and exactly once. Not a BottomTabBar entry: that bar is six fixed
// icon-only tabs and a seventh would crowd the primary navigation for a page read once.

import Link from "next/link";
import styles from "./SmallScreenFooter.module.css";

export function SmallScreenFooter() {
  return (
    <footer className={styles.footer}>
      <nav className={styles.links} aria-label="About this app">
        <Link href="/policy/" className={styles.link}>
          Content policy
        </Link>
        <span aria-hidden="true">·</span>
        <Link href="/legal/" className={styles.link}>
          Legal
        </Link>
        <span aria-hidden="true">·</span>
        <Link href="/privacy/" className={styles.link}>
          Privacy
        </Link>
      </nav>
    </footer>
  );
}
