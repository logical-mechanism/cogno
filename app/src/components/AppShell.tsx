"use client";

// AppShell — the persistent X-style chrome. Mounted ONCE inside <Providers>; only
// <main>{children}</main> swaps on navigation, so the PAPI ws connection, the live source.watch()
// subscription, the connected wallet/identity, and the rails all survive client route changes.
//
// Layout by breakpoint (exact px): LeftNav (desktop ≥1020) / BottomTabBar (mobile <688) ·
// main (centered, capped at --cg-col-feed 600px) · RightRail (desktop ≥1020) · ComposeFab (mobile) ·
// ModalRouteHost. The Toaster is already mounted by ToasterProvider, so it is NOT re-mounted here.
//
// The DOCUMENT scrolls at every breakpoint — `main` is NOT a scroll container (AppShell.module.css:
// "main FLOWS with the document"), which is what lets a scroll over the rails or the side margins move
// the feed, with the rails held in place by `position: sticky`. Scroll the feed with lib/scroll.ts's
// scrollToTop(). (This comment used to claim main was `overflow-y:auto; height:100vh` on desktop; it
// never was, and Home carried a scrollable-ancestor walk that consequently never found anything.)
//
// Also exports StickyHeader (the blurred per-surface header every page composes) and NotFoundInline
// (the in-app not-found state for an invalid dynamic param / unknown route).

import { type ReactNode, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./AppShell.module.css";
import { LeftNav } from "./nav/LeftNav";
import { RightRail } from "./nav/RightRail";
import { useSearchHotkey } from "@/hooks/useSearchHotkey";
import { BottomTabBar } from "./nav/BottomTabBar";
import { ComposeFab } from "./nav/ComposeFab";
import { ModalRouteHost } from "./modal/ModalRouteHost";
import { EmptyState } from "./EmptyState";
import { Loading } from "./Loading";
import { IconBack } from "./icons";
import { useSession } from "./Providers";
import { welcomeUrlFor } from "@/lib/returnTo";

/** /welcome is the standalone onboarding surface — it owns the whole canvas (no rails). */
function isWelcomePath(pathname: string | null): boolean {
  return !!pathname && (pathname === "/welcome" || pathname.startsWith("/welcome/"));
}

// The read-only surfaces a LOGGED-OUT visitor may browse without signing in: the timeline, discovery, a
// post, a profile, and the static legal pages. Everything else (compose, settings, notifications,
// bookmarks — the write/config/personal surfaces) stays behind the wall and bounces a guest to /welcome.
//
// Matched by first path segment so it is trailing-slash- and dynamic-segment-proof under `output: export`
// ("/" → "", "/post/1/" → "post", "/u/5Grw…/" → "u"). Fail-CLOSED: a route whose segment is not listed is
// treated as private, so a newly-added route is walled until it is deliberately opened here. /welcome is
// intentionally NOT listed — it is the onboarding canvas, handled by its own `onWelcome` branch below.
const PUBLIC_SEGMENTS = new Set(["", "explore", "post", "u", "legal", "privacy"]);
function isPublicPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return PUBLIC_SEGMENTS.has(pathname.split("/")[1] ?? "");
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { viewer } = useSession();

  // "Logged in" = an identity-bound session (a real account). A connected-but-unbound wallet is still
  // mid-signup and lives inside the welcome flow, not the app.
  const loggedIn = viewer.status === "ready";
  const onWelcome = isWelcomePath(pathname);
  const publicRoute = isPublicPath(pathname);

  // Soft auth wall (X-style logged-out browsing): a guest may READ the public surfaces (the timeline, a
  // post, a profile, explore, the legal pages) but the WRITE/CONFIG surfaces (compose, settings,
  // notifications, bookmarks) still bounce a logged-out visitor to the welcome/join page. There is no
  // persistent session — the posting key is re-derived from a wallet signature each visit and nothing is
  // stored, so every fresh load starts logged-out; the point is that reading no longer requires a bind
  // (every write affordance itself already funnels to /welcome via `viewer.writeReady`).
  //
  // The bounce REMEMBERS where you were going (`?next=`) so a deep-linked private route survives sign-in.
  // A public deep link (a shared /post/123/) now simply opens for the guest — no bounce needed. The query
  // string comes off `window.location` rather than useSearchParams(): this component wraps every route,
  // and useSearchParams() here would force a client-side bailout for the whole app under `output: export`.
  useEffect(() => {
    if (loggedIn || onWelcome || publicRoute) return;
    router.replace(welcomeUrlFor(pathname, window.location.search));
  }, [loggedIn, onWelcome, publicRoute, pathname, router]);

  // App-wide "/" → focus the SearchBar (works on every surface with a search box, not just /explore).
  useSearchHotkey();

  // The welcome flow owns the full viewport — no LeftNav/RightRail/BottomTabBar/ComposeFab chrome. It is
  // a <main> landmark (not a bare <div>): /welcome is the canonical cold-load landing, so without it the
  // page a screen reader / Lighthouse first sees has no main region at all (a11y: landmark-one-main).
  if (onWelcome) {
    return <main className={styles.standalone}>{children}</main>;
  }

  // Logged-out on a WALLED route: never flash its children (the redirect above is a post-paint effect, so
  // without this the private page would render for one frame before the bounce lands) and never flash a
  // BLANK PAGE either. A logged-out visitor to a PUBLIC route falls through to the shell below and browses
  // read-only. Neutral copy on purpose — this covers both "your session is coming back" and "you are
  // genuinely logged out and about to land on /welcome".
  if (!loggedIn && !publicRoute) return <Loading variant="screen" label="Loading…" />;

  return (
    <div className={styles.shell}>
      {/* First focusable element: a keyboard user can jump the nav straight to the feed (a11y). */}
      <a href="#cg-main" className={styles.skipLink}>
        Skip to content
      </a>
      <div className={styles.container}>
        <div className={styles.leftCol}>
          <LeftNav />
        </div>

        <main id="cg-main" tabIndex={-1} className={styles.main}>
          {children}
        </main>

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

// ── StickyHeader — the blurred per-surface header ────────────────────────────────────────────────

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
    // Prefer in-app history; fall back to Home for a cold deep link.
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

// ── NotFoundInline — the in-app not-found body ───────────────────────────────────────────────────

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
