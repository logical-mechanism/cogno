"use client";

// AppShell — the persistent X-style chrome (doc 01 §4.1 / §5). Mounted ONCE inside <Providers>; only
// <main>{children}</main> swaps on navigation, so the PAPI ws connection, the live source.watch()
// subscription, the connected wallet/identity, and the rails all survive client route changes.
//
// Layout by breakpoint (exact px, doc 01 §5.1): LeftNav (desktop ≥1020) / BottomTabBar (mobile <688) ·
// main (THE scroll container on desktop: overflow-y:auto; height:100vh; centered, capped at
// --cg-col-feed 600px) · RightRail (desktop ≥1020) · ComposeFab (mobile) · ModalRouteHost. The Toaster
// is already mounted by ToasterProvider, so it is NOT re-mounted here.
//
// Also exports StickyHeader (the blurred per-surface header every page composes) and NotFoundInline
// (the in-app not-found state for an invalid dynamic param / unknown route).

import { type ReactNode, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./AppShell.module.css";
import { LeftNav } from "./nav/LeftNav";
import { RightRail } from "./nav/RightRail";
import { BottomTabBar } from "./nav/BottomTabBar";
import { ComposeFab } from "./nav/ComposeFab";
import { ModalRouteHost } from "./modal/ModalRouteHost";
import { EmptyState } from "./EmptyState";
import { IconBack } from "./icons";
import { useSession } from "./Providers";

/** /welcome is the standalone onboarding surface — it owns the whole canvas (no rails). */
function isWelcomePath(pathname: string | null): boolean {
  return !!pathname && (pathname === "/welcome" || pathname.startsWith("/welcome/"));
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { viewer } = useSession();

  // "Logged in" = an identity-bound session (a real account). A connected-but-unbound wallet is still
  // mid-signup and lives inside the welcome flow, not the app.
  const loggedIn = viewer.status === "ready";
  const onWelcome = isWelcomePath(pathname);

  // Hard auth wall (X-style): a logged-out visitor to ANY app route is bounced to the standalone
  // welcome/join page. There is no persistent session — the posting key is re-derived from a wallet
  // signature each visit and nothing is stored, so every fresh load starts logged-out. The welcome
  // page is therefore the canonical landing; the feed only exists once you're bound.
  useEffect(() => {
    if (!loggedIn && !onWelcome) router.replace("/welcome/");
  }, [loggedIn, onWelcome, router]);

  // The welcome flow owns the full viewport — no LeftNav/RightRail/BottomTabBar/ComposeFab chrome.
  if (onWelcome) {
    return <div className={styles.standalone}>{children}</div>;
  }

  // Logged-out on an app route: render nothing while the redirect effect runs (never flash the feed).
  if (!loggedIn) return null;

  return (
    <div className={styles.shell}>
      <div className={styles.container}>
        <div className={styles.leftCol}>
          <LeftNav />
        </div>

        <main className={styles.main}>{children}</main>

        <div className={styles.rightCol}>
          <RightRail />
        </div>
      </div>

      {/* mobile-only chrome (CSS-gated) */}
      <BottomTabBar />
      <ComposeFab />

      {/* overlays — never block the reads behind them */}
      <ModalRouteHost />
    </div>
  );
}

// ── StickyHeader — the blurred per-surface header (doc 01 §8) ─────────────────────────────────────

export interface StickyHeaderProps {
  /** Primary label ("Home", a display name, "Settings", …). */
  title?: ReactNode;
  /** Smaller line under the title (e.g. a post-count subtitle). */
  subtitle?: ReactNode;
  /** Show the X-style back arrow (prefers history.back(), else /). */
  showBack?: boolean;
  /** A second sticky row (TimelineTabs / ProfileTabs / search-scope tabs). */
  tabs?: ReactNode;
  /** Trailing controls (rare). */
  actions?: ReactNode;
}

export function StickyHeader({ title, subtitle, showBack, tabs, actions }: StickyHeaderProps) {
  const router = useRouter();
  const onBack = () => {
    // Prefer in-app history; fall back to Home for a cold deep link (doc 01 §8).
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/");
  };

  return (
    <header className={styles.header}>
      <div className={styles.headerRow}>
        {showBack && (
          <button type="button" className={styles.back} onClick={onBack} aria-label="Back">
            <IconBack size="var(--cg-icon-md)" />
          </button>
        )}
        {(title || subtitle) && (
          <div className={styles.headerTitles}>
            {title && <h1 className={styles.headerTitle}>{title}</h1>}
            {subtitle && <p className={styles.headerSubtitle}>{subtitle}</p>}
          </div>
        )}
        {actions && <div className={styles.headerActions}>{actions}</div>}
      </div>
      {tabs && <div className={styles.headerTabs}>{tabs}</div>}
    </header>
  );
}

// ── NotFoundInline — the in-app not-found body (doc 01 §2) ────────────────────────────────────────

export interface NotFoundInlineProps {
  kind?: "post" | "profile" | "page";
}

export function NotFoundInline({ kind = "page" }: NotFoundInlineProps) {
  const copy: Record<NonNullable<NotFoundInlineProps["kind"]>, { title: string; description: string }> = {
    post: { title: "This post doesn't exist", description: "It may have never existed, or the link is malformed." },
    profile: { title: "This account doesn't exist", description: "Check the address and try again." },
    page: { title: "This page doesn't exist", description: "The link may be broken or the page may have moved." },
  };
  const { title, description } = copy[kind];

  return (
    <>
      <StickyHeader showBack title="Not found" />
      <EmptyState
        title={title}
        description={description}
        action={undefined}
        icon={undefined}
      />
      <div className={styles.notFoundHome}>
        <Link href="/" className={styles.homeLink}>
          Go to Home
        </Link>
      </div>
    </>
  );
}
