"use client";

// Account — the LeftNav bottom mini-widget (doc 01 §6.1 item 7). REPLACES the old M8 Account.tsx
// (the lock/exit/stake control surface — that work now lives in /settings).
//
// Connected (postingEnabled): Avatar + DisplayName + Handle (truncated ss58, mono), opening a small
// menu with "View profile" / "Settings" / "Disconnect". Not connected: a ConnectWalletButton that
// derives the posting key (→ /welcome continues the identity bind). Reads everything from useSession();
// it never instantiates a socket and never builds an extrinsic. On tablet (icon-only rail) the parent
// renders this avatar-only via the `compact` flag.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./Account.module.css";
import { Avatar } from "./Avatar";
import { DisplayName } from "./DisplayName";
import { Handle } from "./Handle";
import { ConnectWalletButton } from "./ConnectWalletButton";
import { useSession } from "./Providers";

export interface AccountProps {
  /** Icon-only (tablet collapsed rail) — render just the avatar trigger. */
  compact?: boolean;
}

export function Account({ compact }: AccountProps) {
  const router = useRouter();
  const { viewer, signerCtl } = useSession();
  const me = viewer.address;
  // The avatar chip means "fully set up" (identity-bound). A connected-but-unbound session is NOT
  // done — it falls through to ConnectWalletButton, which shows the "Finish setup" nudge.
  const ready = viewer.status === "ready" && !!me;

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
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
    return (
      <div className={styles.root}>
        <ConnectWalletButton
          viewer={viewer}
          onContinueSetup={() => router.push("/welcome/")}
          size={compact ? "sm" : "md"}
        />
      </div>
    );
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${compact ? styles.compact : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <Avatar address={me} src={viewer.avatar} size="md" name={viewer.displayName} eager />
        {!compact && (
          <span className={styles.who}>
            <DisplayName address={me} displayName={viewer.displayName} truncate />
            <Handle address={me} />
          </span>
        )}
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
