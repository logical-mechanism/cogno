"use client";

// WalletPicker — Step 1 of onboarding (3.2 /). Lists installed CIP-30 wallets
// (listCardanoWallets()), each as a labelled WalletRow → useSigner.connectWallet(walletId) which
// derives the sr25519 posting key from one wallet signature (nothing stored). Empty list →
// EmptyState (generic) with install links. While a derive is in flight: the chosen row spins +
// "Approve the signature…" narration + Cancel.
//
// Returning users just re-pick their wallet from the same list — clicking it re-derives the identical
// key — so there is no separate "reconnect" affordance; the list IS the reconnect.
//
// Errors are mapped to the copy by the page and passed in as `errorCopy` (declined / non-vkey /
// no-signature / not-installed / wrong-network). The wallet sign moves NO funds — one quiet
// reassurance line under the list.

import { useEffect, useRef, useState } from "react";
import styles from "./WalletPicker.module.css";
import { WalletRow } from "./WalletRow";
import { EmptyState } from "@/components/EmptyState";
import { Spinner } from "@/components/icons";
import { Loading } from "@/components/Loading";
import { listCardanoWallets, type CardanoWalletInfo } from "@/lib/cardano/cip8";

export interface WalletPickerProps {
  /** a sign-to-derive is in flight (useSigner.deriving). */
  deriving: boolean;
  /** inline error under the list (mapped to copy). null when clear. */
  errorCopy: string | null;
  /** connect + derive — resolves true on success. */
  onConnect: (walletId: string) => Promise<boolean> | void;
  /** Cancel the in-flight signature (dismiss the spinner, back to the list). */
  onCancel: () => void;
  /** the step heading ref, so the page can move focus on transition. */
  headingRef?: React.Ref<HTMLHeadingElement>;
}

export function WalletPicker({
  deriving,
  errorCopy,
  onConnect,
  onCancel,
  headingRef,
}: WalletPickerProps) {
  const [wallets, setWallets] = useState<CardanoWalletInfo[] | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);

  useEffect(() => {
    // Enumerate installed CIP-30 wallets from window.cardano (a synchronous read — no MeshJS import, so
    // the ~5.9 MB Cardano bundle stays deferred until the user actually connects). Some extensions inject
    // window.cardano a tick after load, so if the first read is empty, re-check a few times over ~1.5 s
    // before settling on the "no wallet found" empty-state (the null state keeps the loader up meanwhile).
    const first = listCardanoWallets();
    if (first.length > 0) {
      setWallets(first);
      return;
    }
    let tries = 0;
    const id = setInterval(() => {
      tries += 1;
      const list = listCardanoWallets();
      if (list.length > 0 || tries >= 6) {
        setWallets(list);
        clearInterval(id);
      }
    }, 250);
    return () => clearInterval(id);
  }, []);

  // Esc cancels the in-flight signature (returns to the list).
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    if (!deriving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [deriving]);

  const select = (walletId: string) => {
    setChosenId(walletId);
    void onConnect(walletId);
  };

  // ── connecting / deriving ──────────────────────────────────────────────────────────────────────
  if (deriving) {
    const chosen = wallets?.find((w) => w.id === chosenId);
    const chosenName = chosen?.name ?? chosenId ?? "your wallet";
    return (
      <section className={styles.step} aria-labelledby="welcome-heading">
        <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
          Check your wallet
        </h1>
        <div className={styles.list}>
          {chosen ? (
            <WalletRow
              walletId={chosen.id}
              name={chosen.name}
              icon={chosen.icon}
              loading
              disabled
              onSelect={() => {}}
            />
          ) : (
            <div className={styles.derivingRow} aria-busy>
              <Spinner size="sm" /> Waiting for signature…
            </div>
          )}
        </div>
        <p className={styles.narration} aria-live="polite">
          Approve the signature in {chosenName} to create your posting key.
        </p>
        <button type="button" className={styles.ghost} onClick={onCancel}>
          Cancel
        </button>
      </section>
    );
  }

  // ── idle / list ────────────────────────────────────────────────────────────────────────────────
  return (
    <section className={styles.step} aria-labelledby="welcome-heading">
      <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
        Join the conversation
      </h1>
      <p className={styles.lede}>Connect a Cardano wallet to start posting.</p>

      {wallets === null ? (
        <Loading variant="panel" label="Looking for wallets…" />
      ) : wallets.length === 0 ? (
        <EmptyState
          variant="generic"
          title="No Cardano wallet found"
          description="Install a Cardano wallet, then refresh."
          action={undefined}
          icon={
            <div className={styles.installLinks}>
              <a href="https://eternl.io/" target="_blank" rel="noopener noreferrer nofollow" className={styles.installLink}>
                Install Eternl ↗
              </a>
              <a href="https://www.lace.io/" target="_blank" rel="noopener noreferrer nofollow" className={styles.installLink}>
                Install Lace ↗
              </a>
            </div>
          }
        />
      ) : (
        <div className={styles.list}>
          {wallets.map((w) => (
            <WalletRow key={w.id} walletId={w.id} name={w.name} icon={w.icon} onSelect={select} />
          ))}
        </div>
      )}

      {errorCopy && (
        <p className={styles.error} role="alert">
          {errorCopy}
        </p>
      )}
    </section>
  );
}
