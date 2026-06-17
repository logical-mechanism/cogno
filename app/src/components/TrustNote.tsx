"use client";

// TrustNote — the M1 honest posture, stated plainly in the footer. No "trustless"
// or "fully decentralized" claims appear anywhere in this app — only what is true
// right now, and what is explicitly deferred to later milestones.

import styles from "./TrustNote.module.css";

export function TrustNote() {
  return (
    <footer className={styles.note}>
      <p className={styles.maxim}>
        usable ≠ trustless · signed ≠ included · feeless ≠ unstoppable
      </p>
      <p className={styles.body}>
        The chain is operator-run — a single development node. Reads are open: point
        the app at any node you choose to trust. Cardano-anchored identity and
        stake-derived talk-capacity are not here yet; they arrive in M2 (identity)
        and M2c (capacity). Until then, any funded dev key can post, and what you see
        is exactly that — no more.
      </p>
    </footer>
  );
}

export default TrustNote;
