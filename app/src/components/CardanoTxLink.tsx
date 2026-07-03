"use client";

// CardanoTxLink — a small "view this submitted L1 tx on Cardanoscan" link. Shown after a vault
// lock/exit submits, so the transaction doesn't just vanish: the user can watch it confirm on-chain
// while the app waits for the observer to grant posting capacity. Shows a truncated tx hash so it
// reads as something concrete even before clicking.

import styles from "./CardanoTxLink.module.css";
import { cardanoscanTxUrl } from "@/lib/cardano/explorer";

export interface CardanoTxLinkProps {
  txHash: string;
  /** override the leading label ("Transaction" by default). */
  label?: string;
}

function truncateHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}

export function CardanoTxLink({ txHash, label = "Transaction" }: CardanoTxLinkProps) {
  return (
    <a
      className={styles.link}
      href={cardanoscanTxUrl(txHash)}
      target="_blank"
      rel="noreferrer"
      aria-label={`View transaction ${txHash} on Cardanoscan`}
    >
      {label} <span className={styles.hash}>{truncateHash(txHash)}</span>
      <span className={styles.arrow} aria-hidden>
        {" ↗"}
      </span>
    </a>
  );
}
