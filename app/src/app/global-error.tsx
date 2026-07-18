"use client";

// global-error.tsx — the LAST boundary. It catches what error.tsx cannot: a throw inside the root layout
// or inside Providers itself (the PAPI client boot, the wallet connect, the identity read). That is the
// riskiest code in the app, and it sits ABOVE the route boundary, so without this file a failure there
// still replaces the whole application with Next's bare default error page.
//
// It REPLACES RootLayout, which has three consequences that are easy to get wrong:
//
//   1. It must emit its own <html> and <body>. Nothing above it does.
//   2. It renders OUTSIDE Providers, so it CANNOT use useSession / useToaster / useTheme. Everything
//      here is static.
//   3. It therefore loses the root layout's `data-theme` and its pre-paint theme script. This app is
//      dark-first; without that attribute a dark-mode user's error page renders as a white flash. The
//      theme is re-read from the same localStorage key ('cg-theme', default 'dark') the real boot uses
//      — duplicated deliberately, because importing anything is what would throw.
//
// There is no next/link either (it needs the router). The escape is a hard document navigation.
//
// Styles are inline: the CSS-module class names resolve fine, but if the failure is in the chunk graph
// itself, an inline style is the only thing guaranteed to paint.

import { useEffect } from "react";

const THEME_BOOT = `(function(){try{var t=localStorage.getItem('cg-theme');if(t!=='light'&&t!=='dark')t='dark';document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("cogno: fatal error (above the provider tree)", error);
  }, [error]);

  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="dark light" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#000",
          color: "#e7e9ea",
          fontFamily: "system-ui, -apple-system, sans-serif",
          padding: "1.5rem",
        }}
      >
        <main style={{ maxWidth: "28rem", textAlign: "center" }} role="alert">
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, margin: "0 0 0.75rem" }}>
            cogno couldn&apos;t start.
          </h1>
          <p style={{ margin: "0 0 1.25rem", color: "#71767b", lineHeight: 1.5 }}>
            Something failed while connecting to the chain. This is usually a bad node endpoint or a
            dropped connection.
          </p>
          {error.digest && (
            <p style={{ margin: "0 0 1.25rem", fontSize: "0.8125rem", color: "#71767b" }}>
              Reference: {error.digest}
            </p>
          )}
          <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
            {/* reset() re-mounts the tree — enough for a transient throw. A persistent one (dead endpoint)
                just throws again, so Reload is the other real escape. No "Change node" link: there is no
                node switcher anywhere (reconnect(url) has no callers), and /settings is walled — a cold
                boot is always logged-out, so it would just bounce a stuck user onto onboarding. */}
            <button type="button" onClick={reset} style={BTN_PRIMARY}>
              Try again
            </button>
            <button type="button" onClick={() => window.location.reload()} style={BTN_SECONDARY}>
              Reload
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}

const BTN_BASE = {
  padding: "0.625rem 1.25rem",
  borderRadius: "9999px",
  fontSize: "0.9375rem",
  fontWeight: 700,
  cursor: "pointer",
  border: "1px solid #536471",
} as const;

const BTN_PRIMARY = { ...BTN_BASE, background: "#eff3f4", color: "#0f1419", border: "none" } as const;
const BTN_SECONDARY = { ...BTN_BASE, background: "transparent", color: "#e7e9ea" } as const;
