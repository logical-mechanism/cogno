"use client";

// WalletRow — one tappable Cardano wallet in the picker. A labelled
// <button aria-label="Connect with <name>"> with the wallet icon + name + a trailing chevron. When
// this is the row a sign-to-derive is in flight on, it shows an inline Spinner + "Waiting for
// signature…" and sets aria-busy. ≥44px tall (mobile hit target).

import styles from "./WalletRow.module.css";
import { Spinner } from "@/components/icons";

export interface WalletRowProps {
  walletId: string;
  name: string;
  icon?: string;
  /** a sign-to-derive is in flight on THIS row. */
  loading?: boolean;
  /** all rows are disabled (a derive is in flight, possibly on another row). */
  disabled?: boolean;
  onSelect: (walletId: string) => void;
}

function ChevronRight() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden focusable="false">
      <path d="M9.005 5.5l6.5 6.5-6.5 6.5-1.41-1.42L12.675 12 7.595 6.92 9.005 5.5z" />
    </svg>
  );
}

export function WalletRow({ walletId, name, icon, loading, disabled, onSelect }: WalletRowProps) {
  return (
    <button
      type="button"
      className={styles.row}
      aria-label={`Connect with ${name}`}
      aria-busy={loading || undefined}
      disabled={disabled}
      onClick={() => onSelect(walletId)}
    >
      <span className={styles.icon}>
        {icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.iconImg} src={icon} alt="" aria-hidden />
        ) : (
          <span className={styles.iconFallback}>{name.slice(0, 1).toUpperCase()}</span>
        )}
      </span>
      <span className={styles.name}>{name}</span>
      {loading ? (
        <span className={styles.trailing}>
          <Spinner size="sm" /> <span className={styles.waiting}>Waiting for signature…</span>
        </span>
      ) : (
        <span className={styles.chevron} aria-hidden>
          <ChevronRight />
        </span>
      )}
    </button>
  );
}
