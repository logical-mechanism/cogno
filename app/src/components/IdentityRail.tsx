"use client";

// IdentityRail — the dual-key MENTAL model, made honest for M1.
//
//  • The sr25519 "posting key" chip (--identity-substrate) is REAL and clickable:
//    it opens a switcher (dev accounts + "generate session key"). It shows the
//    short ss58 and the key label, with a key glyph so colour is never the sole signal.
//  • The Cardano "seal" chip (--identity-cardano) is shown EMPTY / disabled with
//    honest copy — identity & stake arrive in M2. We do NOT fake a connected wallet.

import { useEffect, useRef, useState } from "react";
import type { PostingSigner } from "@/lib/types";
import styles from "./IdentityRail.module.css";

function shortSs58(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export interface IdentityRailProps {
  signer: PostingSigner;
  devAccounts: readonly string[];
  onSelectDev: (uri: string) => void;
  onGenerateSession: () => void;
  /** The mnemonic to surface ONCE after generating a session key (null otherwise). */
  sessionMnemonic: string | null;
  onAckSessionMnemonic: () => void;
}

export function IdentityRail({
  signer,
  devAccounts,
  onSelectDev,
  onGenerateSession,
  sessionMnemonic,
  onAckSessionMnemonic,
}: IdentityRailProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Open the switcher whenever a fresh mnemonic needs acknowledging.
  useEffect(() => {
    if (sessionMnemonic) setOpen(true);
  }, [sessionMnemonic]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={styles.rail} ref={ref}>
      {/* Posting key — REAL, interactive. */}
      <button
        type="button"
        className={`${styles.chip} ${styles.keyChip}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Posting key ${shortSs58(signer.ss58)}, ${signer.label}. Click to switch key.`}
        title={signer.ss58}
      >
        <span className={styles.glyph} aria-hidden="true">
          ⚿
        </span>
        <span className={styles.chipLabel}>
          <span className={styles.chipRole}>posting key</span>
          <span className={styles.chipValue}>
            {shortSs58(signer.ss58)} · {signer.label}
          </span>
        </span>
      </button>

      {/* Cardano seal — honestly EMPTY in M1. Not a button: nothing to connect yet. */}
      <span
        className={`${styles.chip} ${styles.sealChip}`}
        aria-disabled="true"
        title="Cardano identity & stake-derived talk-capacity arrive in M2."
      >
        <span className={styles.glyph} aria-hidden="true">
          ◇
        </span>
        <span className={styles.chipLabel}>
          <span className={styles.chipRole}>identity &amp; stake</span>
          <span className={styles.chipValueMuted}>arrives in M2</span>
        </span>
      </span>

      {open && (
        <div className={styles.popover} role="menu" aria-label="Switch posting key">
          <p className={styles.popHead}>posting key</p>

          <ul className={styles.devList}>
            {devAccounts.map((uri) => {
              const active = signer.label.startsWith(uri) || signer.label === uri;
              return (
                <li key={uri}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={`${styles.devItem} ${active ? styles.devActive : ""}`}
                    onClick={() => {
                      onSelectDev(uri);
                      setOpen(false);
                    }}
                  >
                    <span className={styles.devTick} aria-hidden="true">
                      {active ? "•" : ""}
                    </span>
                    {uri} <span className={styles.devTag}>(dev)</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            role="menuitem"
            className={styles.sessionBtn}
            onClick={onGenerateSession}
          >
            generate session key
          </button>

          {sessionMnemonic && (
            <div className={styles.mnemonicBox} role="alert">
              <p className={styles.mnemonicWarn}>
                Back this up now. M1 keeps this key only in memory — refresh and it
                is gone. The hardened keystore arrives in M2.
              </p>
              <code className={styles.mnemonic}>{sessionMnemonic}</code>
              <button
                type="button"
                className={styles.mnemonicAck}
                onClick={onAckSessionMnemonic}
              >
                I&apos;ve saved it
              </button>
            </div>
          )}

          <p className={styles.popNote}>
            Dev keys are the public, well-known Substrate development accounts —
            anyone can sign as them. Use them for trying things, not for anything you
            care about.
          </p>
        </div>
      )}
    </div>
  );
}

export default IdentityRail;
