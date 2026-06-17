"use client";

// TrustNote — the honest posture, stated plainly in the footer. No "trustless" or
// "fully decentralized" claims appear anywhere in this app — only what is true right
// now, and what is explicitly deferred to later milestones.

import styles from "./TrustNote.module.css";

export function TrustNote() {
  return (
    <footer className={styles.note}>
      <p className={styles.maxim}>
        usable ≠ trustless · signed ≠ included · feeless ≠ unstoppable
      </p>
      <p className={styles.body}>
        The chain is operator-run — a single development node. Reads are open: point
        the app at any node you choose to trust. Posting is now <strong>feeless</strong>,
        rate-limited by a regenerating, stake-weighted <strong>talk capacity</strong> —
        but in this dev showcase that weight is set by the operator (sudo), not yet by
        Cardano-staked ADA. The Cardano-anchored <strong>identity</strong> binding arrives
        in M2 and Cardano-<strong>sourced</strong> weight in M2d; until then, what you see
        is exactly what the operator granted — no more.
      </p>
    </footer>
  );
}

export default TrustNote;
