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
  title: "cogno",
  description:
    "Post text, read text. A feeless social chain where posting and voting are metered by Cardano-sourced talk-capacity, not fees.",
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
  openGraph: {
    type: "website",
    siteName: "cogno",
    title: "cogno",
    description: "Post text, read text.",
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
