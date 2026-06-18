"use client";

// TrustNote — the honest posture, stated plainly in the footer. No "trustless" or
// "fully decentralized" claims appear anywhere in this app — only what is true right
// now, and what limits still stand.

import styles from "./TrustNote.module.css";

export function TrustNote() {
  return (
    <footer className={styles.note}>
      <p className={styles.maxim}>
        usable ≠ trustless · signed ≠ included · feeless ≠ unstoppable
      </p>
      <p className={styles.body}>
        The chain is operator-run — a single development node. Reads are open: point
        the app at any node you choose to trust. Posting is <strong>feeless</strong>,
        rate-limited by a regenerating, stake-weighted <strong>talk capacity</strong>.
        The Cardano-anchored <strong>identity</strong> binding and Cardano-<strong>sourced</strong>{" "}
        talk-capacity are live: lock ADA in the vault from your own wallet to earn the
        weight that funds your posts. The operator can still grant weight on this dev
        stack, so what you see is only as honest as the node you point at.
      </p>
    </footer>
  );
}

export default TrustNote;
