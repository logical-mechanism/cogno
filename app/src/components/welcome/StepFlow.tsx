"use client";

// StepFlow — a compact vertical step indicator for a multi-phase background action (register / lock
// ADA / bind voting power). The active step spins, completed steps get a check, pending steps are
// dimmed. Onboarding actions run several async steps (wallet sign, then a slow on-chain submit that
// resolves on finalization); this makes that wait visibly advance instead of reading as "stuck".

import styles from "./StepFlow.module.css";
import { Spinner, IconCheck } from "@/components/icons";

export interface StepFlowStep {
  key: string;
  label: string;
}

export interface StepFlowProps {
  steps: StepFlowStep[];
  /** index of the active (in-progress) step; earlier steps render done, later steps pending. */
  active: number;
  /** accessible name for the list. */
  ariaLabel?: string;
}

export function StepFlow({ steps, active, ariaLabel }: StepFlowProps) {
  return (
    <ol className={styles.steps} aria-label={ariaLabel}>
      {steps.map((s, i) => {
        const state = i < active ? "done" : i === active ? "active" : "pending";
        return (
          <li key={s.key} className={`${styles.stepRow} ${styles[state]}`}>
            <span className={styles.stepMark} aria-hidden>
              {state === "done" ? (
                <IconCheck size="var(--cg-icon-sm)" />
              ) : state === "active" ? (
                <Spinner size="sm" />
              ) : (
                <span className={styles.stepDot} />
              )}
            </span>
            <span className={styles.stepLabel}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
