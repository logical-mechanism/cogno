"use client";

// ProgressDots — the 4-step onboarding progress indicator (surface 11 §3, §12). A single
// role="progressbar" with aria-valuenow/aria-valuemax=4; the active dot uses --cg-accent, completed
// dots are filled --cg-text, pending dots --cg-border. Purely presentational — driven by the
// derived `welcomeStep` index.

import styles from "./ProgressDots.module.css";

export interface ProgressDotsProps {
  /** 1-based active step (1..4). */
  step: number;
  /** total dots (4). */
  total?: number;
}

export function ProgressDots({ step, total = 4 }: ProgressDotsProps) {
  const dots = Array.from({ length: total }, (_, i) => i + 1);
  return (
    <div
      className={styles.dots}
      role="progressbar"
      aria-label="Setup progress"
      aria-valuenow={step}
      aria-valuemin={1}
      aria-valuemax={total}
    >
      {dots.map((n) => {
        const state = n === step ? "active" : n < step ? "done" : "pending";
        return <span key={n} className={`${styles.dot} ${styles[state]}`} aria-hidden />;
      })}
    </div>
  );
}
