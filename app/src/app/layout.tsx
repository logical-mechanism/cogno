// Root layout — a Server Component (no data fetch). Emits <html>/<head>/<body>, the pre-paint theme
// boot script (no flash), the local-fonts side-effect, then the client <Providers> + <AppShell> chrome
// the whole App Router tree lives inside (doc 01 §4.1). The shell persists across navigations — only
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
  title: "cogno-chain",
  description:
    "Post text, read text. A feeless social chain — posting and voting are metered by Cardano-sourced talk-capacity, not fees.",
  applicationName: "cogno-chain",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: "dark light",
};

// Pre-paint theme boot: read localStorage['cg-theme'] (default 'dark') and set
// document.documentElement.dataset.theme BEFORE first paint, so there is no theme flash. Mirrors
// useTheme()'s storage key + default; kept as a tiny inline string so it runs synchronously in <head>.
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('cg-theme');if(t!=='light'&&t!=='dark')t='dark';document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta name="color-scheme" content="dark light" />
        {/* eslint-disable-next-line react/no-danger */}
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
