"use client";

// Account — the LeftNav bottom mini-widget (item 7). REPLACES the old M8 Account.tsx
// (the lock/exit/stake control surface — that work now lives in /settings).
//
// Connected (postingEnabled): Avatar + DisplayName + Handle (truncated ss58, mono), opening a small
// menu with "View profile" / "Settings" / "Disconnect". Not connected: a ConnectWalletButton that
// derives the posting key (→ /welcome continues the identity bind). Reads everything from useSession();
// it never instantiates a socket and never builds an extrinsic. On the tablet icon-only rail the
// DisplayName/Handle block collapses away in CSS (Account.module.css @media ≤1019px) — same as the
// rest of the rail.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./Account.module.css";
import { Avatar } from "./Avatar";
import { DisplayName } from "./DisplayName";
import { Handle } from "./Handle";
import { ConnectWalletButton } from "./ConnectWalletButton";
import { useSession } from "./Providers";

export function Account() {
  const router = useRouter();
  const { viewer, signerCtl } = useSession();
  const me = viewer.address;
  // The avatar chip means "fully set up" (identity-bound). A connected-but-unbound session is NOT
  // done — it falls through to ConnectWalletButton, which shows the "Finish setup" nudge.
  const ready = viewer.status === "ready" && !!me;

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Close the menu on outside click / Escape. Escape returns focus to the trigger so a keyboard user
  // who Escapes off a menu item isn't stranded on <body> when the menu unmounts.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const onDisconnect = useCallback(() => {
    setOpen(false);
    signerCtl.disconnect();
  }, [signerCtl]);

  // Not fully set up (not connected, or connected but not identity-bound) → the connect/finish-setup
  // entry. ConnectWalletButton picks "Connect wallet" vs "Finish setup" from viewer.status; the
  // latter routes to /welcome to complete the bind.
  if (!ready) {
    // The "Connect wallet" / "Finish setup" pill is a fixed-width nowrap accent button — it does not fit
    // the 88px icon-only tablet rail (≤1019px), so it is hidden there via `connectRoot`. A tablet guest
    // still reaches sign-in through the prominent accent "Post" circle (and Profile), which funnel to
    // /welcome. Desktop keeps the labeled button; mobile has no LeftNav (Home's sign-in card + the
    // ComposeFab cover it).
    return (
      <div className={`${styles.root} ${styles.connectRoot}`}>
        <ConnectWalletButton
          viewer={viewer}
          onContinueSetup={() => router.push("/welcome/")}
          size="md"
        />
      </div>
    );
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <Avatar address={me} src={viewer.avatar} size="md" name={viewer.displayName} eager noRing />
        <span className={styles.who}>
          <DisplayName address={me} displayName={viewer.displayName} truncate />
          <Handle address={me} />
        </span>
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          <button type="button" role="menuitem" className={styles.menuItem} onClick={() => go(`/u/${me}/`)}>
            View profile
          </button>
          <button type="button" role="menuitem" className={styles.menuItem} onClick={() => go("/settings/")}>
            Settings
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.danger}`}
            onClick={onDisconnect}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
