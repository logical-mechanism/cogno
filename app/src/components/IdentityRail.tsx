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
import type { UseIdentity } from "@/hooks/useIdentity";
import { listCardanoWallets, type CardanoWalletInfo } from "@/lib/cardano/cip8";
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
  /** The Cardano-identity bind state + action (M2). */
  identity: UseIdentity;
}

export function IdentityRail({
  signer,
  devAccounts,
  onSelectDev,
  onGenerateSession,
  sessionMnemonic,
  onAckSessionMnemonic,
  identity,
}: IdentityRailProps) {
  const [open, setOpen] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [wallets, setWallets] = useState<CardanoWalletInfo[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close the bind picker once a bind succeeds.
  useEffect(() => {
    if (identity.bound === true) setBindOpen(false);
  }, [identity.bound]);

  const openBindPicker = () => {
    setBindOpen((o) => !o);
    if (wallets == null) void listCardanoWallets().then(setWallets);
  };

  // Open the switcher whenever a fresh mnemonic needs acknowledging.
  useEffect(() => {
    if (sessionMnemonic) setOpen(true);
  }, [sessionMnemonic]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open && !bindOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setBindOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setBindOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, bindOpen]);

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

      {/* Cardano seal — LIVE in M2: bind a Cardano identity (CIP-8) to this posting key. */}
      {identity.bound === true ? (
        <span
          className={`${styles.chip} ${styles.sealChip} ${styles.sealBound}`}
          title={identity.boundAddress ?? "This posting key is bound to a Cardano identity."}
        >
          <span className={styles.glyph} aria-hidden="true">
            ◆
          </span>
          <span className={styles.chipLabel}>
            <span className={styles.chipRole}>identity</span>
            <span className={styles.chipValue}>
              {identity.boundAddress ? `bound · ${shortSs58(identity.boundAddress)}` : "bound ✓"}
            </span>
          </span>
        </span>
      ) : (
        <button
          type="button"
          className={`${styles.chip} ${styles.sealChip}`}
          onClick={openBindPicker}
          disabled={identity.binding}
          aria-expanded={bindOpen}
          aria-haspopup="menu"
          title="Bind a Cardano identity to this posting key (signs CIP-8 once)."
        >
          <span className={styles.glyph} aria-hidden="true">
            ◇
          </span>
          <span className={styles.chipLabel}>
            <span className={styles.chipRole}>identity</span>
            <span className={styles.chipValueMuted}>
              {identity.binding ? "binding…" : "bind Cardano →"}
            </span>
          </span>
        </button>
      )}

      {bindOpen && identity.bound !== true && (
        <div className={styles.bindPop} role="menu" aria-label="Bind a Cardano identity">
          <p className={styles.popHead}>bind a Cardano identity</p>
          <p className={styles.bindNote}>
            Prove you control a Cardano wallet by signing once (CIP-8). It binds that identity
            1:1 to your posting key — nothing moves, no funds are spent.
          </p>
          {wallets == null ? (
            <p className={styles.bindMuted}>looking for wallets…</p>
          ) : wallets.length === 0 ? (
            <p className={styles.bindMuted}>
              No Cardano wallet found. Install Eternl, Lace, or another CIP-30 wallet, then reload.
            </p>
          ) : (
            <ul className={styles.devList}>
              {wallets.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.devItem}
                    disabled={identity.binding}
                    onClick={() => identity.bind(w.id)}
                  >
                    {w.icon && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={w.icon} alt="" width={16} height={16} className={styles.walletIcon} />
                    )}
                    {w.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {identity.binding && (
            <p className={styles.bindMuted}>
              waiting on: your wallet signature → the follower&apos;s verify → the chain readback.
            </p>
          )}
          {identity.error && (
            <p className={styles.bindError} role="alert">
              {identity.error}
            </p>
          )}
          <p className={styles.popNote}>
            The follower that verifies your signature is a single trusted service in v1
            (<code>follower: trusted (v1)</code>) — it could, in principle, bind the wrong key; the
            readback above is your check that it did not.
          </p>
        </div>
      )}

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
