"use client";

// ReconnectRow — the one-click reconnect hint (surface 11 §3.1 / §7.1 / §8). Shown when
// useSigner.lastWalletId is persisted (cogno.wallet.last). Re-derives the same posting key by
// re-signing with the previously-connected wallet. Text/ghost affordance — not a primary CTA.

import styles from "./ReconnectRow.module.css";

export interface ReconnectRowProps {
  walletId: string;
  /** display name for the wallet id (falls back to the id). */
  name?: string;
  disabled?: boolean;
  onReconnect: (walletId: string) => void;
}

export function ReconnectRow({ walletId, name, disabled, onReconnect }: ReconnectRowProps) {
  const label = name || walletId;
  return (
    <button
      type="button"
      className={styles.row}
      disabled={disabled}
      onClick={() => onReconnect(walletId)}
      aria-label={`Reconnect with ${label}`}
    >
      Reconnect <span className={styles.wallet}>{label}</span> →
    </button>
  );
}
