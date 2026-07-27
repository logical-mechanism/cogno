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

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import styles from "./AppShell.module.css";
import { LeftNav } from "./nav/LeftNav";
import { RightRail } from "./nav/RightRail";
import { useSearchHotkey } from "@/hooks/useSearchHotkey";
import { useHelpHotkey } from "@/hooks/useHelpHotkey";
import { BottomTabBar } from "./nav/BottomTabBar";
import { ComposeFab } from "./nav/ComposeFab";
import { ModalRouteHost } from "./modal/ModalRouteHost";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { BootGuardNotice } from "./BootGuardNotice";
import { SmallScreenFooter } from "./nav/SmallScreenFooter";
import { EmptyState } from "./EmptyState";
import { Loading } from "./Loading";
import { IconBack } from "./icons";
import { useSession } from "./Providers";
import { welcomeUrlFor } from "@/lib/returnTo";
import { rememberContentRoute } from "@/lib/onboardingReturn";
// The route table lives in lib/ so a node test can assert it against the filesystem — see
// lib/routeAccess.ts and routeClassification.test.ts.
import { isPublicPath } from "@/lib/routeAccess";

/** /welcome is the standalone onboarding surface — it owns the whole canvas (no rails). */
function isWelcomePath(pathname: string | null): boolean {
  return !!pathname && (pathname === "/welcome" || pathname.startsWith("/welcome/"));
}

/** /settings carries the policy links itself (AboutSection), so the small-screen footer stands down. */
function isSettingsPath(pathname: string | null): boolean {
  return !!pathname && (pathname === "/settings" || pathname.startsWith("/settings/"));
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { viewer, signerCtl, identity } = useSession();

  // "Logged in" = an identity-bound session (a real account). A connected-but-unbound wallet is still
  // mid-signup and lives inside the welcome flow, not the app.
  const loggedIn = viewer.status === "ready";
  const onWelcome = isWelcomePath(pathname);
  const publicRoute = isPublicPath(pathname);

  // Whether this visitor HAS a session is not yet knowable. Two distinct windows, both of which end:
  //
  //  • `signerCtl.restoring` — the pre-hydration render (a localStorage read there would be a #418
  //    mismatch under `output: export`, so the remembered account cannot be read yet) plus the
  //    no-popup wallet probe, time-boxed in useSigner.
  //  • `identity.checkingBound` — the restored key's on-chain bound read, which useIdentity sets true
  //    DURING RENDER on a key change and time-boxes to 10s. `deriveSessionState` reports "disconnected"
  //    the whole time `bound === null`, so without this a restored user is bounced during their own
  //    bound read. /welcome already waits on exactly this via its own `showLoader`.
  //
  // Ordering matters here and is easy to get wrong: Providers WRAPS AppShell, so React runs this
  // (descendant) effect FIRST — the wall would `router.replace` the URL to /welcome before an
  // ancestor-level restore could land. That is why the restore is derived during render in useSigner
  // rather than installed by an effect, and why this flag is read rather than assumed.
  const deciding = signerCtl.restoring || identity.checkingBound;

  // Soft auth wall (X-style logged-out browsing): a guest may READ the public surfaces (the timeline, a
  // post, a profile, explore, the legal pages) but the WRITE/CONFIG surfaces (compose, settings,
  // notifications, bookmarks) still bounce a logged-out visitor to the welcome/join page. Reading never
  // requires a bind (every write affordance itself already funnels to /welcome via `viewer.writeReady`).
  //
  // `deciding` is the guard that makes a page refresh stop logging people out: the session is rebuilt
  // from lib/sessionRestore one render AFTER hydration, and this effect fires on the commit before it.
  // Without the guard the wall wins the race, rewrites the URL to /welcome, and the restore lands on a
  // page the user never asked for.
  //
  // The bounce REMEMBERS where you were going (`?next=`) so a deep-linked private route survives sign-in.
  // A public deep link (a shared /post/123/) now simply opens for the guest — no bounce needed. The query
  // string comes off `window.location` rather than useSearchParams(): this component wraps every route,
  // and useSearchParams() here would force a client-side bailout for the whole app under `output: export`.
  useEffect(() => {
    if (deciding || loggedIn || onWelcome || publicRoute) return;
    router.replace(welcomeUrlFor(pathname, window.location.search));
  }, [deciding, loggedIn, onWelcome, publicRoute, pathname, router]);

  // Remember the last CONTENT deep-link (a post / a profile) the visitor was reading, so finishing
  // onboarding returns them THERE rather than the timeline — a shared /post link should reopen the post,
  // not drop you on the feed. Home / explore / legal are intentionally not recorded (see
  // rememberContentRoute); /welcome and walled routes have a non-returnable segment, so they never
  // overwrite it. A public deep-link no longer bounces through the wall, so it carries no `?next=`; this
  // is that case's fallback (the wall's `?next=` still wins for a walled deep-link).
  useEffect(() => {
    if (pathname) rememberContentRoute(pathname);
  }, [pathname]);

  // App-wide "/" → focus the SearchBar (works on every surface with a search box, not just /explore).
  useSearchHotkey();

  // App-wide "?" → the shortcuts sheet. Local state, NOT a ModalKind: the modal router pushes a URL
  // per kind, and a help sheet has no business in the address bar.
  //
  // Gated on the branch that actually RENDERS the sheet. Hooks cannot be called conditionally, so this
  // registers above the two early returns below — and on /welcome (and on the logged-out walled-route
  // loader) "?" would otherwise set a flag with nothing mounted to read it, leaving it latched so the
  // sheet sprang open by itself on the next navigation into the shell. Neither surface offers any of the
  // listed shortcuts, so suppressing the key there is also the honest behaviour.
  const shellRenders = !onWelcome && (loggedIn || publicRoute);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  useHelpHotkey(openShortcuts, shellRenders);

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
  //
  // It also covers the whole `deciding` window for free, because `loggedIn` is false throughout it. Do
  // NOT add `deciding` to this condition: it is true on the pre-hydration render for EVERY visitor, so a
  // first-time guest would get a full-screen spinner where the timeline should paint — the exact LCP
  // regression the landing-page work went to some trouble to remove.
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
          {/* Renders nothing while the boot probe is in flight or when it comes back ok, which is
              every normal session. It exists for the one that isn't: a tab left open across a runtime
              upgrade looks completely functional and fails at the moment of posting, and this shell
              read no boot state at all, so nothing said otherwise until the click. */}
          <BootGuardNotice />
          {children}
          {/* The policy/legal/privacy links for the widths where RightRail (which carries them on
              desktop) is display:none. Without it a signed-out phone visitor could reach NONE of
              them, since the only other link lives in Settings and Settings is walled.

              Not on /settings, which is the one surface that already owns them: AboutSection carries
              its own `<nav aria-label="Policies">` with the same three destinations, and RightRail
              returns null there at EVERY width, so the footer's "pick them up where the rail drops
              them" rule does not apply. Rendering both put two policy nav landmarks in the a11y tree
              on the same page and showed a phone visitor the same three links twice. */}
          {!isSettingsPath(pathname) && <SmallScreenFooter />}
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
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
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
    post: { title: "This post doesn't exist", description: "Check the link and try again." },
    profile: { title: "This account doesn't exist", description: "Check the address and try again." },
    page: { title: "This page doesn't exist", description: "Check the link and try again." },
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
          Go home
        </Link>
      </div>
    </>
  );
}
