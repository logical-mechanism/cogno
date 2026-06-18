"use client";

// Masthead — the calm head of the reading room. A wordmark, one honest tagline, and a quiet
// "about" link (which holds the trust posture + advanced config). The wallet/account lives in the
// Account widget below, not here.

import styles from "./Masthead.module.css";

export interface MastheadProps {
  onOpenAbout: () => void;
}

export function Masthead({ onOpenAbout }: MastheadProps) {
  return (
    <header className={styles.masthead}>
      <div className={styles.brandRow}>
        <div className={styles.brand}>
          <span className={styles.wordmark}>cogno-chain</span>
          <span className={styles.tagline}>post text · read text — feeless, wallet-powered</span>
        </div>
        <button type="button" className={styles.about} onClick={onOpenAbout} aria-label="About and settings">
          about
        </button>
      </div>
    </header>
  );
}

export default Masthead;
