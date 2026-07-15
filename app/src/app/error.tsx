"use client";

// error.tsx — the route-level error boundary. There was NO boundary of any kind in this app: a single
// render-time throw anywhere under AppShell replaced the entire application with Next's built-in default
// error page ("Application error: a client-side exception has occurred") — bare, unstyled, no nav, and
// recoverable only by a manual reload.
//
// This one substitutes for {children} INSIDE Providers + AppShell (see layout.tsx), so the nav, the
// theme and the session all survive: only the failed route body is replaced, and the user can click away
// to another page. Throws originating in Providers ITSELF (the PAPI client / wallet / identity boot —
// the highest-risk code in the app) are above this boundary and are caught by global-error.tsx instead.
//
// NOTE the retry does NOT call router.refresh(). Under `output: 'export'` that does literally nothing —
// this repo has already shipped that exact bug once (the Retry buttons on the thread + profile read
// errors). `reset()` re-renders the failed subtree, which fixes a transient throw; when the cause is
// persistent (a dead endpoint, a descriptor mismatch) re-rendering just throws again, so there is a hard
// reload as the escape hatch rather than a button that silently loops.

import { useEffect } from "react";
import styles from "./error.module.css";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The boundary is the only place this throw is observable — surface it rather than swallowing it.
    console.error("cogno: unhandled render error", error);
  }, [error]);

  return (
    <div className={styles.wrap} role="alert">
      <h1 className={styles.title}>Something broke on this page.</h1>
      <p className={styles.detail}>
        The rest of the app is still running. You can navigate away, or try this page again.
      </p>
      {error.digest && <p className={styles.digest}>Reference: {error.digest}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={reset}>
          Try again
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => window.location.reload()}
        >
          Reload the app
        </button>
      </div>
    </div>
  );
}
