"use client";

// IdentityRail — the dual-key model, made honest.
//
//  • The sr25519 "posting key" chip (--identity-substrate) is REAL and clickable. Its popover is a
//    small key manager: create / import / unlock a durable encrypted keystore key (M8), generate a
//    throwaway session key, or fall back to the public dev accounts (behind a toggle).
//  • The Cardano "identity" chip (--identity-cardano) binds a Cardano wallet to this posting key
//    via a single CIP-8 signature (M2). Locking ADA to earn capacity lives in the StakePanel.

import { useEffect, useRef, useState } from "react";
import type { UseIdentity } from "@/hooks/useIdentity";
import type { UseSigner } from "@/hooks/useSigner";
import { listCardanoWallets, type CardanoWalletInfo } from "@/lib/cardano/cip8";
import styles from "./IdentityRail.module.css";

function shortSs58(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

type KeyMode = null | "create" | "import" | "unlock";

export interface IdentityRailProps {
  /** The full posting-key controller (active signer + dev/session/keystore actions). */
  signerCtl: UseSigner;
  /** The Cardano-identity bind state + action (M2). */
  identity: UseIdentity;
}

export function IdentityRail({ signerCtl, identity }: IdentityRailProps) {
  const sc = signerCtl;
  const signer = sc.signer;

  const [open, setOpen] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [wallets, setWallets] = useState<CardanoWalletInfo[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Key-manager local state.
  const [mode, setMode] = useState<KeyMode>(null);
  const [pw, setPw] = useState("");
  const [phrase, setPhrase] = useState("");
  const [createdMnemonic, setCreatedMnemonic] = useState<string | null>(null);
  const [showDev, setShowDev] = useState(false);
  const [working, setWorking] = useState(false);

  // Close the bind picker once a bind succeeds.
  useEffect(() => {
    if (identity.bound === true) setBindOpen(false);
  }, [identity.bound]);

  const openBindPicker = () => {
    setBindOpen((o) => !o);
    if (wallets == null) void listCardanoWallets().then(setWallets);
  };

  // Open the switcher whenever a fresh session mnemonic needs acknowledging.
  useEffect(() => {
    if (sc.sessionMnemonic) setOpen(true);
  }, [sc.sessionMnemonic]);

  // Reset the key-manager forms whenever the popover closes.
  useEffect(() => {
    if (!open) {
      setMode(null);
      setPw("");
      setPhrase("");
      setWorking(false);
    }
  }, [open]);

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

  const doCreate = async () => {
    setWorking(true);
    const m = await sc.createKeystore(pw);
    setWorking(false);
    if (m) {
      setCreatedMnemonic(m);
      setMode(null);
      setPw("");
    }
  };
  const doImport = async () => {
    setWorking(true);
    const ok = await sc.importKeystore(phrase, pw);
    setWorking(false);
    if (ok) {
      setMode(null);
      setPw("");
      setPhrase("");
    }
  };
  const doUnlock = async () => {
    setWorking(true);
    const ok = await sc.unlockKeystore(pw);
    setWorking(false);
    if (ok) {
      setPw("");
      setOpen(false);
    }
  };
  const confirmForget = () => {
    if (typeof window !== "undefined" && window.confirm("Forget this keystore? The encrypted key is erased from this device. Make sure you have its recovery phrase.")) {
      sc.forgetKeystore();
    }
  };

  return (
    <div className={styles.rail} ref={ref}>
      {/* Posting key — REAL, interactive. */}
      <button
        type="button"
        className={`${styles.chip} ${styles.keyChip}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Posting key ${shortSs58(signer.ss58)}, ${signer.label}. Click to manage keys.`}
        title={signer.ss58}
      >
        <span className={styles.glyph} aria-hidden="true">
          {sc.keystoreUnlocked ? "🔓" : "⚿"}
        </span>
        <span className={styles.chipLabel}>
          <span className={styles.chipRole}>posting key</span>
          <span className={styles.chipValue}>
            {shortSs58(signer.ss58)} · {signer.label}
          </span>
        </span>
      </button>

      {/* Cardano identity — bind a Cardano wallet (CIP-8) to this posting key (M2). */}
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
        <div className={styles.popover} role="menu" aria-label="Manage posting key">
          <p className={styles.popHead}>posting key</p>

          {/* ── The durable, encrypted keystore key (M8) ── */}
          <div className={styles.keySection}>
            {sc.keystoreUnlocked ? (
              <>
                <p className={styles.keyStatus}>🔓 unlocked — your saved key is active.</p>
                <div className={styles.keyRow}>
                  <button type="button" className={styles.sessionBtn} onClick={sc.lockKeystore}>
                    lock
                  </button>
                  <button type="button" className={styles.dangerBtn} onClick={confirmForget}>
                    forget…
                  </button>
                </div>
              </>
            ) : sc.hasKeystore ? (
              <>
                <p className={styles.keyStatus}>🔒 a saved key is locked on this device.</p>
                <input
                  className={styles.pwInput}
                  type="password"
                  placeholder="password"
                  autoComplete="current-password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && pw && !working) void doUnlock();
                  }}
                />
                <div className={styles.keyRow}>
                  <button type="button" className={styles.primaryBtn} disabled={!pw || working} onClick={doUnlock}>
                    {working ? "unlocking…" : "unlock"}
                  </button>
                  <button type="button" className={styles.dangerBtn} onClick={confirmForget}>
                    forget…
                  </button>
                </div>
              </>
            ) : mode === "create" ? (
              <>
                <p className={styles.keyStatus}>Set a password to encrypt a new posting key on this device.</p>
                <input
                  className={styles.pwInput}
                  type="password"
                  placeholder="password (min 6 chars)"
                  autoComplete="new-password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                />
                <div className={styles.keyRow}>
                  <button type="button" className={styles.primaryBtn} disabled={pw.length < 6 || working} onClick={doCreate}>
                    {working ? "creating…" : "create"}
                  </button>
                  <button type="button" className={styles.sessionBtn} onClick={() => { setMode(null); setPw(""); }}>
                    cancel
                  </button>
                </div>
              </>
            ) : mode === "import" ? (
              <>
                <p className={styles.keyStatus}>Paste a recovery phrase and a password to encrypt it on this device.</p>
                <textarea
                  className={styles.importArea}
                  placeholder="your recovery phrase"
                  spellCheck={false}
                  rows={2}
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                />
                <input
                  className={styles.pwInput}
                  type="password"
                  placeholder="password (min 6 chars)"
                  autoComplete="new-password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                />
                <div className={styles.keyRow}>
                  <button type="button" className={styles.primaryBtn} disabled={!phrase.trim() || pw.length < 6 || working} onClick={doImport}>
                    {working ? "importing…" : "import"}
                  </button>
                  <button type="button" className={styles.sessionBtn} onClick={() => { setMode(null); setPw(""); setPhrase(""); }}>
                    cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className={styles.keyStatus}>A durable posting key, encrypted on this device with a password.</p>
                <div className={styles.keyRow}>
                  <button type="button" className={styles.primaryBtn} onClick={() => setMode("create")}>
                    create a key
                  </button>
                  <button type="button" className={styles.sessionBtn} onClick={() => setMode("import")}>
                    import a phrase
                  </button>
                </div>
              </>
            )}

            {sc.keystoreError && (
              <p className={styles.bindError} role="alert">
                {sc.keystoreError}
              </p>
            )}
          </div>

          {createdMnemonic && (
            <div className={styles.mnemonicBox} role="alert">
              <p className={styles.mnemonicWarn}>
                Back this up now — it is the ONLY way to recover this key. We store only an
                encrypted copy and can never recover it for you.
              </p>
              <code className={styles.mnemonic}>{createdMnemonic}</code>
              <button type="button" className={styles.mnemonicAck} onClick={() => setCreatedMnemonic(null)}>
                I&apos;ve saved it
              </button>
            </div>
          )}

          {/* ── Throwaway session key ── */}
          <button type="button" role="menuitem" className={styles.sessionBtn} onClick={sc.useSessionKey}>
            generate a temporary key (memory only)
          </button>

          {sc.sessionMnemonic && (
            <div className={styles.mnemonicBox} role="alert">
              <p className={styles.mnemonicWarn}>
                This temporary key lives only in memory — refresh and it is gone. Back up the phrase
                or save it to the keystore above to keep it.
              </p>
              <code className={styles.mnemonic}>{sc.sessionMnemonic}</code>
              <button type="button" className={styles.mnemonicAck} onClick={sc.ackSessionMnemonic}>
                I&apos;ve saved it
              </button>
            </div>
          )}

          {/* ── Public dev accounts, behind a toggle ── */}
          <button
            type="button"
            className={styles.devToggle}
            onClick={() => setShowDev((s) => !s)}
            aria-expanded={showDev}
          >
            {showDev ? "hide" : "show"} dev accounts
          </button>
          {showDev && (
            <ul className={styles.devList}>
              {sc.devAccounts.map((uri) => {
                const active = signer.kind === "dev" && (signer.label.startsWith(uri) || signer.label === uri);
                return (
                  <li key={uri}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className={`${styles.devItem} ${active ? styles.devActive : ""}`}
                      onClick={() => {
                        sc.setDevAccount(uri);
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
          )}

          <p className={styles.popNote}>
            Dev keys are the public, well-known Substrate development accounts — anyone can sign as
            them. A keystore key is yours: encrypted at rest, but (like any browser key) readable by
            script on this page once unlocked. Treat it as a convenience key, not cold storage.
          </p>
        </div>
      )}
    </div>
  );
}

export default IdentityRail;
