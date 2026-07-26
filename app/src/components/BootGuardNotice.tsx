"use client";

// BootGuardNotice — the one place a not-ok boot guard is visible BEFORE the user tries to write.
//
// The hole this closes. `checkBootGuard` has always blocked posting on a spec mismatch, and
// `useMutation` has always short-circuited the write. But the block was invisible until the moment of
// the click: `boot.reason` reached a human only as a 6-second error toast raised AFTER pressing Post.
// AppShell read no boot state at all, so the composer rendered a fully live Post button, the user wrote
// a post, pressed it, and got a toast about version numbers. Nothing was signed or submitted (the
// short-circuit is client-side and the tx Observable is never subscribed), so nothing was lost except
// the writing and the trust.
//
// That is an edge case on a chain that upgrades once a year and a routine event on one heading for
// mainnet: a runtime upgrade puts EVERY open tab into this state simultaneously, and each of them keeps
// looking completely functional. This says so up front, on every surface, and offers the fix.
//
// Reloading is a real fix, not a shrug. deploy/nginx/cogno.conf serves the HTML and the RSC payloads
// with `Cache-Control: no-cache` (only the content-hashed /_next/static/ chunks are immutable), so a
// reload revalidates and picks up the newly deployed bundle. That is why the button exists for
// "stale-app" and not for "wrong-chain", where the endpoint is the problem and reloading would just
// reproduce it.
//
// Reads are deliberately NOT blocked. Every one of these states leaves the feed readable, and taking
// the app down to a full-screen error over a write-path incompatibility would be a much worse trade.

import { useCallback } from "react";
import Link from "next/link";
import styles from "./BootGuardNotice.module.css";
import { useSession } from "./Providers";

/** Copy per not-ok state. `reason` is not reused here: it is written for a toast, this is a banner. */
const COPY: Record<
  "stale-app" | "wrong-chain" | "unreachable",
  { title: string; body: string; reload: boolean }
> = {
  // "different versions", not "cogno was updated": a spec mismatch is USUALLY a runtime upgrade under
  // an open tab, and is also what you get pointing this app at a node on an older runtime. Naming the
  // likelier cause as the certain one would be wrong for the reader it is wrong for, and reloading
  // does not help them. "Usually fixes it" is the honest strength of that advice.
  "stale-app": {
    title: "This page and the network do not match",
    body: "They are running different versions, so posting is off until they agree. You can still read. Reloading usually fixes it.",
    reload: true,
  },
  "wrong-chain": {
    title: "This is not a cogno network",
    body: "The address this app is connected to is running something else. Posting is off. Check the connection in Settings.",
    reload: false,
  },
  unreachable: {
    title: "Can't reach cogno",
    body: "The network did not answer, so posting is off. It may be a connection problem at either end.",
    reload: true,
  },
};

export function BootGuardNotice() {
  const { boot } = useSession();

  // `location.reload()` rather than router.refresh(): under `output: 'export'` there is no server to
  // refresh from, and a router.refresh() here would be the third instance of the do-nothing Retry
  // button the smoke test exists to catch. A stale BUNDLE can only be replaced by a document load.
  const onReload = useCallback(() => window.location.reload(), []);

  // `boot` is null while the probe is in flight. Rendering a warning there would flash on every cold
  // load, so silence is correct until there is an answer.
  if (!boot || boot.ok) return null;
  const copy = COPY[boot.kind === "ok" ? "unreachable" : boot.kind];

  return (
    // `role="status"` + polite: this appears without the user asking, so it must not interrupt whatever
    // a screen reader is already saying. It is not an error the user just caused.
    <div className={styles.notice} role="status" aria-live="polite">
      <div className={styles.text}>
        <p className={styles.title}>{copy.title}</p>
        <p className={styles.body}>{copy.body}</p>
      </div>
      {copy.reload ? (
        <button type="button" className={styles.action} onClick={onReload}>
          Reload
        </button>
      ) : (
        <Link href="/settings/" className={styles.action}>
          Settings
        </Link>
      )}
    </div>
  );
}
