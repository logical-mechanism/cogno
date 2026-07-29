// Root layout — a Server Component (no data fetch). Emits <html>/<head>/<body>, the pre-paint theme
// boot script (no flash), the local-fonts side-effect, then the client <Providers> + <AppShell> chrome
// the whole App Router tree lives inside. The shell persists across navigations — only
// <main>{children}</main> swaps — so the PAPI ws connection + live feed subscription survive route
// changes.

import type { Metadata, Viewport } from "next";
import "../styles/globals.css";
import { FONTS_LOADED } from "../styles/fonts"; // value import → the @font-face side-effect can't be tree-shaken
import { Providers } from "@/components/Providers";
import { AppShell } from "@/components/AppShell";

// Reference FONTS_LOADED so the import is retained (the fonts module is a pure side-effect otherwise).
void FONTS_LOADED;

export const metadata: Metadata = {
  // Resolves every relative metadata URL — the opengraph-image below included — to an absolute one.
  // Scrapers ignore relative og:image URLs, so without this the link-card image never renders
  // anywhere. Pinned to the production origin: a static export has no per-host env, and a preview
  // deploy pointing its cards at production is the right trade.
  metadataBase: new URL("https://cogno.forum"),
  title: "cogno",
  // Names the PRICE, not just the mechanism. This is the first and often only sentence a cold visitor
  // reads before deciding to click, and the previous version ("...where ADA locked on Cardano is your
  // posting power") described how the chain works without saying that reading costs nothing or that
  // posting costs a refundable 100 ADA. Someone who is not going to lock should be able to find that
  // out here rather than four screens into onboarding, after a permanent identity bind.
  //
  // The amount is a LITERAL here and nowhere else. `metadata` is evaluated in a Server Component at
  // build time, and importing blueprint.ts (→ vaults.ts → the applied CBOR) to render one number
  // risks pulling that artifact into a client chunk. /legal and every in-app surface derive it from
  // MIN_LOCK; if the script's floor ever moves, this string is the one place to update by hand.
  description:
    "Post text, read text. Reading is free. To post, lock 100 ADA on Cardano and take it back whenever you want.",
  applicationName: "cogno",
  // The site is indexable. It is a live, honestly-labeled service; being a preprod testnet is not a
  // reason to hide it from search. (The app shell + static pages like /legal and /privacy are
  // meaningfully crawlable; the public read surfaces — the timeline, a post, a profile — are
  // client-rendered but no longer behind a connect wall, so a shared link opens for anyone and the
  // landing page is findable.) This was the sole failing SEO audit (is-crawlable).
  robots: { index: true, follow: true },
  // The tab icon is 😭 (U+1F62D), rasterized from Noto Color Emoji. The three files are App Router
  // metadata-file conventions — Next discovers `icon.png` / `apple-icon.png` / `favicon.ico` sitting next
  // to this layout and emits the <link> tags itself, so there is nothing to declare here. They live in
  // src/app/ rather than public/ for exactly that reason; moving them to public/ would silently drop the
  // tags (the file would still be served, and only /favicon.ico would still be found — by convention, not
  // by markup).
  //
  // openGraph is what a link to a post looks like when it is pasted into a chat or another social app.
  // Without it, the unfurl falls back to a bare URL. `robots` above governs SEARCH indexing; link
  // unfurls are independent of it, so this is worth setting regardless.
  //
  // The card image is `opengraph-image.png` sitting next to this layout — the same metadata-file
  // convention as the icons above, so Next emits the og:image tags (absolute via metadataBase) itself
  // and there is nothing to declare here; `opengraph-image.alt.txt` supplies its alt text. The image
  // is the wordmark card: Inter Tight 800 on --cg-bg black with the 😭 icon art, 1200×630 (the 2:1-ish
  // size X, Discord and Slack all want). Note X caches one scrape per URL for about a week, so a card
  // change shows up on not-yet-scraped URLs first.
  openGraph: {
    type: "website",
    siteName: "cogno",
    title: "cogno",
    description:
      "Post text, read text. Reading is free. To post, lock 100 ADA on Cardano and take it back whenever you want.",
  },
  // Without an explicit card type X falls back to `summary` (a tiny side thumbnail);
  // `summary_large_image` is the full-width card. Title, description and image inherit from
  // openGraph — this only needs to pick the card style.
  twitter: {
    card: "summary_large_image",
  },
  // Emit <meta name="referrer" content="no-referrer"> as an app-wide default: no request the app makes
  // ever sends a Referer header disclosing which post/profile the viewer is on. The remote <img>s (post
  // images / avatars / banners) already set referrerPolicy="no-referrer" individually and external links
  // use rel="noreferrer"; this is the belt-and-suspenders default so a future remote fetch that forgets
  // the per-element attribute still can't leak. (Referer only — a revealed image's fetch still exposes IP.)
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  // Render edge-to-edge so the bottom-bar / FAB / main safe-area padding (env(safe-area-inset-bottom))
  // actually resolves on home-indicator devices instead of collapsing to 0. Only bottom insets are used,
  // and there is no standalone/PWA manifest, so this can't push content under a top notch in browser mode.
  viewportFit: "cover",
};

// Pre-paint theme boot: read localStorage['cg-theme'] (default 'dark') and set
// document.documentElement.dataset.theme BEFORE first paint, so there is no theme flash. Mirrors
// useTheme()'s storage key + default; kept as a tiny inline string so it runs synchronously in <head>.
//
// It also stamps <meta name="theme-color"> — the colour a mobile browser paints its own chrome (the
// address bar, the status bar) with. That has to happen HERE, from the same variable, and cannot be a
// static `viewport.themeColor`: the theme is chosen in localStorage, not from the OS, so the usual
// `prefers-color-scheme` media form would give a light-mode visitor on a dark OS a black status bar above
// a white page. The meta tag is created rather than looked up so it does not depend on whether Next has
// already emitted its own head tags at this point in the parse.
const THEME_BOOT = `(function(){var t='dark';try{var s=localStorage.getItem('cg-theme');if(s==='light'||s==='dark')t=s;}catch(e){}document.documentElement.dataset.theme=t;var m=document.createElement('meta');m.name='theme-color';m.content=t==='light'?'#ffffff':'#000000';document.head.appendChild(m);})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="dark light" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
