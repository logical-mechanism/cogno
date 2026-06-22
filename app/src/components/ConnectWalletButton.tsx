"use client";

// ConnectWalletButton — the entry to "Cardano wallet → derive posting key → bind identity" (doc 03
// §20, D7). Label/target derive from `viewer.status`:
//   not-connected      → "Connect wallet" → opens the CIP-30 wallet picker → useSigner.connectWallet
//                        (derives the sr25519 posting key from the CIP-8 signature; nothing stored).
//   not-identity-bound → "Finish setup" → onContinueSetup() (routes to /welcome's bind step).
//   ready              → renders NOTHING (the LeftNav shows the account chip instead).
// The actual bind extrinsic lives in /welcome; this button only initiates/continues. Reading always
// works unauthenticated, so an error never blocks the app — it shows inline + a Retry.

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./ConnectWalletButton.module.css";
import { Spinner } from "./icons";
import { useSigner } from "@/hooks/useSigner";
import { listCardanoWallets } from "@/lib/cardano/cip8";
import type { CardanoWalletInfo } from "@/lib/cardano/cip8";
import type { ControlSize, Viewer } from "./kit";

export interface ConnectWalletButtonProps {
  viewer: Viewer;
  /** Route to /welcome's identity-bind step (used when connected but not yet bound). */
  onContinueSetup?: () => void;
  size?: ControlSize;
}

export function ConnectWalletButton({ viewer, onContinueSetup, size = "md" }: ConnectWalletButtonProps) {
  const { connectWallet, deriving, error } = useSigner();
  const [open, setOpen] = useState(false);
  const [wallets, setWallets] = useState<CardanoWalletInfo[]>([]);
  const [loadingWallets, setLoadingWallets] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the picker on an outside click / Escape.
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

  const openPicker = useCallback(async () => {
    setOpen(true);
    setLoadingWallets(true);
    try {
      setWallets(await listCardanoWallets());
    } finally {
      setLoadingWallets(false);
    }
  }, []);

  const pick = useCallback(
    async (id: string) => {
      const ok = await connectWallet(id);
      if (ok) setOpen(false);
    },
    [connectWallet],
  );

  if (viewer.status === "ready") return null;

  const cls = [styles.btn, size === "sm" ? styles.sm : styles.md].join(" ");

  // Connected but not bound → "Finish setup".
  if (viewer.status === "not-identity-bound") {
    return (
      <button type="button" className={cls} onClick={onContinueSetup}>
        Finish setup
      </button>
    );
  }

  // Not connected → the wallet picker.
  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={cls}
        onClick={open ? () => setOpen(false) : openPicker}
        disabled={deriving}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {deriving ? (
          <>
            <Spinner size="sm" /> Connecting
          </>
        ) : (
          "Connect wallet"
        )}
      </button>

      {open && !deriving && (
        <div className={styles.picker} role="dialog" aria-label="Choose a Cardano wallet">
          <p className={styles.pickerTitle}>Choose a wallet</p>
          {loadingWallets ? (
            <div className={styles.pickerEmpty}>
              <Spinner size="sm" />
            </div>
          ) : wallets.length === 0 ? (
            <p className={styles.pickerEmpty}>No CIP-30 wallet detected. Install one to continue.</p>
          ) : (
            <ul className={styles.list}>
              {wallets.map((w) => (
                <li key={w.id}>
                  <button type="button" className={styles.walletRow} onClick={() => pick(w.id)}>
                    {w.icon && <img className={styles.walletIcon} src={w.icon} alt="" aria-hidden />}
                    <span>{w.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}{" "}
          <button type="button" className={styles.retry} onClick={openPicker}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
