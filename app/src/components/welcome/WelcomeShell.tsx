"use client";

// WelcomeShell — the centered onboarding chrome (surface 11 §3 / §16). A single narrow column
// (--cg-col-onboarding, 480px) vertically centered on --cg-bg with the cogno wordmark at the top
// (links '/'), the ProgressDots row, and the active step content in the slot. The flow owns the
// canvas; this shell is the auth-card frame the stepper renders into. Wordmark is text-colored
// (var(--cg-text)) — neutral, no colored accent.

import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./WelcomeShell.module.css";
import { ProgressDots } from "./ProgressDots";
import { Loading } from "@/components/Loading";

export interface WelcomeShellProps {
  /** 1-based active step for the progress dots (1..4). Ignored while `loading`. */
  step?: number;
  /** Neutral "deciding" state: just the wordmark + a spinner, no stepper — shown while we resolve
   *  whether a reconnecting key is already onboarded, so no wrong step flashes before we route. */
  loading?: boolean;
  children?: ReactNode;
}

export function WelcomeShell({ step = 1, loading = false, children }: WelcomeShellProps) {
  return (
    <div className={styles.root}>
      <div className={styles.column}>
        <Link href="/" className={styles.wordmark} aria-label="cogno-chain home">
          <span className={styles.wordmarkText}>cogno</span>
        </Link>

        {loading ? (
          <Loading variant="fit" label="Signing you in…" />
        ) : (
          <>
            <ProgressDots step={step} total={4} />
            <div className={styles.slot}>{children}</div>
          </>
        )}
      </div>
    </div>
  );
}
