"use client";

// ReconnectRow — the one-click reconnect affordance (surface 11 §3.1 / §7.1 / §8). Shown when
// useSigner.lastWalletId is persisted (cogno.wallet.last). Re-derives the same posting key by
// re-signing with the previously-connected wallet. Two variants: "text" is the quiet ghost hint
// (secondary), "primary" is the accent pill the returning-visitor landing leads with.

import styles from "./ReconnectRow.module.css";

export interface ReconnectRowProps {
  walletId: string;
  /** display name for the wallet id (falls back to the id). */
  name?: string;
  disabled?: boolean;
  /** "text" (quiet ghost hint) or "primary" (accent pill CTA). Default "text". */
  variant?: "text" | "primary";
  onReconnect: (walletId: string) => void;
}

export function ReconnectRow({
  walletId,
  name,
  disabled,
  variant = "text",
  onReconnect,
}: ReconnectRowProps) {
  const label = name || walletId;
  const className = variant === "primary" ? styles.primary : styles.row;
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() => onReconnect(walletId)}
      aria-label={`Reconnect with ${label}`}
    >
      Reconnect <span className={styles.wallet}>{label}</span> →
    </button>
  );
}
