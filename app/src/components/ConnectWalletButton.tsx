"use client";

// ConnectWalletButton — the entry to "Cardano wallet → derive posting key → bind identity" (doc 03
// §20, D7). Label/target derive from `viewer.status`:
//   not-connected      → "Connect wallet" → opens the CIP-30 wallet picker → useSigner.connectWallet
//                        (derives the sr25519 posting key from the CIP-8 signature; nothing stored).
//   not-identity-bound → "Finish setup" → onContinueSetup() (routes to /welcome's bind step).
//   ready              → renders NOTHING (the LeftNav shows the account chip instead).
// The actual bind extrinsic lives in /welcome; this button only initiates/continues. Reading always
// works unauthenticated, so a decline never blocks the app — it surfaces as a toast and the user
// can just tap Connect again (no inline Retry).

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./ConnectWalletButton.module.css";
import { Spinner } from "./icons";
import { Loading } from "./Loading";
import { useSession } from "./Providers";
import { useToaster } from "./toast/ToasterProvider";
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
  // Use the SHARED session signer (Providers), NOT a fresh useSigner() — a second instance would
  // derive into isolated state the rest of the app never sees ("connect does nothing").
  const { signerCtl } = useSession();
  const { connectWallet, deriving } = signerCtl;
  const { toast } = useToaster();
  const [open, setOpen] = useState(false);
  const [wallets, setWallets] = useState<CardanoWalletInfo[]>([]);
  const [loadingWallets, setLoadingWallets] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close the picker on an outside click / Escape. Escape returns focus to the trigger so a keyboard
  // user isn't stranded on <body> when the role="dialog" popover unmounts.
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

  // Move focus into the picker once it opens and its wallet rows have rendered, so the announced
  // dialog actually receives focus (a11y: role="dialog" should not leave focus on the trigger behind it).
  useEffect(() => {
    if (open && !deriving && !loadingWallets) {
      pickerRef.current?.querySelector<HTMLElement>("button, [tabindex]")?.focus();
    }
  }, [open, deriving, loadingWallets]);

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
      // Close the picker either way — a decline isn't an error wall; the toast tells the user they
      // can just tap Connect again (no inline Retry).
      setOpen(false);
      toast(
        ok
          ? { kind: "success", message: "Wallet connected" }
          : { kind: "info", message: "Connection cancelled. Tap Connect to try again." },
      );
    },
    [connectWallet, toast],
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
        ref={triggerRef}
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
        <div ref={pickerRef} className={styles.picker} role="dialog" aria-label="Choose a Cardano wallet">
          <p className={styles.pickerTitle}>Choose a wallet</p>
          {loadingWallets ? (
            <Loading variant="panel" label="Looking for wallets…" />
          ) : wallets.length === 0 ? (
            <p className={styles.pickerEmpty}>No CIP-30 wallet detected. Install one to continue.</p>
          ) : (
            <ul className={styles.list}>
              {wallets.map((w) => (
                <li key={w.id}>
                  <button type="button" className={styles.walletRow} onClick={() => pick(w.id)}>
                    {w.icon && (
                      // Wallet-supplied data-URI icon; a sandboxed <img> is correct here, not next/image.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className={styles.walletIcon} src={w.icon} alt="" aria-hidden />
                    )}
                    <span>{w.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

    </div>
  );
}
