"use client";

// WalletPicker — Step 1 of onboarding (surface 11 §3.1–3.2 / §7.1). Lists installed CIP-30 wallets
// (listCardanoWallets()), each as a labelled WalletRow → useSigner.connectWallet(walletId) which
// derives the sr25519 posting key from one wallet signature (nothing stored). Empty list →
// EmptyState (generic) with install links. ReconnectRow when useSigner.lastWalletId is set. While a
// derive is in flight: the chosen row spins + "Approve the signature…" narration + Cancel.
//
// Errors are mapped to the §14 copy by the page and passed in as `errorCopy` (declined / non-vkey /
// no-signature / not-installed / wrong-network). The wallet sign moves NO funds — one quiet
// reassurance line under the list.

import { useEffect, useRef, useState } from "react";
import styles from "./WalletPicker.module.css";
import { WalletRow } from "./WalletRow";
import { ReconnectRow } from "./ReconnectRow";
import { EmptyState } from "@/components/EmptyState";
import { Spinner } from "@/components/icons";
import { listCardanoWallets, type CardanoWalletInfo } from "@/lib/cardano/cip8";

export interface WalletPickerProps {
  /** a sign-to-derive is in flight (useSigner.deriving). */
  deriving: boolean;
  /** the wallet id a previous session connected with (one-click reconnect). */
  lastWalletId: string | null;
  /** inline error under the list (mapped to §14 copy). null when clear. */
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
  lastWalletId,
  errorCopy,
  onConnect,
  onCancel,
  headingRef,
}: WalletPickerProps) {
  const [wallets, setWallets] = useState<CardanoWalletInfo[] | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const list = await listCardanoWallets();
      if (live) setWallets(list);
    })();
    return () => {
      live = false;
    };
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

  const reconnect = (walletId: string) => {
    setChosenId(walletId);
    void onConnect(walletId);
  };

  const nameFor = (id: string) => wallets?.find((w) => w.id === id)?.name;

  // ── connecting / deriving ──────────────────────────────────────────────────────────────────
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
          Approve the signature request in {chosenName} to create your posting key. This signs a
          message — it never moves any funds.
        </p>
        <button type="button" className={styles.ghost} onClick={onCancel}>
          Cancel
        </button>
      </section>
    );
  }

  // ── idle / list ────────────────────────────────────────────────────────────────────────────
  // A returning visitor (lastWalletId persisted) leads with a prominent one-tap reconnect; the full
  // wallet list drops below a divider as the "use a different wallet" fallback. A first-time visitor
  // gets the plain "Join the conversation" wallet list.
  const returning = !!lastWalletId;
  const hasWallets = wallets !== null && wallets.length > 0;
  return (
    <section className={styles.step} aria-labelledby="welcome-heading">
      <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
        {returning ? "Welcome back" : "Join the conversation"}
      </h1>
      <p className={styles.lede}>
        {returning
          ? "Reconnect to pick up where you left off."
          : "Connect a Cardano wallet to start posting."}
      </p>

      {returning && (
        <ReconnectRow
          variant="primary"
          walletId={lastWalletId}
          name={nameFor(lastWalletId)}
          onReconnect={reconnect}
        />
      )}

      {returning && hasWallets && (
        <div className={styles.divider} role="separator">
          <span className={styles.dividerLabel}>or use a different wallet</span>
        </div>
      )}

      {wallets === null ? (
        <div className={styles.loading} aria-live="polite">
          <Spinner /> <span className={styles.srLabel}>Looking for wallets…</span>
        </div>
      ) : wallets.length === 0 ? (
        <EmptyState
          variant="generic"
          title="No Cardano wallet found."
          description="Install a CIP-30 wallet, then refresh this page."
          action={undefined}
          icon={
            <div className={styles.installLinks}>
              <a href="https://eternl.io/" target="_blank" rel="noreferrer" className={styles.installLink}>
                Install Eternl ↗
              </a>
              <a href="https://www.lace.io/" target="_blank" rel="noreferrer" className={styles.installLink}>
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

      <p className={styles.reassure}>
        By connecting you agree to nothing — your keys stay in your wallet.
      </p>
    </section>
  );
}
